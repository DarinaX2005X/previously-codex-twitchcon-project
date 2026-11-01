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
    await service.start();socket.sendMessage(event('offline','stream.offline',{}));await flush();expect(onStream.mock.calls.every(call=>call[0]!==null)).toBe(true);expect(ingest).not.toHaveBeenCalled();await service.stop();
  });
  it('revocation stops automatic reconnect and shutdown prevents future timers',async()=>{
    vi.useFakeTimers();const socket=new Socket();const make=vi.fn(()=>socket as unknown as WebSocket);const service=new TwitchEventSub({channelId:'123',runId:'live',mock:true,helix:{subscribe:async()=>{},bannedUsers:async()=>{},currentStream:async()=>null} as unknown as TwitchHelix,control:memoryControl(),ingest:vi.fn(),onStream:vi.fn(),resolveSession:()=>null,bans:{begin:()=>{},page:()=>{},finish:()=>{}},socketFactory:make});
    await service.start();socket.sendMessage(welcome('first'));await flush();socket.sendMessage({metadata:{message_id:'revoked',message_type:'revocation',message_timestamp:at},payload:{subscription:{type:'channel.chat.message',version:'1',status:'authorization_revoked'}}});expect(service.status().state).toBe('revoked');expect(service.status().quotesReady).toBe(false);await vi.advanceTimersByTimeAsync(60000);expect(make).toHaveBeenCalledTimes(1);await service.stop();await vi.advanceTimersByTimeAsync(60000);expect(make).toHaveBeenCalledTimes(1);
  });
});
