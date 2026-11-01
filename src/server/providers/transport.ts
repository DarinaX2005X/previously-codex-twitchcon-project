import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProviderResult } from '../../shared/contracts/index.js';

export class ProviderError extends Error {
  constructor(readonly code: 'disabled'|'budget'|'envelope'|'unavailable'|'invalid'|'held'|'refused', readonly retryable = false,readonly retryAfterMs?:number) { super(`Provider ${code}.`); }
}
export interface BudgetPort { status(): {enabled:boolean}; reserve(id:string, amountMicroUsd:number, runId:string): boolean; settle(id:string, actualMicroUsd:number): void }
export type ProviderOptions = { apiKey?:string; runId:string; budget:BudgetPort; fetch?:typeof fetch; now?:()=>number; externalCallsEnabled?:boolean };
export const MODEL = 'gpt-6-luna';
// At most 8K input tokens including framing, all charged as 30m cache writes, plus 1,024 output:
// ceil(1.1 * (8000 * 0.125 + 1024 * 0.50)) = 1,664 micro-USD, below the 2,000 reserve.
export const RESERVATION = {text:2000,transcription:10000,narration:50000} as const;
export function structuredRequest<T>(name:string,schema:z.ZodType<T>,instructions:string,data:unknown) {return {model:MODEL,service_tier:'default',prompt_cache_options:{ttl:'30m'},store:false,reasoning:{effort:'none'},max_output_tokens:1024,tools:[],input:[{role:'system',content:instructions},{role:'user',content:JSON.stringify(data)}],text:{format:{type:'json_schema',name,strict:true,schema:z.toJSONSchema(schema)}}};}
/** The same persistent BudgetStore is shared by every provider. No implicit enable, refund or retry. */
export class ProviderTransport {
  readonly fetch:typeof fetch;
  constructor(readonly options:ProviderOptions) { this.fetch=options.fetch??fetch; }
  authorize(amount:number):string {
    if(this.options.runId!=='live'||!this.options.externalCallsEnabled||!this.options.apiKey||!this.options.budget.status().enabled) throw new ProviderError('disabled');
    const id=randomUUID();
    if(amount && !this.options.budget.reserve(id,amount,'live')) throw new ProviderError('budget');
    return id;
  }
  async post(path:string, body:string|FormData, amount:number, signal?:AbortSignal):Promise<{body:any;requestId:string;attemptId:string}> {
    signal?.throwIfAborted();
    const id=this.authorize(amount);
    let response:Response;
    const timeoutMs=path==='responses'?25000:30000;
    try { response=await this.fetch(`https://api.openai.com/v1/${path}`,{method:'POST',headers:{Authorization:`Bearer ${this.options.apiKey}`,...(typeof body==='string'?{'Content-Type':'application/json'}:{})},body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),redirect:'error'}); }
    catch { throw new ProviderError('unavailable'); }
    // Keep the full conservative reservation on every outcome, including known HTTP failures.
    if(!response.ok) {const retry=response.headers.get('retry-after');const retryAfterMs=retry?(/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Date.parse(retry)-(this.options.now??Date.now)()):undefined;await response.body?.cancel();throw new ProviderError('unavailable',response.status===429||response.status>=500,Number.isFinite(retryAfterMs)?Math.max(0,Math.min(60000,retryAfterMs!)):undefined);}
    let text:string;try{text=await response.text();}catch{throw new ProviderError('unavailable');}
    if(Buffer.byteLength(text)>256_000) throw new ProviderError('invalid');
    let parsed:unknown;try {parsed=JSON.parse(text);} catch {throw new ProviderError('invalid');}
    return {body:parsed,requestId:response.headers.get('x-request-id')??id,attemptId:id};
  }
  async structured<T>(name:string,schema:z.ZodType<T>,instructions:string,data:unknown,signal?:AbortSignal):Promise<ProviderResult<T>> {
    const request=structuredRequest(name,schema,instructions,data);
    const body=JSON.stringify(request);
    // UTF-8 bytes bound BPE token count conservatively, including schema/instructions and a framing margin.
    // Deliberately smaller than 8K tokens; RU/code do not use a characters/4 approximation.
    if(Buffer.byteLength(body,'utf8')>7600) throw new ProviderError('envelope');
    const result=await this.post('responses',body,RESERVATION.text,signal);
    if(result.body?.status!=='completed'||!Array.isArray(result.body.output)) throw new ProviderError('invalid');
    const content=result.body.output.flatMap((item:any)=>Array.isArray(item.content)?item.content:[]);
    if(content.some((item:any)=>item.type==='refusal')) throw new ProviderError('refused');
    const texts=content.filter((item:any)=>item.type==='output_text');
    if(texts.length!==1||typeof texts[0].text!=='string') throw new ProviderError('invalid');
    let value:T;try {value=schema.parse(JSON.parse(texts[0].text));} catch {throw new ProviderError('invalid');}
    const usage=result.body.usage;
    if(usage && Number.isFinite(usage.input_tokens)&&Number.isFinite(usage.output_tokens)) {
      // Count every input token at the higher 30m cache-write rate; never rely on cache savings.
      const actual=Math.ceil(1.1*(usage.input_tokens*0.125+usage.output_tokens*0.50));
      if(actual>RESERVATION.text) {this.options.budget.settle(result.attemptId,actual);throw new ProviderError('budget');}
    }
    return {value,usage:{inputTokens:usage?.input_tokens,outputTokens:usage?.output_tokens,chargedMicroUsd:null},requestId:result.requestId,model:MODEL};
  }
}
