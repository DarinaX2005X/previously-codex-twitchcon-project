import WebSocket from 'ws';
import type { NarrationProvider, RecapLanguage } from '../../shared/contracts/index.js';
import { encodeWav } from '../audio/wav.js';
import { ProviderError, ProviderTransport, RESERVATION } from './transport.js';
export interface NarrationSocket {on(event:string,listener:(...args:any[])=>void):unknown;send(data:string):void;close():void}
export type NarrationOptions={approved:(text:string,language:RecapLanguage)=>boolean|Promise<boolean>;socket?:(url:string,headers:Record<string,string>)=>NarrationSocket};
const normalized=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu,' ').trim();
export class OpenAIRealtimeNarrationProvider implements NarrationProvider {
  constructor(private readonly transport:ProviderTransport,private readonly options:NarrationOptions){}
  async synthesize(text:string,language:RecapLanguage,signal?:AbortSignal) {
    if(!text.trim()||Buffer.byteLength(text)>1200||!(await this.options.approved(text,language)))throw new ProviderError('held');
    signal?.throwIfAborted();
    const attemptId=this.transport.authorize(RESERVATION.narration);
    const socket=(this.options.socket??((url,headers)=>new WebSocket(url,{headers})))(`wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini`,{Authorization:`Bearer ${this.transport.options.apiKey}`});
    return await new Promise<Awaited<ReturnType<NarrationProvider['synthesize']>>>((resolve,reject)=>{
      const chunks:Buffer[]=[];let size=0,transcript='',sent=false,finished=false;
      const end=(error?:Error,value?:Awaited<ReturnType<NarrationProvider['synthesize']>>)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.close();if(error)reject(error);else resolve(value!);};
      const abort=()=>end(new ProviderError('unavailable'));const timer=setTimeout(abort,30000);signal?.addEventListener('abort',abort,{once:true});
      socket.on('error',abort);socket.on('close',()=>{if(!finished)abort();});
      socket.on('message',(raw:unknown)=>{void (async()=>{
        let event:any;try{event=JSON.parse(String(raw));}catch{end(new ProviderError('invalid'));return;}
        if(event.type==='session.created'&&!sent){sent=true;if(signal?.aborted||!(await this.options.approved(text,language))||finished){end(new ProviderError('held'));return;}socket.send(JSON.stringify({type:'response.create',event_id:attemptId,response:{conversation:'none',output_modalities:['audio'],max_output_tokens:2048,tools:[],tool_choice:'none',instructions:'Read the supplied approved script exactly once in its original language. Do not add, answer, translate or paraphrase anything.',input:[{type:'message',role:'user',content:[{type:'input_text',text}]}],audio:{output:{format:{type:'audio/pcm',rate:24000},voice:'cedar'}}}}));}
        else if(event.type==='response.output_audio.delta'){if(typeof event.delta!=='string'||!sent){end(new ProviderError('invalid'));return;}const chunk=Buffer.from(event.delta,'base64');size+=chunk.length;if(size>1_440_000){end(new ProviderError('envelope'));return;}chunks.push(chunk);}
        else if(event.type==='response.output_audio_transcript.done')transcript=typeof event.transcript==='string'?event.transcript:'';
        else if(event.type==='error')end(new ProviderError('unavailable'));
        else if(event.type==='response.done'){
          if(event.response?.status!=='completed'||!size||size%2||normalized(transcript)!==normalized(text)||!(await this.options.approved(text,language))){end(new ProviderError('held'));return;}
          const pcm=Buffer.concat(chunks),samples=new Float32Array(pcm.length/2);for(let i=0;i<samples.length;i++)samples[i]=pcm.readInt16LE(i*2)/32768;
          end(undefined,{value:{bytes:encodeWav(samples,24000),mimeType:'audio/wav',durationMs:samples.length/24},usage:{chargedMicroUsd:null},requestId:event.response?.id??attemptId,model:'gpt-realtime-2.1-mini'});
        }
      })().catch(()=>end(new ProviderError('invalid')));});
    });
  }
}
