import { z } from 'zod';
import type { TranscriptionProvider } from '../../shared/contracts/index.js';
import { parseWav } from '../audio/wav.js';
import { ProviderError, ProviderTransport, RESERVATION } from './transport.js';
const TranscriptSchema=z.object({text:z.string().max(12000),languages:z.array(z.object({code:z.string().min(2).max(16)})).max(8)});
export class OpenAITranscriptionProvider implements TranscriptionProvider {
  constructor(private readonly transport:ProviderTransport){}
  async transcribe(input:Parameters<TranscriptionProvider['transcribe']>[0],signal?:AbortSignal) {
    const wav=parseWav(input.bytes);
    if(wav.durationMs<1000||wav.durationMs>30000||wav.sampleRate!==input.sampleRate||Math.abs(wav.durationMs-input.durationMs)>2)throw new ProviderError('envelope');
    if(wav.rms<0.00003&&wav.peak<0.0001)return {value:{text:'',languageCodes:[],confidence:1},usage:{chargedMicroUsd:0},requestId:'silence',model:'local-silence-gate'};
    const form=new FormData();form.set('model','gpt-transcribe');form.set('file',new Blob([new Uint8Array(input.bytes)],{type:'audio/wav'}),'chunk.wav');
    if(input.languageHint){if(!/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(input.languageHint))throw new ProviderError('envelope');form.append('languages[]',input.languageHint);}
    const result=await this.transport.post('audio/transcriptions',form,RESERVATION.transcription,signal);
    const parsed=TranscriptSchema.safeParse(result.body);if(!parsed.success)throw new ProviderError('invalid');
    return {value:{text:parsed.data.text.trim(),languageCodes:parsed.data.languages.map(item=>item.code),confidence:null},usage:{audioSeconds:wav.durationMs/1000,chargedMicroUsd:null},requestId:result.requestId,model:'gpt-transcribe'};
  }
}
