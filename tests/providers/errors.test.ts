import { describe,it,expect,vi } from 'vitest';
import { z } from 'zod';
import { ProviderTransport,ProviderError,OpenAITranscriptionProvider,structuredRequest,describeOpenAIFailure } from '../../src/server/providers/index.js';
import { encodeWav } from '../../src/server/audio/wav.js';

function budget(){return {status:()=>({enabled:true}),reserve:vi.fn(()=>true),settle:vi.fn()};}
const failing=(status:number,error:unknown)=>vi.fn().mockImplementation(async()=>new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json'}}));
const transportFor=(fetcher:ReturnType<typeof vi.fn>,log:(line:string)=>void)=>new ProviderTransport({apiKey:'sk-test-secret-value',runId:'live',externalCallsEnabled:true,budget:budget(),fetch:fetcher as unknown as typeof fetch,log});
async function failure(fetcher:ReturnType<typeof vi.fn>,log:(line:string)=>void,transport=transportFor(fetcher,log)){
  try{await transport.post('responses',JSON.stringify({model:'gpt-6-luna'}),2000);}catch(error){return error as ProviderError;}
  throw new Error('expected failure');
}

describe('OpenAI failure reporting for a first live run',()=>{
  it('names a rejected key once, without echoing the key or OpenAI message',async()=>{
    const log=vi.fn();const fetcher=failing(401,{message:'Incorrect API key provided: sk-test-***alue.',type:'invalid_request_error',code:'invalid_api_key'});
    const transport=transportFor(fetcher,log);const error=await failure(fetcher,log,transport);await failure(fetcher,log,transport);
    expect(error.code).toBe('unavailable');expect(error.retryable).toBe(false);expect(error.httpStatus).toBe(401);expect(error.providerCode).toBe('invalid_api_key');
    expect(log).toHaveBeenCalledTimes(1);expect(log.mock.calls[0][0]).toContain('OPENAI_API_KEY');expect(log.mock.calls[0][0]).not.toContain('sk-test');expect(log.mock.calls[0][0]).not.toContain('Incorrect');
  });
  it('treats billing 429s as non-retryable account problems and ordinary 429s as retryable',async()=>{
    const log=vi.fn();
    const quota=await failure(failing(429,{message:'You exceeded your current quota',type:'insufficient_quota',code:'insufficient_quota'}),log);
    expect(quota.retryable).toBe(false);expect(log.mock.calls.at(-1)![0]).toMatch(/credit|spend limit/);
    const rate=await failure(failing(429,{message:'Rate limit reached',type:'requests',code:'rate_limit_exceeded'}),log);
    expect(rate.retryable).toBe(true);
  });
  it('names the model on 404 model_not_found',async()=>{
    const log=vi.fn();await failure(failing(404,{message:'The model does not exist',type:'invalid_request_error',code:'model_not_found'}),log);
    expect(log.mock.calls[0][0]).toContain('gpt-6-luna');expect(log.mock.calls[0][0]).toContain('model_not_found');
  });
  it('reads at most 16 KB of an error body and cancels the rest',async()=>{
    let pulled=0,cancelled=false;const chunk=new Uint8Array(4096).fill(0x20);
    const endless=()=>new ReadableStream<Uint8Array>({pull(controller){pulled+=chunk.byteLength;controller.enqueue(chunk);},cancel(){cancelled=true;}});
    const error=await failure(vi.fn().mockImplementation(async()=>new Response(endless(),{status:502})),vi.fn());
    expect(error.httpStatus).toBe(502);expect(error.providerCode).toBeUndefined();expect(cancelled).toBe(true);expect(pulled).toBeLessThanOrEqual(16384+3*chunk.byteLength);
    pulled=0;cancelled=false;
    const declared=await failure(vi.fn().mockImplementation(async()=>new Response(endless(),{status:503,headers:{'content-length':String(50_000_000)}})),vi.fn());
    expect(declared.httpStatus).toBe(503);expect(cancelled).toBe(true);expect(pulled).toBeLessThanOrEqual(2*chunk.byteLength);
    const small=await failure(failing(429,{type:'requests',code:'rate_limit_exceeded'}),vi.fn());expect(small.providerCode).toBe('rate_limit_exceeded');
  });
  it('keeps unparseable error bodies to the status code',()=>{expect(describeOpenAIFailure(503)).toContain('OpenAI 503');expect(describeOpenAIFailure(403,'unsupported_country_region_territory')).toContain('region');});
  it('omits the $schema meta keyword from strict Structured Outputs schemas',()=>{
    const request=structuredRequest('probe',z.object({a:z.string()}).strict(),'x',{});
    expect(request.text.format.schema).not.toHaveProperty('$schema');expect(request.text.format.schema).toMatchObject({type:'object',additionalProperties:false,required:['a']});
  });
  it('accepts a transcription without the optional languages list',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({text:'hello there'})));
    const provider=new OpenAITranscriptionProvider(new ProviderTransport({apiKey:'fake',runId:'live',externalCallsEnabled:true,budget:budget(),fetch:fetcher as unknown as typeof fetch}));
    const result=await provider.transcribe({bytes:encodeWav(new Float32Array(16000).fill(0.1),16000),sampleRate:16000,durationMs:1000});
    expect(result.value).toMatchObject({text:'hello there',languageCodes:[]});
  });
});

describe('OpenAI budget reservations for calls that were never billed (review B2)',()=>{
  function ledger(){const reserved=new Map<string,number>();return {reserved,status:()=>({enabled:true}),reserve:vi.fn((id:string,amount:number)=>{reserved.set(id,amount);return true;}),settle:vi.fn(),releaseUnsent:vi.fn((id:string)=>{reserved.delete(id);})};}
  const networkError=(code:string)=>Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('connect failed'),{code})});
  const post=(transport:ProviderTransport)=>transport.post('responses',JSON.stringify({model:'gpt-6-luna'}),2000).catch((error:unknown)=>error as ProviderError);
  it.each([400,401,403,404])('returns the reservation after an unbilled %s',async status=>{
    const b=ledger(),transport=new ProviderTransport({apiKey:'fake',runId:'live',externalCallsEnabled:true,budget:b,fetch:failing(status,{code:'x'}) as unknown as typeof fetch,log:vi.fn()});
    expect(await post(transport)).toMatchObject({code:'unavailable',httpStatus:status});expect(b.reserve).toHaveBeenCalledOnce();expect(b.reserved.size).toBe(0);
  });
  it.each(['ENOTFOUND','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT'])('returns the reservation when the request was never sent (%s)',async code=>{
    const b=ledger(),transport=new ProviderTransport({apiKey:'fake',runId:'live',externalCallsEnabled:true,budget:b,fetch:vi.fn().mockRejectedValue(networkError(code)) as unknown as typeof fetch,log:vi.fn()});
    expect(await post(transport)).toMatchObject({code:'unavailable'});expect(b.reserved.size).toBe(0);
  });
  it('keeps the reservation when the outcome is unknown or billable',async()=>{
    for(const fetcher of [vi.fn().mockRejectedValue(networkError('ECONNRESET')),vi.fn().mockRejectedValue(new DOMException('timed out','TimeoutError')),failing(500,{code:'server_error'}),failing(429,{code:'rate_limit_exceeded'})]){
      const b=ledger(),transport=new ProviderTransport({apiKey:'fake',runId:'live',externalCallsEnabled:true,budget:b,fetch:fetcher as unknown as typeof fetch,log:vi.fn()});
      await post(transport);expect(b.reserved.size).toBe(1);expect(b.releaseUnsent).not.toHaveBeenCalled();
    }
  });
  it('stops calling OpenAI after the key is rejected, without reserving again',async()=>{
    const b=ledger(),issues=vi.fn(),fetcher=failing(401,{code:'invalid_api_key'}),transport=new ProviderTransport({apiKey:'sk-bad',runId:'live',externalCallsEnabled:true,budget:b,fetch:fetcher as unknown as typeof fetch,log:vi.fn(),onIssue:issues});
    const first=await post(transport),second=await post(transport);
    expect(fetcher).toHaveBeenCalledOnce();expect(b.reserve).toHaveBeenCalledOnce();expect(second).toBe(first);expect(second).toMatchObject({code:'unavailable',httpStatus:401,retryable:false});
    expect(issues.mock.calls.at(-1)).toEqual(['story',expect.objectContaining({code:'openai_key_rejected'})]);
  });
});

describe('Realtime narration reservations (review B2)',()=>{
  it('returns the reservation when the handshake is rejected, and stops after a rejected key',async()=>{
    const {OpenAIRealtimeNarrationProvider}=await import('../../src/server/providers/index.js');
    const released=vi.fn(),b={status:()=>({enabled:true}),reserve:vi.fn(()=>true),settle:vi.fn(),releaseUnsent:released};
    const transport=new ProviderTransport({apiKey:'fake',runId:'live',externalCallsEnabled:true,budget:b,log:vi.fn()});
    const make=vi.fn(()=>{const listeners=new Map<string,(...args:unknown[])=>void>();queueMicrotask(()=>listeners.get('error')?.(new Error('Unexpected server response: 401')));return {on:(name:string,callback:(...args:unknown[])=>void)=>listeners.set(name,callback),send:vi.fn(),close:vi.fn()};});
    const provider=new OpenAIRealtimeNarrationProvider(transport,{approved:()=>true,socket:make});
    await expect(provider.synthesize('Approved words','en')).rejects.toMatchObject({code:'unavailable'});expect(released).toHaveBeenCalledOnce();
    await expect(provider.synthesize('Approved words','en')).rejects.toMatchObject({httpStatus:401});expect(make).toHaveBeenCalledOnce();expect(b.reserve).toHaveBeenCalledOnce();
  });
});
