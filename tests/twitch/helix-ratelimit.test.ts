import { describe,it,expect } from 'vitest';
import { TwitchHelix,HelixError } from '../../src/server/twitch/helix.js';

describe('Helix rate-limit headers',()=>{
  it('derives the retry delay from Ratelimit-Reset when Retry-After is absent',async()=>{
    const reset=Math.ceil(Date.now()/1000)+5;
    const helix=new TwitchHelix('1',{authorizedFetch:async()=>new Response('{}',{status:429,headers:{'Ratelimit-Reset':String(reset)}})});
    const error=await helix.sendChat('hello').catch(value=>value) as HelixError;
    expect(error).toBeInstanceOf(HelixError);expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBeGreaterThan(3000);expect(error.retryAfterMs).toBeLessThanOrEqual(6000);
  });
});
