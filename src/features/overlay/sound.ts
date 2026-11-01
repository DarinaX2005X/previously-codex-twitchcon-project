import type { SceneSoundEvent } from './scene.js';

/** Dry original synthesis; two bounded nonvoice voices and a shared compressor per isolated player. */
export class SceneSound {
  private context:AudioContext|null=null;
  private output:GainNode|null=null;
  private voices:{source:AudioScheduledSourceNode;gain:GainNode;filter?:BiquadFilterNode}[]=[];
  private seen=new Set<string>();
  private previous=0;
  constructor(private readonly volume=.45,private readonly blocked:()=>void=()=>{}){}
  async enable():Promise<boolean>{
    try {
      if(!this.context){const ctx=new AudioContext();this.context=ctx;const compressor=ctx.createDynamicsCompressor();compressor.threshold.value=-16;compressor.knee.value=8;compressor.ratio.value=12;compressor.attack.value=.003;compressor.release.value=.08;this.output=ctx.createGain();this.output.gain.value=Math.max(0,Math.min(.6,this.volume));this.output.connect(compressor);compressor.connect(ctx.destination);}
      await this.context.resume();if(this.context.state!=='running'){this.blocked();return false;}return true;
    }catch{this.blocked();return false;}
  }
  tick(timeMs:number,events:SceneSoundEvent[]):void {
    if(timeMs<this.previous){this.stopVoices();this.seen.clear();}
    for(const event of events){
      if(event.atMs>timeMs||this.seen.has(event.id))continue;
      this.seen.add(event.id);
      // Jumping the virtual clock does not dump missed cues into one frame.
      if(timeMs-event.atMs<=100&&event.atMs>=this.previous)this.play(event);
    }
    this.previous=timeMs;
  }
  private play(event:SceneSoundEvent):void {
    const ctx=this.context;if(!ctx||ctx.state!=='running'||!this.output)return;
    if(this.voices.length>=2){const old=this.voices.shift()!;old.source.onended=null;old.source.stop();old.source.disconnect();old.gain.disconnect();old.filter?.disconnect();}
    const hash=[...event.id].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,7), variation=.98+(hash%401)/10000;
    const ceramic=event.kind.includes('ceramic'),air=event.kind.includes('air'),resolve=event.kind.includes('resolve');
    const gain=ctx.createGain(),now=ctx.currentTime;
    let source:AudioScheduledSourceNode,filter:BiquadFilterNode|undefined;
    const frequency=(ceramic?730:air?180:resolve?392:115)*variation;
    if(air){
      const buffer=ctx.createBuffer(1,Math.ceil(ctx.sampleRate*.24),ctx.sampleRate),samples=buffer.getChannelData(0);let seed=hash;
      for(let i=0;i<samples.length;i++){seed=(1664525*seed+1013904223)>>>0;samples[i]=(seed/0xffffffff)*2-1;}
      const noise=ctx.createBufferSource();noise.buffer=buffer;source=noise;
      filter=ctx.createBiquadFilter();filter.type='bandpass';filter.frequency.setValueAtTime(1100,now);filter.frequency.exponentialRampToValueAtTime(350,now+.2);filter.Q.value=.65;source.connect(filter);filter.connect(gain);
    }else{
      const osc=ctx.createOscillator();source=osc;osc.type='sine';osc.frequency.setValueAtTime(frequency,now);
      if(resolve)osc.frequency.setValueAtTime(frequency*1.5,now+.12);else osc.frequency.exponentialRampToValueAtTime(frequency*.67,now+.14);
      source.connect(gain);
    }
    gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(Math.min(.25,event.gain)*(air?.4:1),now+.006);gain.gain.exponentialRampToValueAtTime(.0001,now+(ceramic?.12:.22));
    if(resolve){gain.gain.setValueAtTime(.0001,now+.105);gain.gain.linearRampToValueAtTime(Math.min(.18,event.gain),now+.126);gain.gain.exponentialRampToValueAtTime(.0001,now+.23);}
    gain.connect(this.output);const voice={source,gain,filter};this.voices.push(voice);source.onended=()=>{source.disconnect();gain.disconnect();filter?.disconnect();this.voices=this.voices.filter(v=>v!==voice);};source.start(now);source.stop(now+.24);
  }
  private stopVoices():void {for(const v of this.voices){v.source.onended=null;v.source.stop();v.source.disconnect();v.gain.disconnect();v.filter?.disconnect();}this.voices=[];}
  stop():void {this.stopVoices();this.seen.clear();this.previous=0;const ctx=this.context;this.context=null;this.output=null;if(ctx)void ctx.close();}
}
