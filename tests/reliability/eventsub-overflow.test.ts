import {EventEmitter} from 'node:events';
import {describe,it,expect,vi} from 'vitest';
import type WebSocket from 'ws';
import {TwitchEventSub} from '../../src/server/twitch/eventsub.js';
import type {TwitchHelix} from '../../src/server/twitch/helix.js';
import {memoryControl} from '../auth/helpers.js';
class Socket extends EventEmitter {close(){this.emit('close');}terminate(){this.close();}emitWire(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)));}}
const at='2026-11-02T00:00:00.000Z';
const flush=async()=>{for(let i=0;i<1200;i++)await Promise.resolve();};
const wire=(id:string,type='channel.chat.message')=>({metadata:{message_id:id,message_type:'notification',message_timestamp:at},payload:{subscription:{type,version:'1'},event:{broadcaster_user_id:'123',chatter_user_id:'actor',message_id:id,message:{text:'synthetic'}}}});
describe('EventSub burst privacy boundary',()=>{
  it('delivers an already received deletion even when normal chat has saturated the intake queue',async()=>{
    const socket=new Socket();let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
    const received:string[]=[];const ingest=vi.fn(async(event:{kind:string;externalId:string})=>{received.push(event.kind);if(event.externalId==='first')await blocked;});
    const service=new TwitchEventSub({channelId:'123',runId:'live',mock:true,now:()=>Date.parse(at),helix:{subscribe:async()=>{},bannedUsers:async()=>{},currentStream:async()=>null} as unknown as TwitchHelix,control:memoryControl(),ingest,onStream:()=>{},resolveSession:()=>({id:'episode',startedAt:at}),bans:{begin:()=>{},page:()=>{},finish:()=>{}},socketFactory:()=>socket as unknown as WebSocket});
    try{await service.start();socket.emitWire({metadata:{message_id:'welcome',message_type:'session_welcome',message_timestamp:at},payload:{session:{id:'connection',keepalive_timeout_seconds:10}}});await flush();
      socket.emitWire(wire('first'));await flush();for(let i=0;i<99;i++)socket.emitWire(wire(`queued-${i}`));
      socket.emitWire(wire('private-message','channel.chat.message_delete'));release();await flush();
      expect(received).toContain('channel.chat.message_delete');
    }finally{release();await service.stop();}
  });
});
