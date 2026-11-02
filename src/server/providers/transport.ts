import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProviderResult } from '../../shared/contracts/index.js';

export class ProviderError extends Error {
  constructor(readonly code: 'disabled'|'budget'|'envelope'|'unavailable'|'invalid'|'held'|'refused', readonly retryable = false,readonly retryAfterMs?:number,readonly httpStatus?:number,readonly providerCode?:string) { super(`Provider ${code}.`); }
}
export interface BudgetPort { status(): {enabled:boolean}; reserve(id:string, amountMicroUsd:number, runId:string): boolean; settle(id:string, actualMicroUsd:number): void }
export type ProviderOptions = { apiKey?:string; runId:string; budget:BudgetPort; fetch?:typeof fetch; now?:()=>number; externalCallsEnabled?:boolean; log?:(line:string)=>void };
/** Billing/quota 429s need an account change; retrying them only burns reservations. https://developers.openai.com/api/docs/guides/error-codes */
const ACCOUNT_LIMIT_CODES=new Set(['insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded']);
/** Operator-facing hint. Contains only HTTP status, OpenAI's error code and fixed text; never the key, request or OpenAI's message. */
export function describeOpenAIFailure(status:number,code?:string,model?:string):string {
  const tag=`OpenAI ${status}${code?` ${code}`:''}`;
  if(status===401)return `${tag}: the API key was rejected. Check OPENAI_API_KEY (no quotes or spaces), or create a new key at https://platform.openai.com/api-keys, then restart.`;
  if(status===403)return `${tag}: this key's project cannot use the requested model or region. Check project model permissions and https://developers.openai.com/api/docs/guides/error-codes.`;
  if(status===404)return `${tag}: model${model?` ${model}`:''} is not available to this key's project. Check the project's model access in the OpenAI dashboard.`;
  if(status===429&&code&&ACCOUNT_LIMIT_CODES.has(code))return `${tag}: the OpenAI account has no usable credit or hit a spend limit. Add credit or raise the limit at https://platform.openai.com/settings/organization/billing, then restart.`;
  if(status===429)return `${tag}: rate limited; Previously retries briefly and otherwise records a gap.`;
  if(status===400)return `${tag}: OpenAI rejected the request shape. Please report this with the error code.`;
  return `${tag}: temporary OpenAI failure; new material stays held until it recovers.`;
}
export const MODEL = 'gpt-6-luna';
// Reserve 10K input tokens including framing, all at the 30m cache-write rate, plus 1,024 output:
// ceil(1.1 * (10000 * 0.125 + 1024 * 0.50)) = 1,939 micro-USD, below the 2,000 reserve.
export const RESERVATION = {text:2000,transcription:10000,narration:50000} as const;
// `$schema` is not part of the documented Structured Outputs subset; omit the meta keyword rather than rely on it being ignored.
const strictSchema=(schema:z.ZodType)=>{const {$schema:_meta,...rest}=z.toJSONSchema(schema) as Record<string,unknown>;return rest;};
export function structuredRequest<T>(name:string,schema:z.ZodType<T>,instructions:string,data:unknown) {return {model:MODEL,service_tier:'default',prompt_cache_options:{mode:'explicit',ttl:'30m'},store:false,reasoning:{effort:'none'},max_output_tokens:1024,tools:[],input:[{role:'system',content:instructions},{role:'user',content:JSON.stringify(data)}],text:{format:{type:'json_schema',name,strict:true,schema:strictSchema(schema)}}};}
/** The same persistent BudgetStore is shared by every provider. No implicit enable, refund or retry. */
export class ProviderTransport {
  readonly fetch:typeof fetch;
  private reported=new Set<string>();
  constructor(readonly options:ProviderOptions) { this.fetch=options.fetch??fetch; }
  /** One line per distinct failure kind in the server terminal, so an operator can fix keys/billing without reading code. */
  report(key:string,line:string){if(this.reported.has(key)||this.reported.size>=64)return;this.reported.add(key);try{(this.options.log??(text=>console.warn(text)))(`[previously] ${line}`);}catch{/* Diagnostics never interrupt provider work. */}}
  authorize(amount:number):string {
    if(this.options.runId!=='live'||!this.options.externalCallsEnabled||!this.options.apiKey||!this.options.budget.status().enabled) throw new ProviderError('disabled');
    const id=randomUUID();
    if(amount && !this.options.budget.reserve(id,amount,'live')) {this.report('budget','The persistent $4.50 OpenAI dispatch ceiling is reached; new speech and story work stays held.');throw new ProviderError('budget');}
    return id;
  }
  async post(path:string, body:string|FormData, amount:number, signal?:AbortSignal):Promise<{body:any;requestId:string;attemptId:string}> {
    signal?.throwIfAborted();
    const id=this.authorize(amount);
    let response:Response;
    const timeoutMs=path==='responses'?25000:30000;
    try { response=await this.fetch(`https://api.openai.com/v1/${path}`,{method:'POST',headers:{Authorization:`Bearer ${this.options.apiKey}`,...(typeof body==='string'?{'Content-Type':'application/json'}:{})},body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),redirect:'error'}); }
    catch { if(!signal?.aborted)this.report('network','OpenAI could not be reached (network error or timeout); affected speech becomes a gap and new text stays held.'); throw new ProviderError('unavailable'); }
    // Keep the full conservative reservation on every outcome, including known HTTP failures.
    if(!response.ok) {
      const retry=response.headers.get('retry-after');const retryAfterMs=retry?(/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Date.parse(retry)-(this.options.now??Date.now)()):undefined;
      // Read only OpenAI's machine-readable error code/type; the message text is never retained or logged.
      let code:string|undefined;try{const raw=await response.text();if(raw.length<=16384){const error=(JSON.parse(raw) as {error?:{code?:unknown;type?:unknown}}).error;const value=typeof error?.code==='string'?error.code:typeof error?.type==='string'?error.type:undefined;if(value&&/^[a-z0-9_.-]{1,64}$/i.test(value))code=value;}}catch{/* Unparseable error bodies keep only the HTTP status. */}
      const accountLimit=response.status===429&&!!code&&ACCOUNT_LIMIT_CODES.has(code);
      let model:string|undefined;try{model=typeof body==='string'?String(JSON.parse(body).model??''):String(body.get('model')??'');}catch{/* Model name is optional context. */}
      this.report(`http:${response.status}:${code??''}`,describeOpenAIFailure(response.status,code,model||undefined));
      throw new ProviderError('unavailable',(response.status===429&&!accountLimit)||response.status>=500,Number.isFinite(retryAfterMs)?Math.max(0,Math.min(60000,retryAfterMs!)):undefined,response.status,code);
    }
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
