import type { Scope } from '../../shared/contracts/index.js';
import type { TokenVault } from '../storage/auth.js';

export const TWITCH_SCOPES = ['user:read:chat', 'user:write:chat', 'clips:edit', 'channel:manage:clips', 'channel:moderate', 'moderation:read'] as const;
type Credentials = {accessToken: string; refreshToken: string; expiresAtMs: number; scopes: string[]};
type Validation = {client_id: string; user_id: string; scopes: string[]; expires_in: number};
export class TwitchAuthError extends Error {
  constructor(public readonly code: 'reconnect_required'|'wrong_identity'|'missing_permission'|'provider_unavailable', public readonly missing: string[] = []) { super(code); }
}
export class TwitchRequestCancelled extends Error {constructor(){super('dispatch_fence_changed');}}
export interface TokenOptions {scope: Scope; clientId: string; clientSecret: string; redirectUri: string; tokenVault: Pick<TokenVault,'get'|'put'|'disconnect'>; fetch?: typeof fetch; now?: () => number; markerEnabled?: boolean; onRevoked?: () => void}
export class TwitchTokens {
  private flight: Promise<Credentials> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private missing: string[] = [];
  private generation = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  readonly scopes: string[];
  constructor(private readonly options: TokenOptions) {
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now;
    this.scopes = [...TWITCH_SCOPES, ...(options.markerEnabled ? ['channel:manage:broadcast'] : [])];
    if (options.scope.runId !== 'live') throw new Error('Twitch authentication requires live scope');
  }
  status() { return {connected: this.connected, missingPermissions: [...this.missing], action: this.connected ? null : 'Reconnect Twitch'}; }
  private saved() {return this.options.tokenVault.get<Credentials>(this.options.scope,'twitch');}
  private revoke(): never {this.generation++; this.connected=false; this.options.tokenVault.disconnect(this.options.scope); this.options.onRevoked?.(); throw new TwitchAuthError('reconnect_required');}
  private async inspect(accessToken: string): Promise<Validation> {
    const response=await this.fetcher('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:`OAuth ${accessToken}`},signal:AbortSignal.timeout(15000)});
    if (response.status===401) throw new TwitchAuthError('reconnect_required');
    if (!response.ok) throw new TwitchAuthError('provider_unavailable');
    const value=await response.json() as Validation;
    if (value.client_id!==this.options.clientId || value.user_id!==this.options.scope.channelId) throw new TwitchAuthError('wrong_identity');
    this.missing=this.scopes.filter(scope=>!value.scopes.includes(scope));
    if(this.missing.length) throw new TwitchAuthError('missing_permission',this.missing);
    return value;
  }
  private async grant(params: URLSearchParams): Promise<Credentials> {
    params.set('client_id',this.options.clientId); params.set('client_secret',this.options.clientSecret);
    const response=await this.fetcher('https://id.twitch.tv/oauth2/token',{method:'POST',body:params,signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new TwitchAuthError(response.status>=500 ? 'provider_unavailable':'reconnect_required');
    const value=await response.json() as {access_token:string;refresh_token:string;expires_in:number};
    if(!value.access_token||!value.refresh_token) throw new TwitchAuthError('reconnect_required');
    const valid=await this.inspect(value.access_token);
    return {accessToken:value.access_token,refreshToken:value.refresh_token,expiresAtMs:this.now()+valid.expires_in*1000,scopes:valid.scopes};
  }
  async exchange(code:string) {
    const version=this.generation;
    const value=await this.grant(new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:this.options.redirectUri}));
    if(version!==this.generation) throw new TwitchAuthError('reconnect_required');
    this.options.tokenVault.put(this.options.scope,'twitch',value); this.connected=true;
  }
  private refresh(): Promise<Credentials> {
    if(this.flight) return this.flight;
    const saved=this.saved(); if(!saved) return Promise.reject(new TwitchAuthError('reconnect_required'));
    const version=this.generation;
    this.flight=(async()=>{try {
      const value=await this.grant(new URLSearchParams({grant_type:'refresh_token',refresh_token:saved.refreshToken}));
      if(version!==this.generation) throw new TwitchAuthError('reconnect_required');
      this.options.tokenVault.put(this.options.scope,'twitch',value); this.connected=true; return value;
    } catch(error) {if(error instanceof TwitchAuthError && error.code!=='provider_unavailable') return this.revoke(); throw error;} finally {this.flight=null;}})();
    return this.flight;
  }
  async validate() {
    const saved=this.saved(); if(!saved) {this.connected=false; return false;}
    try {const valid=await this.inspect(saved.accessToken); this.options.tokenVault.put(this.options.scope,'twitch',{...saved,expiresAtMs:this.now()+valid.expires_in*1000,scopes:valid.scopes}); this.connected=true; return true;}
    catch(error) {if(error instanceof TwitchAuthError && error.code==='reconnect_required' && saved.expiresAtMs<=this.now()+60000) {await this.refresh(); return true;}
      if(error instanceof TwitchAuthError && error.code!=='provider_unavailable') this.revoke(); throw error;}
  }
  async start() {await this.validate(); if(!this.timer) {this.timer=setInterval(()=>{void this.validate().catch(()=>{this.connected=false;});},3600000);this.timer.unref();}}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  disconnect(){this.generation++;this.connected=false;this.options.tokenVault.disconnect(this.options.scope);this.options.onRevoked?.();}
  async authorizedFetch(url: string, init: RequestInit = {}, beforeRequest?:()=>boolean): Promise<Response> {
    let saved=this.saved(); if(!saved) throw new TwitchAuthError('reconnect_required');
    if(saved.expiresAtMs<=this.now()+30000) saved=await this.refresh();
    const call=(token:string)=>{if(beforeRequest&&!beforeRequest())throw new TwitchRequestCancelled();return this.fetcher(url,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),Authorization:`Bearer ${token}`,'Client-Id':this.options.clientId},signal:init.signal ?? AbortSignal.timeout(15000)});};
    let response=await call(saved.accessToken);
    if(response.status===401) {const latest=this.saved();const renewed=latest && latest.accessToken!==saved.accessToken ? latest : await this.refresh(); response=await call(renewed.accessToken);if(response.status===401)this.revoke();}
    return response;
  }
}
