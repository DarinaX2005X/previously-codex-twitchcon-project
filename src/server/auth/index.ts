import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {Router, type Request} from 'express';
import type {SessionStore} from '../storage/auth.js';
import {ApiError} from '../runtime/errors.js';
import {csrfToken, requireRole, type AuthenticationPort, type Role} from '../runtime/security.js';
import {TwitchTokens, TwitchAuthError, type TokenOptions} from './tokens.js';
import type {ControlStore} from './control.js';
export * from './tokens.js';
export {bindControlStore,type ControlStore} from './control.js';
const names={owner:'__Host-previously-owner',overlay:'__Host-previously-overlay',demo:'__Host-previously-demo'};
const cookieOptions={httpOnly:true,secure:true,sameSite:'lax' as const,path:'/'};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function cookie(req:Request,name:string) {return req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1) ?? '';}
export interface AuthOptions extends TokenOptions {origin:string;sessionSecret:string;sessions:Pick<SessionStore,'issue'|'verify'|'logout'|'revokeRole'>;control:ControlStore;onOverlayRotated?:()=>void;onAuthorized?:()=>void|Promise<void>;onDisconnect?:()=>void|Promise<void>}
export function createTwitchAuth(options:AuthOptions) {
  const now=options.now ?? Date.now;
  const redirect=new URL(options.redirectUri);
  if(redirect.protocol!=='https:'||redirect.origin!==options.origin||redirect.pathname!=='/auth/twitch/callback'||redirect.search||redirect.hash) throw new Error('OAuth requires the exact local HTTPS callback');
  const tokens=new TwitchTokens({...options,onRevoked:()=>{options.onRevoked?.();void options.onDisconnect?.();}});
  const auth:AuthenticationPort={authenticate(req,role:Role){const id=cookie(req,names[role]);if(!id)return null;const found=options.sessions.verify(options.scope,id,role);return found ? {...options.scope,role,actorId:found.actorId,sessionId:id,expiresAtMs:found.expiresAtMs}:null;}};
  const router=Router(),ownerRouter=Router();
  router.get('/api/auth/twitch/start',(req,res)=>{
    const returnTo=typeof req.query.returnTo==='string' && ['/setup','/dock','/foundation'].includes(req.query.returnTo) ? req.query.returnTo:'/setup';
    const state=randomBytes(32).toString('base64url'); options.control.put(`oauth:${hash(state)}`,{returnTo},now()+600000);
    res.cookie('__Host-previously-oauth',state,{...cookieOptions,maxAge:600000});
    const url=new URL('https://id.twitch.tv/oauth2/authorize');url.search=new URLSearchParams({client_id:options.clientId,redirect_uri:options.redirectUri,response_type:'code',scope:tokens.scopes.join(' '),state}).toString();res.redirect(url.href);
  });
  router.get('/auth/twitch/callback',async(req,res,next)=>{try {
    const state=typeof req.query.state==='string'?req.query.state:'';const expected=cookie(req,'__Host-previously-oauth');
    if(!/^[\w-]{43}$/.test(state)||state.length!==expected.length||!timingSafeEqual(Buffer.from(state),Buffer.from(expected))) throw new ApiError(403,'oauth_state','The sign-in request expired. Start again.');
    const pending=options.control.take<{returnTo:string}>(`oauth:${hash(state)}`);res.clearCookie('__Host-previously-oauth',cookieOptions);
    if(!pending)throw new ApiError(403,'oauth_state','The sign-in request expired. Start again.');
    if(req.query.error){res.redirect(`${pending.returnTo}?auth=cancelled`);return;}
    if(typeof req.query.code!=='string'||req.query.code.length>2048)throw new ApiError(400,'oauth_code','The sign-in response is incomplete.');
    await tokens.exchange(req.query.code);await options.onAuthorized?.();
    const id=options.sessions.issue(options.scope,options.scope.channelId,'owner');res.cookie(names.owner,id,{...cookieOptions,maxAge:604800000});res.redirect(pending.returnTo);
  }catch(error){if(error instanceof TwitchAuthError)next(new ApiError(error.code==='wrong_identity'?403:401,error.code,error.code==='wrong_identity'?'Sign in with the configured channel account.':'Reconnect Twitch to continue.'));else next(error);}});
  router.post('/api/auth/logout',requireRole('owner',auth,options.sessionSecret,now),(req,res)=>{options.sessions.logout(options.scope,cookie(req,names.owner));res.clearCookie(names.owner,cookieOptions);res.sendStatus(204);});
  router.post('/api/overlay/session',(req,res,next)=>{
    const secret=req.body?.capability;const saved=options.control.get<{hash:string;version:number}>('overlay:capability');
    if(typeof secret!=='string'||!/^[\w-]{43}$/.test(secret)||!saved||!timingSafeEqual(Buffer.from(hash(secret)),Buffer.from(saved.hash))) {next(new ApiError(403,'overlay_capability','This overlay link is no longer valid.'));return;}
    const id=options.sessions.issue(options.scope,`overlay:${saved.version}`,'overlay');res.cookie(names.overlay,id,{...cookieOptions,maxAge:604800000});res.json({connected:true,csrfToken:csrfToken(options.sessionSecret,id)});
  });
  ownerRouter.get('/twitch/status',(_req,res)=>res.json(tokens.status()));
  ownerRouter.post('/twitch/disconnect',(_req,res)=>{tokens.disconnect();res.clearCookie(names.owner,cookieOptions);res.sendStatus(204);});
  ownerRouter.post(['/overlay-key','/overlay/rotate'],(req,res,next)=>{
    const previous=options.control.get<{version:number}>('overlay:capability');
    if(previous&&req.path==='/overlay-key'&&req.body?.rotate!==true){next(new ApiError(409,'overlay_rotation_required','The existing link cannot be recovered. Rotate the link to create a new one.'));return;}
    const secret=randomBytes(32).toString('base64url');
    options.control.put('overlay:capability',{hash:hash(secret),version:(previous?.version??0)+1});options.sessions.revokeRole(options.scope,'overlay');options.onOverlayRotated?.();res.json({url:`${options.origin}/overlay#${secret}`});
  });
  return {auth,router,ownerRouter,tokens,start:()=>tokens.start(),stop:()=>tokens.stop(),status:()=>tokens.status()};
}
