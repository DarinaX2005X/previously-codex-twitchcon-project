import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {SceneSound,encodeWav,pitchVariation} from '../../src/features/overlay/sound.js';
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
const KINDS=['swoosh','thump','rewind','flick','latch','slide','chatter','tap','tap2','felt','resolve','release'];
describe('isolated synthesized scene sound',()=>{
  it('is silent until explicitly enabled and never dumps skipped cues on a seek',async()=>{
    const sound=new SceneSound();sound.tick(100,[{id:'click',kind:'thump',gain:.2,atMs:100}]);expect(Context.all).toHaveLength(0);
    await sound.enable();sound.tick(9000,[{id:'old',kind:'tap',gain:.2,atMs:200}]);expect(Context.all[0].sources).toHaveLength(0);sound.stop();
  });
  it('synthesizes every palette sound without samples',async()=>{
    const sound=new SceneSound();await sound.enable();
    KINDS.forEach((kind,i)=>sound.tick(i*1000+1000,[{id:`k${i}`,kind,gain:.5,atMs:i*1000+1000,durationMs:900}]));
    expect(Context.all[0].sources.length).toBeGreaterThan(KINDS.length);sound.stop();
  });
  it('keeps at most two tonal voices, bounds gain, deduplicates frames and clears every source on stop',async()=>{
    const sound=new SceneSound(1);await sound.enable();const ctx=Context.all[0];
    const events=[1,2,3].map(i=>({id:String(i),kind:'thump',gain:1,atMs:100}));sound.tick(100,events);
    const firstVoice=ctx.sources.slice(0,2);expect(firstVoice.every(s=>s.stop.mock.calls.length>=2)).toBe(true);
    expect(ctx.gains[0].gain.value).toBeLessThanOrEqual(.6);
    const count=ctx.sources.length;sound.tick(110,events);expect(ctx.sources).toHaveLength(count);
    sound.stop();for(const source of ctx.sources.slice(2))expect(source.disconnect).toHaveBeenCalled();expect(ctx.close).toHaveBeenCalledOnce();
  });
  it('chatter is a separate granular layer that does not steal tonal voices',async()=>{
    const sound=new SceneSound();await sound.enable();const ctx=Context.all[0];
    sound.tick(100,[{id:'a',kind:'thump',gain:.5,atMs:100},{id:'b',kind:'tap',gain:.5,atMs:100}]);const before=ctx.sources.slice();
    sound.tick(120,[{id:'c',kind:'chatter',gain:.5,atMs:120,durationMs:1200}]);
    expect(ctx.sources.length-before.length).toBeGreaterThan(20);expect(before.every(s=>s.stop.mock.calls.length===1)).toBe(true);sound.stop();
  });
  it('produces repeatable texture and ±3 % pitch from the event identity',async()=>{
    const a=new SceneSound(),b=new SceneSound();await a.enable();await b.enable();const event={id:'scene:swoosh',kind:'swoosh',gain:.4,atMs:0};
    a.tick(0,[event]);b.tick(0,[event]);expect(Context.all[0].buffers[0]).toEqual(Context.all[1].buffers[0]);a.stop();b.stop();
    for(const id of ['a','b','scene:1:thump','x'.repeat(40)]){const v=pitchVariation(id);expect(v).toBeGreaterThanOrEqual(.97);expect(v).toBeLessThanOrEqual(1.03);}
  });
  it('encodes a 16-bit PCM WAV for the video editor',()=>{
    const left=new Float32Array([0,.5,-1,1]),right=new Float32Array([0,-.5,1,-1]);
    const wav=new DataView(encodeWav({numberOfChannels:2,length:4,sampleRate:48000,getChannelData:(c:number)=>c?right:left} as unknown as AudioBuffer));
    expect(String.fromCharCode(...[0,1,2,3].map(i=>wav.getUint8(i)))).toBe('RIFF');expect(wav.getUint16(22,true)).toBe(2);expect(wav.getUint32(24,true)).toBe(48000);
    expect(wav.byteLength).toBe(44+16);expect(wav.getInt16(44+4*2,true)).toBe(-32768);
  });
});
