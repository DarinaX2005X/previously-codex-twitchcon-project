import { afterEach,describe,it,expect,vi } from 'vitest';
import type { PlaybackRef } from '../../src/shared/contracts/index.js';
import { OverlayController,SceneClock,type OverlayClient,type OverlayState,type OverlayView } from '../../src/features/overlay/controller.js';
import type { PreparedMedia } from '../../src/features/overlay/media.js';
import { planFixture } from './fixture.js';

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const baseline=Date.parse('2026-11-02T10:00:00Z');
function setup(){
  let mono=0;let hooks:Parameters<OverlayClient['subscribe']>[0];let view:OverlayView|undefined;
  const state:OverlayState={sessionId:'session:fixture',privacyEpoch:0,revision:2,serverNow:new Date(baseline).toISOString(),active:{id:'playback:1',status:'preparing',plan:planFixture(),startAt:null},queued:[]};
  const release=vi.fn(),media:PreparedMedia={visuals:new Map(),narrator:null,release};
  const client:OverlayClient={getState:vi.fn(async()=>({...state,serverNow:new Date(baseline+mono).toISOString(),active:state.active?{...state.active}:null})),acknowledge:vi.fn(async(_id,status)=>{if(status==='prepared')state.active!.startAt=new Date(baseline+mono+300).toISOString();if(status==='started')state.active!.status='playing';}),subscribe:handlers=>{hooks=handlers;return vi.fn();},mediaUrl:id=>`/api/media/${id}`};
  const controller=new OverlayController({client,prepare:vi.fn(async()=>media),onChange:value=>{view=value;},now:()=>mono});
  return {controller,client,state,release,media,advance:(ms:number)=>{mono=ms;controller.tick();},get view(){return view!;},get hooks(){return hooks!;}};
}
afterEach(()=>{vi.useRealTimers();});
describe('lease, synchronization and private revocation',()=>{
  it('uses monotonic time after anchoring server time',()=>{const clock=new SceneClock();clock.anchor(new Date(baseline).toISOString(),30);expect(clock.elapsed(new Date(baseline+300).toISOString(),630)).toBe(300);expect(clock.serverNow(20)).toBe(baseline);});
  it('does not rewind scene time when a slower poll returns an older server anchor',()=>{const clock=new SceneClock();clock.anchor(new Date(baseline).toISOString(),0);clock.anchor(new Date(baseline+800).toISOString(),1000);expect(clock.elapsed(new Date(baseline).toISOString(),1100)).toBe(1100);});
  it('prepares once, waits for server start and acknowledges start only once',async()=>{
    const s=setup();s.controller.start();await flush();expect(s.view.status).toBe('preparing');s.advance(299);expect(s.view.playing).toBe(false);s.advance(301);await flush();expect(s.view.playing).toBe(true);expect(s.view.timeMs).toBe(1);s.advance(400);await s.controller.refresh();expect(vi.mocked(s.client.acknowledge).mock.calls.filter(c=>c[1]==='prepared')).toHaveLength(1);expect(vi.mocked(s.client.acknowledge).mock.calls.filter(c=>c[1]==='started')).toHaveLength(1);s.controller.stop();
  });
  it('privacy notification clears the frame and releases media before revalidation',async()=>{
    const s=setup();s.controller.start();await flush();s.advance(400);s.state.active=null;s.hooks.onUpdate({event:'privacy.invalidated',data:{affectedIds:['chapter:1']}});expect(s.view.playback).toBeNull();expect(s.view.media).toBeNull();expect(s.release).toHaveBeenCalledOnce();await flush();expect(s.view.playing).toBe(false);s.controller.stop();
  });
  it('fails closed at the six-second lease even if no network promise settles',async()=>{
    const s=setup();s.controller.start();await flush();s.advance(400);vi.mocked(s.client.getState).mockImplementation(()=>new Promise(()=>{}));s.hooks.onDisconnect();s.advance(5999);expect(s.view.playing).toBe(true);s.advance(6000);expect(s.view.playback).toBeNull();expect(s.view.status).toBe('disconnected');expect(s.release).toHaveBeenCalledOnce();s.controller.stop();
  });
  it('heartbeat extends lease but cannot restart an invalidated playback',async()=>{
    const s=setup();s.controller.start();await flush();s.advance(400);s.controller.invalidate();s.hooks.onHeartbeat();await s.controller.refresh();expect(s.view.playback).toBeNull();s.controller.stop();
  });
  it('skips a missed start older than three seconds',async()=>{
    const s=setup();s.state.active!.status='playing';s.state.active!.startAt=new Date(baseline-3100).toISOString();s.controller.start();await flush();expect(s.view.playback).toBeNull();expect(vi.mocked(s.client.acknowledge).mock.calls.some(c=>c[1]==='error')).toBe(true);s.controller.stop();
  });
  it('does not resurrect a preparation that resolves after revocation',async()=>{
    const s=setup();let resolve!:(media:PreparedMedia)=>void;let current:OverlayView|undefined;const controller=new OverlayController({client:s.client,prepare:()=>new Promise(r=>{resolve=r;}),onChange:v=>{current=v;},now:()=>0});controller.start();await flush();controller.invalidate();resolve(s.media);await flush();expect(s.release).toHaveBeenCalledOnce();expect(current?.playback).toBeNull();expect(vi.mocked(s.client.acknowledge).mock.calls).toHaveLength(0);controller.stop();
  });
  it('ends exactly once and will not replay the completed ID on reconnect',async()=>{
    const s=setup();s.controller.start();await flush();s.advance(400);s.hooks.onHeartbeat();s.advance(5000);s.hooks.onHeartbeat();s.advance(10000);s.hooks.onHeartbeat();s.advance(12300);await flush();expect(s.view.playback).toBeNull();expect(s.release).toHaveBeenCalledOnce();await s.controller.refresh();expect(s.view.playback).toBeNull();expect(vi.mocked(s.client.acknowledge).mock.calls.filter(c=>c[1]==='ended')).toHaveLength(1);s.controller.stop();
  });
});
