import {describe,it,expect,vi,beforeAll,afterAll} from 'vitest';
import {createFoxlightBundle,FOXLIGHT_RAID_MILESTONE_MS} from '../../fixtures/foxlight.js';
import {ReplayDriver} from '../../src/replay/driver.js';
import type {ReplayView} from '../../src/replay/client.js';

const titles=(d:{state:ReplayDriver['state']}|ReplayView['snapshot'])=>('state' in d?d.state.published:d.published)?.chapters.map(c=>c.title)??[];

describe('seeking to a recorded time',()=>{
  it('executes every recorded event up to atMs, exactly like advancing the clock',()=>{
    const seeked=new ReplayDriver(createFoxlightBundle(),'seek-a'),advanced=new ReplayDriver(createFoxlightBundle(),'seek-b');
    seeked.control({action:'seek',atMs:250_000.7});advanced.advanceTo(250_000);
    expect(seeked.atMs).toBe(250_000);expect(seeked.error).toBeNull();
    expect(seeked.normalizedHash()).toBe(advanced.normalizedHash());
    expect(titles(seeked)).toEqual(['Fox learns to jump','The moon jump']);
  });
  it('clamps to the recording, rejects a time that is not a number and keeps milestone seeks',()=>{
    const d=new ReplayDriver(createFoxlightBundle(),'seek-bounds');
    expect(d.seekTarget({action:'seek',atMs:-5})).toBe(0);
    expect(d.seekTarget({action:'seek',atMs:10_000_000})).toBe(d.durationMs);
    expect(d.seekTarget({action:'seek',milestone:'raid',atMs:1000})).toBe(FOXLIGHT_RAID_MILESTONE_MS);
    expect(d.seekTarget({action:'seek'})).toBeNull();
    expect(()=>d.control({action:'seek',atMs:Number.NaN})).toThrow('Choose a time inside the recording.');
    d.control({action:'seek',milestone:'raid'});expect(d.atMs).toBe(FOXLIGHT_RAID_MILESTONE_MS);
    d.control({action:'seek',atMs:1000});expect(d.atMs).toBe(FOXLIGHT_RAID_MILESTONE_MS); // A driver never runs backwards.
  });
});

describe('worker seek',()=>{
  const messages:{id?:number;result?:unknown;error?:{message:string};view?:ReplayView|null}[]=[];
  let call:(method:string,...args:unknown[])=>{result?:unknown;error?:{message:string};view?:ReplayView|null};
  beforeAll(async()=>{
    vi.useFakeTimers();
    const scope=globalThis as unknown as {self:unknown;postMessage:(value:unknown)=>void};
    scope.self=globalThis;scope.postMessage=value=>{messages.push(value as typeof messages[number]);};
    vi.resetModules();await import('../../src/replay/worker.js');
    let serial=0;
    call=(method,...args)=>{const id=++serial;(globalThis as unknown as {onmessage:(m:{data:unknown})=>void}).onmessage({data:{id,method,args}});return messages.findLast(m=>m.id===id)!;};
    call('init',createFoxlightBundle());
  });
  afterAll(()=>{vi.useRealTimers();});
  it('moves forward and back to any time and matches a fresh run to that time',()=>{
    let reply=call('controlReplay',{action:'seek',atMs:300_000});
    expect(reply.error).toBeUndefined();expect(reply.view?.transport.atMs).toBe(300_000);
    expect(titles(reply.view!.snapshot)).toEqual(['Fox learns to jump','The moon jump','Spring gets a speed limit']);
    call('controlReplay',{action:'play',speed:4});
    reply=call('controlReplay',{action:'seek',atMs:120_000});
    expect(reply.view?.transport).toMatchObject({atMs:120_000,playing:true,speed:4,error:null});
    const fresh=new ReplayDriver(createFoxlightBundle(),'fresh-to-120');fresh.advanceTo(120_000);
    expect(titles(reply.view!.snapshot)).toEqual(titles(fresh));
    expect(reply.view!.snapshot.moments.map(m=>[m.startMs,m.count])).toEqual(fresh.snapshot().moments.map(m=>[m.startMs,m.count]));
    reply=call('controlReplay',{action:'seek',milestone:'raid'});
    expect(reply.view?.transport.atMs).toBe(FOXLIGHT_RAID_MILESTONE_MS);
    expect(titles(reply.view!.snapshot)).toHaveLength(4);
    expect(call('controlReplay',{action:'seek',atMs:'soon'}).error?.message).toBe('Choose a time inside the recording.');
  });
});
