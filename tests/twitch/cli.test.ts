import {describe,it,expect} from 'vitest';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {TwitchEventSub} from '../../src/server/twitch/eventsub.js';
import {TwitchHelix} from '../../src/server/twitch/helix.js';
import type {EventEnvelope} from '../../src/shared/contracts/index.js';
import {memoryControl} from '../auth/helpers.js';
const exec=promisify(execFile);
const wait=async(test:()=>boolean,ms=10000)=>{const end=Date.now()+ms;while(!test()){if(Date.now()>end)throw new Error('CLI transport test timed out');await new Promise(resolve=>setTimeout(resolve,30));}};
const freePort=async(requested=0)=>{const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(requested,'127.0.0.1',resolve);});const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;};
describe.skipIf(!process.env.TWITCH_CLI_PATH)('official Twitch CLI isolated WebSocket transport',()=>{
  it('delivers real CLI raid/ban/unban/update/stream payloads and transfers subscriptions on reconnect',async()=>{
    const executable=process.env.TWITCH_CLI_PATH!;await freePort(44747);const port=await freePort();const received:EventEnvelope[]=[];let subscriptions=0;
    const child=spawn(executable,['event','websocket','start-server','--ip=127.0.0.1',`--port=${port}`,'--require-subscription'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    const helix=new TwitchHelix('123',{authorizedFetch:async(url,init)=>{
      if(url.includes('/eventsub/subscriptions')){subscriptions++;
        // CLI 1.1.24 predates the four channel.chat.* event types. Those contracts use separate fixture tests.
        if(JSON.parse(String(init?.body)).type.startsWith('channel.chat.'))return Response.json({data:[]},{status:202});
        const response=await fetch(`http://127.0.0.1:${port}/eventsub/subscriptions`,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),'Client-Id':'cli-test',Authorization:'Bearer mock'}});if(!response.ok)output+=` subscription ${response.status}: ${await response.clone().text()}`;return response;}
      if(url.includes('/streams?'))return Response.json({data:[]});
      if(url.includes('/moderation/banned?'))return Response.json({data:[],pagination:{}});
      throw new Error('Unexpected network request in CLI test');
    }});
    const service=new TwitchEventSub({channelId:'123',runId:'cli-isolated',mock:true,url:`ws://127.0.0.1:${port}/ws`,helix,control:memoryControl(),ingest:event=>{received.push(event);},resolveSession:()=>({id:'cli-session',startedAt:new Date(Date.now()-60000).toISOString()}),onStream:()=>{},bans:{begin:()=>{},page:()=>{},finish:()=>{}}});
    try{
      await wait(()=>output.includes('Listening')||output.includes('listening')||output.includes('WebSocket server'),5000);
      await service.start();await wait(()=>service.status().state==='active');
      for(const type of ['channel.raid','channel.ban','channel.unban','channel.update','stream.online','stream.offline']){
        await exec(executable,['event','trigger',type,'--transport=websocket','--from-user=456','--to-user=123','--no-config',...(type==='channel.update'?['--version=2']:[])],{windowsHide:true,timeout:10000});
      }
      await wait(()=>received.length>=6);expect(received.map(item=>item.kind)).toEqual(expect.arrayContaining(['channel.raid','channel.ban','channel.unban','channel.update','stream.online','stream.offline']));expect(received.every(item=>item.origin==='mock'&&item.runId==='cli-isolated')).toBe(true);expect(subscriptions).toBe(10);
      await exec(executable,['event','websocket','reconnect'],{windowsHide:true,timeout:10000});await wait(()=>output.includes('Reconnect notices sent'));await wait(()=>service.status().state==='active');
      await exec(executable,['event','trigger','channel.raid','--transport=websocket','--from-user=456','--to-user=123','--no-config'],{windowsHide:true,timeout:10000});await wait(()=>received.filter(event=>event.kind==='channel.raid').length===2);expect(subscriptions).toBe(10);
    }catch(error){throw new Error(`${String(error)}; status=${JSON.stringify(service.status())}; CLI=${output.slice(-6000)}`);}finally{await service.stop();child.kill();await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});}
  },30000);
});
