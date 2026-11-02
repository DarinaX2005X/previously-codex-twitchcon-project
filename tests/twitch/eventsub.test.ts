import {EventEmitter} from 'node:events';
import {describe,it,expect,vi,afterEach} from 'vitest';
import type WebSocket from 'ws';
import {TwitchEventSub,subscriptions} from '../../src/server/twitch/eventsub.js';
import type {TwitchHelix} from '../../src/server/twitch/helix.js';
import {memoryControl} from '../auth/helpers.js';
class Socket extends EventEmitter {closed=false;close(){this.closed=true;this.emit('close');}terminate(){this.close();}sendMessage(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)));}}
const at='2026-11-02T00:00:00.000Z';
const welcome=(id:string)=>({metadata:{message_id:`welcome-${id}`,message_type:'session_welcome',message_timestamp:at},payload:{session:{id,keepalive_timeout_seconds:10}}});
const event=(id:string,type:string,raw:Record<string,unknown>)=>({metadata:{message_id:id,message_type:'notification',message_timestamp:at},payload:{subscription:{type,version:type==='channel.update'?'2':'1'},event:{broadcaster_user_id:'123',...raw}}});
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
describe('EventSub transport',()=>{
  afterEach(()=>vi.useRealTimers());
  it('dedupes before callbacks, routes privacy and preserves graceful subscriptions',async()=>{
    const sockets:Socket[]=[];const urls:string[]=[];const ingest=vi.fn();const onStream=vi.fn();const subscribe=vi.fn(async()=>({}));
    const service=new TwitchEventSub({channelId:'123',runId:'live',mock:true,now:()=>Date.parse(at),helix:{subscribe,bannedUsers:async(page:(users:unknown[])=>void)=>page([]),currentStream:async()=>null} as unknown as TwitchHelix,control:memoryControl(),ingest,onStream,resolveSession:()=>({id:'episode',startedAt:at}),bans:{begin:vi.fn(),page:vi.fn(),finish:vi.fn()},socketFactory:url=>{urls.push(url);const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;}});
    await service.start();sockets[0].sendMessage(welcome('old'));await flush();expect(subscribe).toHaveBeenCalledTimes(10);expect(service.status().quotesReady).toBe(true);
    const raid=event('raid','channel.raid',{to_broadcaster_user_id:'123',from_broadcaster_user_id:'456',viewers:4});sockets[0].sendMessage(raid);sockets[0].sendMessage(raid);sockets[0].sendMessage(event('delete','channel.chat.message_delete',{message_id:'message'}));await flush();expect(ingest).toHaveBeenCalledTimes(2);
    sockets[0].sendMessage({metadata:{message_id:'move',message_type:'session_reconnect',message_timestamp:at},payload:{session:{reconnect_url:'ws://127.0.0.1:45591/exact?nonce=abc'}}});
    expect(urls[1]).toBe('ws://127.0.0.1:45591/exact?nonce=abc');expect(sockets[0].closed).toBe(false);sockets[1].sendMessage(welcome('new'));await flush();expect(sockets[0].closed).toBe(true);expect(subscribe).toHaveBeenCalledTimes(10);await service.stop();
  });
  it('hard reconnect repeats bans/subscriptions and keepalive gap is explicit',async()=>{
    vi.useFakeTimers();const sockets:Socket[]=[];const subscribe=vi.fn(async()=>({}));const begin=vi.fn();const service=new TwitchEventSub({channelId:'123',runId:'live',mock:true,helix:{subscribe,bannedUsers:async()=>{},currentStream:async()=>null} as unknown as TwitchHelix,control:memoryControl(),ingest:vi.fn(),onStream:vi.fn(),resolveSession:()=>null,bans:{begin,page:vi.fn(),finish:vi.fn()},socketFactory:()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;}});
    await service.start();sockets[0].sendMessage(welcome('one'));await flush();await vi.advanceTimersByTimeAsync(11000);expect(service.status().quotesReady).toBe(false);expect(service.status().gapSince).not.toBeNull();await vi.advanceTimersByTimeAsync(1000);sockets[1].sendMessage(welcome('two'));await flush();expect(subscribe).toHaveBeenCalledTimes(20);expect(begin).toHaveBeenCalledTimes(2);await service.stop();
  });
  it('uses documented condition versions and guards stale offline/new live',async()=>{
    expect(subscriptions('123').find(s=>s.type==='channel.update')?.version).toBe('2');expect(subscriptions('123').find(s=>s.type==='channel.raid')?.condition).toEqual({to_broadcaster_user_id:'123'});
    const socket=new Socket();const onStream=vi.fn();const ingest=vi.fn();const service=new TwitchEventSub({channelId:'123',runId:'live',mock:true,helix:{subscribe:async()=>{},bannedUsers:async()=>{},currentStream:async()=>({id:'new',started_at:at})} as unknown as TwitchHelix,control:memoryControl(),ingest,onStream,resolveSession:()=>null,bans:{begin:()=>{},page:()=>{},finish:()=>{}},socketFactory:()=>socket as unknown as WebSocket});
    await service.start();socket.sendMessage(welcome('live'));await flush();socket.sendMessage(event('offline','stream.offline',{}));await flush();expect(onStream.mock.calls.every(call=>call[0]!==null)).toBe(true);expect(ingest).not.toHaveBeenCalled();await service.stop();
  });
  it('revocation stops automatic reconnect and shutdown prevents future timers',async()=>{
    vi.useFakeTimers();const socket=new Socket();const make=vi.fn(()=>socket as unknown as WebSocket);const service=new TwitchEventSub({channelId:'123',runId:'live',mock:true,helix:{subscribe:async()=>{},bannedUsers:async()=>{},currentStream:async()=>null} as unknown as TwitchHelix,control:memoryControl(),ingest:vi.fn(),onStream:vi.fn(),resolveSession:()=>null,bans:{begin:()=>{},page:()=>{},finish:()=>{}},socketFactory:make});
    await service.start();socket.sendMessage(welcome('first'));await flush();socket.sendMessage({metadata:{message_id:'revoked',message_type:'revocation',message_timestamp:at},payload:{subscription:{type:'channel.chat.message',version:'1',status:'authorization_revoked'}}});expect(service.status().state).toBe('revoked');expect(service.status().quotesReady).toBe(false);await vi.advanceTimersByTimeAsync(60000);expect(make).toHaveBeenCalledTimes(1);await service.stop();await vi.advanceTimersByTimeAsync(60000);expect(make).toHaveBeenCalledTimes(1);
  });
});

describe('EventSub reconnect backlog and gap bounds (review B3, B4)',()=>{
  afterEach(()=>vi.useRealTimers());
  const chat=(id:string)=>event(id,'channel.chat.message',{chatter_user_id:'7',message_id:id,message:{text:`hi ${id}`}});
  it('keeps chat retained across a gap until the new session finishes ban sync, then ingests it as quotable',async()=>{
    vi.useFakeTimers();const sockets:Socket[]=[];let bansCalls=0,releaseBans!:()=>void,blockIngest:Promise<void>|null=null,unblock!:()=>void;const ingested:{id:string;quotesReady:unknown}[]=[];
    const service=new TwitchEventSub({channelId:'123',runId:'live',mock:true,now:()=>Date.parse(at),control:memoryControl(),onStream:vi.fn(),resolveSession:()=>({id:'episode',startedAt:at}),bans:{begin:vi.fn(),page:vi.fn(),finish:vi.fn()},
      helix:{subscribe:async()=>({}),bannedUsers:async(page:(users:unknown[])=>Promise<void>)=>{if(++bansCalls===2)await new Promise<void>(resolve=>{releaseBans=resolve;});await page([]);},currentStream:async()=>null} as unknown as TwitchHelix,
      ingest:async envelope=>{if(blockIngest)await blockIngest;ingested.push({id:envelope.externalId!,quotesReady:(envelope.payload as {quotesReady:unknown}).quotesReady});},
      socketFactory:()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;}});
    try{
      await service.start();sockets[0].sendMessage(welcome('first'));await flush();
      blockIngest=new Promise<void>(resolve=>{unblock=resolve;});sockets[0].sendMessage(chat('m1'));sockets[0].sendMessage(chat('m2'));await flush();
      sockets[0].emit('close');blockIngest=null;unblock();await flush();expect(service.diagnostics().queuedOrdinary).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);sockets[1].sendMessage(welcome('second'));await flush();expect(service.status()).toMatchObject({state:'subscribing',quotesReady:false});
      sockets[1].sendMessage(chat('m3'));await flush();expect(ingested.map(item=>item.id)).toEqual(['m1']);
      releaseBans();await flush();
      expect(ingested).toEqual([{id:'m1',quotesReady:true},{id:'m2',quotesReady:true},{id:'m3',quotesReady:true}]);
    }finally{await service.stop();}
  });
  it('does not let new frames during ban sync overflow a retained backlog into a reconnect loop',async()=>{
    vi.useFakeTimers();const sockets:Socket[]=[];let bansCalls=0,releaseBans!:()=>void,unblock!:()=>void;const blockFirst=new Promise<void>(resolve=>{unblock=resolve;});let received=0;
    const service=new TwitchEventSub({channelId:'123',runId:'live',mock:true,now:()=>Date.parse(at),control:memoryControl(),onStream:vi.fn(),resolveSession:()=>({id:'episode',startedAt:at}),bans:{begin:vi.fn(),page:vi.fn(),finish:vi.fn()},
      helix:{subscribe:async()=>({}),bannedUsers:async(page:(users:unknown[])=>Promise<void>)=>{if(++bansCalls===2)await new Promise<void>(resolve=>{releaseBans=resolve;});await page([]);},currentStream:async()=>null} as unknown as TwitchHelix,
      ingest:async()=>{if(++received===1)await blockFirst;},
      socketFactory:()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;}});
    try{
      await service.start();sockets[0].sendMessage(welcome('first'));await flush();
      for(let i=0;i<101;i++)sockets[0].sendMessage(chat(`burst-${i}`));expect(service.status().state).toBe('gap');unblock();await flush();expect(service.diagnostics().queuedOrdinary).toBe(100);
      await vi.advanceTimersByTimeAsync(1000);sockets[1].sendMessage(welcome('second'));await flush();
      for(let i=0;i<60;i++)sockets[1].sendMessage(chat(`during-sync-${i}`));expect(service.status().state).toBe('subscribing');
      releaseBans();for(let i=0;i<200&&received<160;i++)await flush();expect(service.status().state).toBe('active');expect(received).toBe(160);expect(service.diagnostics().queuedOrdinary).toBe(0);
    }finally{await service.stop();}
  });
  it('starts each outage gap at that outage, not at the first one',async()=>{
    vi.useFakeTimers();let now=Date.parse(at);const sockets:Socket[]=[];const gaps:(string|null)[]=[];
    const service=new TwitchEventSub({channelId:'123',runId:'live',mock:true,now:()=>now,control:memoryControl(),ingest:vi.fn(),onStream:vi.fn(),resolveSession:()=>null,bans:{begin:vi.fn(),page:vi.fn(),finish:vi.fn()},
      helix:{subscribe:async()=>({}),bannedUsers:async()=>{},currentStream:async()=>null} as unknown as TwitchHelix,status:(state,detail)=>{if(state==='gap')gaps.push(detail.gapSince);},
      socketFactory:()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;}});
    try{
      await service.start();sockets[0].sendMessage(welcome('one'));await flush();
      sockets[0].emit('close');await vi.advanceTimersByTimeAsync(1000);now+=1000;sockets[1].sendMessage(welcome('two'));await flush();expect(service.status()).toMatchObject({state:'active',gapSince:null});
      now+=3_600_000;sockets[1].emit('close');
      expect(gaps).toEqual([at,new Date(Date.parse(at)+3_601_000).toISOString()]);
    }finally{await service.stop();}
  });
});
