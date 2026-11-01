import {describe,it,expect} from 'vitest';
import express from 'express';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {bindControlStore,createTwitchAuth,TWITCH_SCOPES} from '../../src/server/auth/index.js';
import {createStorage} from '../../src/server/storage/index.js';
import {apiErrorHandler} from '../../src/server/runtime/errors.js';
describe('OAuth and overlay session isolation',()=>{
  it('one-use state, denial, wrong account, expiry, overlay rotation and logout isolation',async()=>{
    let now=100000;let user='123';const scope={channelId:'123',runId:'live'};const storage=createStorage({path:':memory:',now:()=>now,encryptionKey:new Uint8Array(32).fill(3)});storage.repository.ensureChannel(scope,'channel');
    const service=createTwitchAuth({scope,clientId:'client',clientSecret:'secret',redirectUri:'https://localhost:4317/auth/twitch/callback',origin:'https://localhost:4317',sessionSecret:'secret',sessions:storage.sessions,tokenVault:storage.tokenVault!,control:bindControlStore(storage.repository,scope),now:()=>now,fetch:async url=>String(url).endsWith('/token')?Response.json({access_token:'access',refresh_token:'refresh'}):Response.json({client_id:'client',user_id:user,scopes:TWITCH_SCOPES,expires_in:3600})});
    const app=express();app.use(express.json());app.use(service.router);app.use('/owner',service.ownerRouter);app.use(apiErrorHandler);const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const start=async()=>{const r=await fetch(`${base}/api/auth/twitch/start?returnTo=https://evil.invalid`,{redirect:'manual'});return {state:new URL(r.headers.get('location')!).searchParams.get('state')!,cookie:r.headers.get('set-cookie')!.split(';')[0]};};
    const callback=(s:{state:string;cookie:string},tail='code=test')=>fetch(`${base}/auth/twitch/callback?state=${s.state}&${tail}`,{headers:{cookie:s.cookie},redirect:'manual'});
    try{
      const denied=await start();expect((await callback(denied,'error=access_denied')).headers.get('location')).toBe('/setup?auth=cancelled');expect((await callback(denied)).status).toBe(403);
      const wrong=await start();user='456';expect((await callback(wrong)).status).toBe(403);user='123';
      const expired=await start();now+=600001;expect((await callback(expired)).status).toBe(403);
      const mismatch=await start();expect((await callback({...mismatch,cookie:'__Host-previously-oauth='+'a'.repeat(43)})).status).toBe(403);
      const good=await callback(await start());expect(good.status).toBe(302);expect(good.headers.get('set-cookie')).toContain('HttpOnly');expect(good.headers.get('set-cookie')).toContain('Secure');
      const rotate=await fetch(`${base}/owner/overlay/rotate`,{method:'POST'});const {url}=await rotate.json() as {url:string};
      const overlay=await fetch(`${base}/api/overlay/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability:new URL(url).hash.slice(1)})});expect(overlay.status).toBe(200);
      const overlayCookie=overlay.headers.get('set-cookie')!.split(';')[0];
      expect(await service.auth.authenticate({headers:{cookie:overlayCookie}} as never,'owner')).toBeNull();expect(await service.auth.authenticate({headers:{cookie:overlayCookie}} as never,'overlay')).not.toBeNull();
      await fetch(`${base}/owner/overlay/rotate`,{method:'POST'});expect(await service.auth.authenticate({headers:{cookie:overlayCookie}} as never,'overlay')).toBeNull();
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));storage.close();}
  });
});
