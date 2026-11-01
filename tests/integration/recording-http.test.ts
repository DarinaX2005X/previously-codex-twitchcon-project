import {afterEach,describe,it,expect,vi} from 'vitest';
import express from 'express';
import {createServer,request as httpRequest} from 'node:http';
import {createApp} from '../../src/server/app.js';
import {loadConfig} from '../../src/server/runtime/config.js';
import {csrfToken,type Principal} from '../../src/server/runtime/security.js';

const secret='s'.repeat(32),owner:Principal={role:'owner',actorId:'owner',channelId:'channel',runId:'live',sessionId:'authored-browser',expiresAtMs:10000};
const servers:ReturnType<typeof createServer>[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});

describe('recording approval HTTP body boundary',()=>{
  it('accepts large authenticated review receipts only, checks auth before reading, and preserves both size limits',async()=>{
    const review=vi.fn(),other=vi.fn(),router=express.Router(),config=loadConfig({SESSION_SECRET:secret});
    router.post('/recordings/:id/review',(req,res)=>{review(req.params.id,req.body,res.locals.principal);res.json({received:req.body.reviewedSources.length});});
    router.post('/settings',(req,res)=>{other(req.body);res.json({accepted:true});});
    const app=createApp({config,status:{phase:'ready',storage:'ready',mode:'local'},now:()=>1000,auth:{authenticate:req=>req.headers['x-authored-owner']==='yes'?owner:null},routers:{owner:router}});
    const server=createServer(app);servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw new Error('Authored HTTP server did not start');
    const send=(path:string,options:{body?:unknown;authenticated?:boolean;csrf?:boolean;headersOnly?:boolean}={})=>new Promise<{status:number;body:any}>((resolve,reject)=>{
      const body=options.body===undefined?'':JSON.stringify(options.body);
      const request=httpRequest({hostname:'127.0.0.1',port:address.port,path:'/api/owner'+path,method:'POST',headers:{Host:'localhost:4317',Origin:config.origin,Connection:'close','Content-Type':'application/json','Content-Length':String(options.headersOnly?5*1024*1024:Buffer.byteLength(body)),'Idempotency-Key':'authored-review-receipt',...(options.authenticated===false?{}:{'X-Authored-Owner':'yes'}),...(options.csrf===false?{}:{'X-CSRF-Token':csrfToken(secret,owner.sessionId)})}},response=>{
        const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.on('end',()=>{resolve({status:response.statusCode??500,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});request.destroy();});
      });
      request.on('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('Authorization waited for an unsubmitted body')));
      // Missing authorization must produce a response from headers alone, before any body bytes are sent.
      if(options.headersOnly)request.flushHeaders();else request.end(body);
    });
    const receipt={captureRevision:1,digest:'b'.repeat(64),reviewedSources:Array.from({length:1000},(_,i)=>({id:`source-${i}`,revision:1,textHash:'a'.repeat(64)})),reviewedOutputHashes:['c'.repeat(64)],metadataReviewed:true};
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeGreaterThan(64*1024);expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(4*1024*1024);
    expect(await send('/recordings/recording-1/review',{body:receipt})).toEqual({status:200,body:{received:1000}});expect(review).toHaveBeenCalledExactlyOnceWith('recording-1',receipt,owner);
    expect(await send('/recordings/recording-1/review',{authenticated:false,headersOnly:true})).toMatchObject({status:401,body:{error:{code:'session_required'}}});
    expect(await send('/recordings/recording-1/review',{csrf:false,headersOnly:true})).toMatchObject({status:403,body:{error:{code:'csrf_rejected'}}});
    expect(await send('/recordings/recording-1/review',{body:{padding:'x'.repeat(4*1024*1024)}})).toMatchObject({status:413,body:{error:{code:'body_too_large'}}});
    expect(await send('/settings',{body:receipt})).toMatchObject({status:413,body:{error:{code:'body_too_large'}}});
    expect(review).toHaveBeenCalledOnce();expect(other).not.toHaveBeenCalled();
  });
});
