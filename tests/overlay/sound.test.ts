import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {SceneSound} from '../../src/features/overlay/sound.js';
class Param {value=0;setValueAtTime=vi.fn();linearRampToValueAtTime=vi.fn();exponentialRampToValueAtTime=vi.fn();}
class Node {connect=vi.fn();disconnect=vi.fn();}
class Source extends Node {frequency=new Param();type='sine';onended:(()=>void)|null=null;buffer:unknown;start=vi.fn();stop=vi.fn();}
class Context {
  static all:Context[]=[];state='suspended';currentTime=0;sampleRate=48000;sources:Source[]=[];gains:{gain:Param}[]=[];buffers:Float32Array[]=[];
  constructor(){Context.all.push(this);}
  resume=vi.fn(async()=>{this.state='running';});close=vi.fn(async()=>{this.state='closed';});
  createOscillator(){const source=new Source();this.sources.push(source);return source;}
  createBufferSource(){return this.createOscillator();}
  createGain(){const gain=Object.assign(new Node(),{gain:new Param()});this.gains.push(gain);return gain;}
  createDynamicsCompressor(){return Object.assign(new Node(),{threshold:new Param(),knee:new Param(),ratio:new Param(),attack:new Param(),release:new Param()});}
  createBiquadFilter(){return Object.assign(new Node(),{frequency:new Param(),Q:new Param(),type:'bandpass'});}
  createBuffer(_channels:number,length:number){const data=new Float32Array(length);this.buffers.push(data);return {getChannelData:()=>data};}
}
beforeEach(()=>{Context.all=[];vi.stubGlobal('AudioContext',Context);});afterEach(()=>vi.unstubAllGlobals());
describe('isolated synthesized scene sound',()=>{
  it('is silent until explicitly enabled and never dumps skipped cues on a seek',async()=>{
    const sound=new SceneSound();sound.tick(100,[{id:'click',kind:'felt',gain:.2,atMs:100}]);expect(Context.all).toHaveLength(0);await sound.enable();sound.tick(9000,[{id:'old',kind:'ceramic',gain:.2,atMs:200}]);expect(Context.all[0].sources).toHaveLength(0);sound.stop();
  });
  it('bounds simultaneous effect voices and gain, deduplicates frames and clears every source on revoke',async()=>{
    const sound=new SceneSound(1);await sound.enable();const events=[1,2,3].map(i=>({id:String(i),kind:'ceramic',gain:1,atMs:100}));sound.tick(100,events);const ctx=Context.all[0];expect(ctx.sources).toHaveLength(3);expect(ctx.sources[0].stop).toHaveBeenCalledTimes(2);expect(ctx.gains[0].gain.value).toBeLessThanOrEqual(.6);for(const gain of ctx.gains.slice(1))expect(gain.gain.linearRampToValueAtTime.mock.calls[0][0]).toBeLessThanOrEqual(.25);
    sound.tick(110,events);expect(ctx.sources).toHaveLength(3);sound.stop();for(const source of ctx.sources)expect(source.disconnect).toHaveBeenCalled();expect(ctx.close).toHaveBeenCalledOnce();
  });
  it('produces repeatable original air texture from the event identity',async()=>{
    const a=new SceneSound(),b=new SceneSound();await a.enable();await b.enable();const event={id:'aperture:air',kind:'air',gain:.12,atMs:350};a.tick(350,[event]);b.tick(350,[event]);expect(Context.all[0].buffers[0]).toEqual(Context.all[1].buffers[0]);a.stop();b.stop();
  });
});
