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
