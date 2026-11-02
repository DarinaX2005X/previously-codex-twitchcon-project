import {describe,it,expect,vi} from 'vitest';
import {TwitchTokens,TWITCH_SCOPES} from '../../src/server/auth/tokens.js';
import {createStorage} from '../../src/server/storage/index.js';
const scope={channelId:'123',runId:'live'};
function fixture(){const storage=createStorage({path:':memory:',now:()=>100000,encryptionKey:new Uint8Array(32).fill(9)});storage.repository.ensureChannel(scope,'channel');return storage;}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const valid=(extra:Record<string,unknown>={})=>Response.json({client_id:'client',user_id:'123',scopes:TWITCH_SCOPES,expires_in:3600,...extra});
function tokenOptions(store:ReturnType<typeof fixture>,fetcher:typeof fetch,onRevoked=vi.fn()){return {scope,clientId:'client',clientSecret:'secret',redirectUri:'https://localhost:4317/auth/twitch/callback',tokenVault:store.tokenVault!,fetch:fetcher,now:()=>100000,onRevoked};}
const oldCredentials=(expiresAtMs=1000000)=>({accessToken:'old',refreshToken:'old-refresh',expiresAtMs,scopes:[...TWITCH_SCOPES]});
describe('Twitch token lifecycle',()=>{
  it('refreshes concurrent 401 once, persists rotation and validates on restart',async()=>{
    const store=fixture();let refreshes=0;
    store.tokenVault!.put(scope,'twitch',{accessToken:'old',refreshToken:'refresh',expiresAtMs:1000000,scopes:TWITCH_SCOPES});
    const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      if(String(url).endsWith('/token')){refreshes++;await Promise.resolve();return Response.json({access_token:'new',refresh_token:'rotated',expires_in:3600});}
      if(String(url).endsWith('/validate'))return Response.json({client_id:'client',user_id:'123',scopes:TWITCH_SCOPES,expires_in:3600});
      return new Response(null,{status:new Headers(init?.headers).get('Authorization')==='Bearer old'?401:204});
    });
    const options={scope,clientId:'client',clientSecret:'secret',redirectUri:'https://localhost:4317/auth/twitch/callback',tokenVault:store.tokenVault!,fetch:fetcher as typeof fetch,now:()=>100000};
    const tokens=new TwitchTokens(options);const result=await Promise.all([tokens.authorizedFetch('https://api.twitch.tv/a'),tokens.authorizedFetch('https://api.twitch.tv/b')]);
    expect(result.map(r=>r.status)).toEqual([204,204]);expect(refreshes).toBe(1);expect(store.tokenVault!.get<{refreshToken:string}>(scope,'twitch')?.refreshToken).toBe('rotated');
    const restarted=new TwitchTokens(options);await restarted.start();expect(restarted.status().connected).toBe(true);restarted.stop();store.close();
  });
  it('revokes owner sessions after invalid refresh and rejects wrong identity',async()=>{
    const store=fixture();const id=store.sessions.issue(scope,'123','owner');store.tokenVault!.put(scope,'twitch',{accessToken:'old',refreshToken:'bad',expiresAtMs:0,scopes:[]});
    const tokens=new TwitchTokens({scope,clientId:'client',clientSecret:'secret',redirectUri:'https://localhost:4317/auth/twitch/callback',tokenVault:store.tokenVault!,fetch:async()=>new Response(null,{status:400})});
    await expect(tokens.authorizedFetch('https://api.twitch.tv/a')).rejects.toMatchObject({code:'reconnect_required'});expect(store.sessions.verify(scope,id,'owner')).toBeNull();
    const wrong=new TwitchTokens({scope,clientId:'client',clientSecret:'secret',redirectUri:'https://localhost:4317/auth/twitch/callback',tokenVault:store.tokenVault!,fetch:async url=>String(url).endsWith('/token')?Response.json({access_token:'new',refresh_token:'r'}):Response.json({client_id:'client',user_id:'456',scopes:TWITCH_SCOPES,expires_in:3600})});
    await expect(wrong.exchange('code')).rejects.toMatchObject({code:'wrong_identity'});expect(store.tokenVault!.get(scope,'twitch')).toBeNull();store.close();
  });
  it('checks the outbound fence after refresh and reports missing permissions',async()=>{
    const store=fixture();let permitted=true;let sent=0;
    store.tokenVault!.put(scope,'twitch',{accessToken:'old',refreshToken:'refresh',expiresAtMs:0,scopes:TWITCH_SCOPES});
    const fetcher:typeof fetch=async url=>{
      if(String(url).endsWith('/token')){permitted=false;return Response.json({access_token:'new',refresh_token:'rotated'});}
      if(String(url).endsWith('/validate'))return Response.json({client_id:'client',user_id:'123',scopes:TWITCH_SCOPES,expires_in:3600});
      sent++;return new Response(null,{status:204});
    };
    const tokens=new TwitchTokens({scope,clientId:'client',clientSecret:'secret',redirectUri:'https://localhost:4317/auth/twitch/callback',tokenVault:store.tokenVault!,fetch:fetcher});
    await expect(tokens.authorizedFetch('https://api.twitch.tv/helix/chat/messages',{method:'POST'},()=>permitted)).rejects.toThrow('dispatch_fence_changed');expect(sent).toBe(0);
    const missing=new TwitchTokens({scope,clientId:'client',clientSecret:'secret',redirectUri:'https://localhost:4317/auth/twitch/callback',tokenVault:store.tokenVault!,fetch:async url=>String(url).endsWith('/token')?Response.json({access_token:'a',refresh_token:'r'}):Response.json({client_id:'client',user_id:'123',scopes:['user:read:chat'],expires_in:3600})});
    await expect(missing.exchange('code')).rejects.toMatchObject({code:'missing_permission'});expect(missing.status().missingPermissions).toContain('moderation:read');store.close();
  });
});

describe('validation lifecycle fences',()=>{
  it.each([200,401])('does not restore or refresh a disconnected authorization after a delayed %s validation',async status=>{
    const store=fixture(),pending=deferred<Response>(),revoked=vi.fn();store.tokenVault!.put(scope,'twitch',oldCredentials(0));
    const fetcher=vi.fn(async()=>pending.promise),tokens=new TwitchTokens(tokenOptions(store,fetcher,revoked));
    try{const validation=tokens.validate();tokens.disconnect();pending.resolve(status===200?valid():new Response(null,{status}));expect(await validation).toBe(false);expect(tokens.status().connected).toBe(false);expect(store.tokenVault!.get(scope,'twitch')).toBeNull();expect(fetcher).toHaveBeenCalledOnce();expect(revoked).toHaveBeenCalledOnce();}finally{store.close();}
  });
  it('preserves a concurrently rotated refresh token even when Twitch reuses the access token',async()=>{
    const store=fixture(),pending=deferred<Response>();store.tokenVault!.put(scope,'twitch',oldCredentials(0));let validations=0;
    const fetcher:typeof fetch=async url=>{
      if(String(url).endsWith('/token'))return Response.json({access_token:'old',refresh_token:'rotated-refresh'});
      if(String(url).endsWith('/validate'))return ++validations===1?pending.promise:valid();
      return new Response(null,{status:204});
    };
    const tokens=new TwitchTokens(tokenOptions(store,fetcher));
    try{const validation=tokens.validate();expect((await tokens.authorizedFetch('https://api.twitch.tv/authored')).status).toBe(204);const current=store.tokenVault!.get(scope,'twitch');pending.resolve(valid({expires_in:123}));expect(await validation).toBe(false);expect(store.tokenVault!.get(scope,'twitch')).toEqual(current);expect(tokens.status()).toMatchObject({connected:true,missingPermissions:[]});}finally{store.close();}
  });
  it.each(['valid','unauthorized','wrong-identity','missing-scopes','unavailable','network-error'])('ignores stale %s validation after a new authorization without revoking its owner session',async result=>{
    const store=fixture(),pending=deferred<Response>(),revoked=vi.fn();store.tokenVault!.put(scope,'twitch',oldCredentials());
    const fetcher:typeof fetch=async(url,init)=>{
      if(String(url).endsWith('/token'))return Response.json({access_token:'new',refresh_token:'new-refresh'});
      return new Headers(init?.headers).get('Authorization')==='OAuth old'?pending.promise:valid();
    };
    const tokens=new TwitchTokens(tokenOptions(store,fetcher,revoked));
    try{
      const validation=tokens.validate();await tokens.exchange('new-authored-code');const current=store.tokenVault!.get(scope,'twitch'),session=store.sessions.issue(scope,'123','owner');
      if(result==='network-error')pending.reject(new Error('Authored network failure'));
      else pending.resolve(result==='unauthorized'?new Response(null,{status:401}):result==='unavailable'?new Response(null,{status:503}):result==='wrong-identity'?valid({user_id:'other'}):result==='missing-scopes'?valid({scopes:[]}):valid({expires_in:123}));
      expect(await validation).toBe(false);expect(store.tokenVault!.get(scope,'twitch')).toEqual(current);expect(store.sessions.verify(scope,session,'owner')).not.toBeNull();expect(tokens.status()).toMatchObject({connected:true,missingPermissions:[]});expect(revoked).not.toHaveBeenCalled();
    }finally{store.close();}
  });
  it('checks vault identity as well as the in-memory generation when another owner replaces credentials',async()=>{
    const store=fixture(),pending=deferred<Response>();store.tokenVault!.put(scope,'twitch',oldCredentials());const tokens=new TwitchTokens(tokenOptions(store,async()=>pending.promise));
    try{const validation=tokens.validate(),replacement={...oldCredentials(),accessToken:'external-new',refreshToken:'external-refresh'};store.tokenVault!.put(scope,'twitch',replacement);pending.resolve(valid());expect(await validation).toBe(false);expect(store.tokenVault!.get(scope,'twitch')).toEqual(replacement);}finally{store.close();}
  });
  it('lets an in-flight refresh finish after a current validation updates expiry metadata',async()=>{
    const store=fixture(),pendingGrant=deferred<Response>(),started=deferred<void>();store.tokenVault!.put(scope,'twitch',oldCredentials(0));
    const fetcher:typeof fetch=async url=>{if(String(url).endsWith('/token')){started.resolve();return pendingGrant.promise;}if(String(url).endsWith('/validate'))return valid();return new Response(null,{status:204});};
    const tokens=new TwitchTokens(tokenOptions(store,fetcher));
    try{const request=tokens.authorizedFetch('https://api.twitch.tv/authored');await started.promise;expect(await tokens.validate()).toBe(true);pendingGrant.resolve(Response.json({access_token:'new',refresh_token:'rotated'}));expect((await request).status).toBe(204);expect(store.tokenVault!.get(scope,'twitch')).toMatchObject({accessToken:'new',refreshToken:'rotated'});expect(tokens.status().connected).toBe(true);}finally{store.close();}
  });
  it.each([200,400])('does not let a superseded validation refresh grant (%s) overwrite or revoke a new exchange',async status=>{
    const store=fixture(),pendingGrant=deferred<Response>(),refreshStarted=deferred<void>(),revoked=vi.fn();store.tokenVault!.put(scope,'twitch',oldCredentials(0));
    const fetcher:typeof fetch=async(url,init)=>{
      if(String(url).endsWith('/token')){
        if(new URLSearchParams(String(init?.body)).get('grant_type')==='refresh_token'){refreshStarted.resolve();return pendingGrant.promise;}
        return Response.json({access_token:'new',refresh_token:'new-refresh'});
      }
      if(new Headers(init?.headers).get('Authorization')==='OAuth old')return new Response(null,{status:401});
      return valid();
    };
    const tokens=new TwitchTokens(tokenOptions(store,fetcher,revoked));
    try{const validation=tokens.validate();await refreshStarted.promise;await tokens.exchange('replacement-code');const current=store.tokenVault!.get(scope,'twitch');pendingGrant.resolve(status===200?Response.json({access_token:'stale-refresh-access',refresh_token:'stale-refresh-token'}):new Response(null,{status}));expect(await validation).toBe(false);expect(store.tokenVault!.get(scope,'twitch')).toEqual(current);expect(tokens.status()).toMatchObject({connected:true,missingPermissions:[]});expect(revoked).not.toHaveBeenCalled();}finally{store.close();}
  });
  it('still saves an ordinary current validation and revokes a current unauthorized session',async()=>{
    const store=fixture(),revoked=vi.fn();let accepted=true;store.tokenVault!.put(scope,'twitch',oldCredentials());const tokens=new TwitchTokens(tokenOptions(store,async()=>accepted?valid():new Response(null,{status:401}),revoked));
    try{expect(await tokens.validate()).toBe(true);expect(store.tokenVault!.get<{expiresAtMs:number}>(scope,'twitch')?.expiresAtMs).toBe(3700000);expect(tokens.status().connected).toBe(true);const session=store.sessions.issue(scope,'123','owner');accepted=false;await expect(tokens.validate()).rejects.toMatchObject({code:'reconnect_required'});expect(tokens.status().connected).toBe(false);expect(store.sessions.verify(scope,session,'owner')).toBeNull();expect(revoked).toHaveBeenCalledOnce();}finally{store.close();}
  });
  it.each(['disconnect','new-exchange','same-token-exchange'])('does not let a delayed second API 401 revoke authorization after %s',async intervention=>{
    const store=fixture(),retried=deferred<void>(),pending=deferred<Response>(),revoked=vi.fn();store.tokenVault!.put(scope,'twitch',oldCredentials());let calls=0;
    const fetcher:typeof fetch=async(url,init)=>{
      if(String(url).endsWith('/token')){const exchanging=new URLSearchParams(String(init?.body)).get('grant_type')==='authorization_code';return Response.json({access_token:exchanging&&intervention!=='same-token-exchange'?'exchanged':'refreshed',refresh_token:exchanging?'exchanged-refresh':'rotated-refresh'});}
      if(String(url).endsWith('/validate'))return valid();
      if(++calls===1)return new Response(null,{status:401});retried.resolve();return pending.promise;
    };
    const tokens=new TwitchTokens(tokenOptions(store,fetcher,revoked));
    try{
      const request=tokens.authorizedFetch('https://api.twitch.tv/authored');await retried.promise;
      if(intervention==='disconnect')tokens.disconnect();else await tokens.exchange('replacement-code');
      const current=store.tokenVault!.get(scope,'twitch'),session=intervention==='disconnect'?null:store.sessions.issue(scope,'123','owner');
      pending.resolve(new Response(null,{status:401}));await expect(request).rejects.toThrow('dispatch_fence_changed');expect(store.tokenVault!.get(scope,'twitch')).toEqual(current);expect(tokens.status().connected).toBe(intervention!=='disconnect');expect(revoked).toHaveBeenCalledTimes(intervention==='disconnect'?1:0);if(session)expect(store.sessions.verify(scope,session,'owner')).not.toBeNull();
    }finally{store.close();}
  });
  it('still revokes a current authorization after the refreshed token receives a second API 401',async()=>{
    const store=fixture(),revoked=vi.fn();store.tokenVault!.put(scope,'twitch',oldCredentials());const session=store.sessions.issue(scope,'123','owner');
    const fetcher:typeof fetch=async url=>String(url).endsWith('/token')?Response.json({access_token:'refreshed',refresh_token:'rotated'}):String(url).endsWith('/validate')?valid():new Response(null,{status:401});
    const tokens=new TwitchTokens(tokenOptions(store,fetcher,revoked));
    try{await expect(tokens.authorizedFetch('https://api.twitch.tv/authored')).rejects.toMatchObject({code:'reconnect_required'});expect(store.tokenVault!.get(scope,'twitch')).toBeNull();expect(store.sessions.verify(scope,session,'owner')).toBeNull();expect(revoked).toHaveBeenCalledOnce();}finally{store.close();}
  });
});

describe('transient token endpoint failures (review B1, B11)',()=>{
  it.each([429,408,503])('keeps the grant on a %s refresh and backs off, honouring Retry-After',async status=>{
    const store=fixture(),revoked=vi.fn();let now=100000,grants=0,limited=true;store.tokenVault!.put(scope,'twitch',oldCredentials(now+5000));const session=store.sessions.issue(scope,'123','owner');
    const fetcher:typeof fetch=async url=>{
      if(String(url).endsWith('/token')){grants++;return limited?new Response('{"status":429}',{status,headers:{'Retry-After':'5'}}):Response.json({access_token:'new',refresh_token:'rotated'});}
      if(String(url).endsWith('/validate'))return valid();
      return new Response(null,{status:204});
    };
    const tokens=new TwitchTokens({...tokenOptions(store,fetcher,revoked),now:()=>now});
    try{
      await expect(tokens.authorizedFetch('https://api.twitch.tv/authored')).rejects.toMatchObject({code:'provider_unavailable'});
      expect(store.tokenVault!.get(scope,'twitch')).toEqual(oldCredentials(105000));expect(revoked).not.toHaveBeenCalled();expect(store.sessions.verify(scope,session,'owner')).not.toBeNull();
      // Inside the Retry-After window the token endpoint is not called again.
      now+=4000;await expect(tokens.authorizedFetch('https://api.twitch.tv/authored')).rejects.toMatchObject({code:'provider_unavailable'});expect(grants).toBe(1);
      now+=1500;limited=false;expect((await tokens.authorizedFetch('https://api.twitch.tv/authored')).status).toBe(204);expect(grants).toBe(2);
      expect(store.tokenVault!.get(scope,'twitch')).toMatchObject({accessToken:'new',refreshToken:'rotated'});expect(tokens.status().connected).toBe(true);
    }finally{store.close();}
  });
  it('still revokes when the refresh token itself is rejected with 400',async()=>{
    const store=fixture(),revoked=vi.fn();store.tokenVault!.put(scope,'twitch',oldCredentials(0));
    const tokens=new TwitchTokens(tokenOptions(store,async url=>String(url).endsWith('/token')?new Response('{"status":400,"message":"Invalid refresh token"}',{status:400}):valid(),revoked));
    try{await expect(tokens.authorizedFetch('https://api.twitch.tv/authored')).rejects.toMatchObject({code:'reconnect_required'});expect(store.tokenVault!.get(scope,'twitch')).toBeNull();expect(revoked).toHaveBeenCalledOnce();}finally{store.close();}
  });
  it('hourly validation tries the refresh token before revoking on a 401',async()=>{
    const store=fixture(),revoked=vi.fn();store.tokenVault!.put(scope,'twitch',oldCredentials());
    const fetcher:typeof fetch=async(url,init)=>{
      if(String(url).endsWith('/token'))return Response.json({access_token:'renewed',refresh_token:'rotated'});
      return new Headers(init?.headers).get('Authorization')==='OAuth old'?new Response(null,{status:401}):valid();
    };
    const tokens=new TwitchTokens(tokenOptions(store,fetcher,revoked));
    try{expect(await tokens.validate()).toBe(true);expect(store.tokenVault!.get(scope,'twitch')).toMatchObject({accessToken:'renewed',refreshToken:'rotated'});expect(tokens.status().connected).toBe(true);expect(revoked).not.toHaveBeenCalled();}finally{store.close();}
  });
});
