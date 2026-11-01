import {describe,it,expect,vi} from 'vitest';
import {TwitchTokens,TWITCH_SCOPES} from '../../src/server/auth/tokens.js';
import {createStorage} from '../../src/server/storage/index.js';
const scope={channelId:'123',runId:'live'};
function fixture(){const storage=createStorage({path:':memory:',now:()=>100000,encryptionKey:new Uint8Array(32).fill(9)});storage.repository.ensureChannel(scope,'channel');return storage;}
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
