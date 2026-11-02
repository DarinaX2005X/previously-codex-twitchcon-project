import type { Scope } from '../../shared/contracts/index.js';
import type { TokenVault } from '../storage/auth.js';

export const TWITCH_SCOPES = ['user:read:chat', 'user:write:chat', 'clips:edit', 'channel:manage:clips', 'channel:moderate', 'moderation:read'] as const;
type Credentials = {accessToken: string; refreshToken: string; expiresAtMs: number; scopes: string[]};
type CredentialFence = {generation:number;revision:number;saved:Credentials|null};
type Validation = {client_id: string; user_id: string; scopes: string[]; expires_in: number};
export class TwitchAuthError extends Error {
  constructor(public readonly code: 'reconnect_required'|'wrong_identity'|'missing_permission'|'provider_unavailable', public readonly missing: string[] = [], public readonly retryAfterMs?: number) { super(code); }
}
/** Seconds or an HTTP date, capped so a hostile header cannot park refresh for long. */
function retryAfter(response:Response,now:number):number|undefined {
  const raw=response.headers.get('retry-after');if(!raw)return undefined;
  const value=/^\d+(\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw)-now;
  return Number.isFinite(value)?Math.max(0,Math.min(300000,value)):undefined;
}
export class TwitchRequestCancelled extends Error {constructor(){super('dispatch_fence_changed');}}
export interface TokenOptions {scope: Scope; clientId: string; clientSecret: string; redirectUri: string; tokenVault: Pick<TokenVault,'get'|'put'|'disconnect'>; fetch?: typeof fetch; now?: () => number; markerEnabled?: boolean; onRevoked?: () => void}
export class TwitchTokens {
  private flight: Promise<Credentials> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private missing: string[] = [];
  private generation = 0;
  private credentialRevision = 0;
  /** A failed refresh that kept the grant (rate limit, outage, network) waits before the token endpoint is tried again. */
  private refreshFailures = 0;
  private refreshRetryAt = 0;
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
  private fence():CredentialFence {return {generation:this.generation,revision:this.credentialRevision,saved:this.saved()};}
  private current(fence:CredentialFence,includeMetadata=true):boolean {
    if(fence.generation!==this.generation||fence.revision!==this.credentialRevision)return false;
    const value=this.saved(),saved=fence.saved;
    return !saved?!value:!!value&&value.accessToken===saved.accessToken&&value.refreshToken===saved.refreshToken&&(!includeMetadata||value.expiresAtMs===saved.expiresAtMs&&JSON.stringify(value.scopes)===JSON.stringify(saved.scopes));
  }
  private retain(value:Credentials,authorizationChanged=true){this.options.tokenVault.put(this.options.scope,'twitch',value);if(authorizationChanged){this.credentialRevision++;this.refreshFailures=0;this.refreshRetryAt=0;}this.missing=[];this.connected=true;}
  private revoke(): never {this.generation++; this.connected=false; this.options.tokenVault.disconnect(this.options.scope); this.options.onRevoked?.(); throw new TwitchAuthError('reconnect_required');}
  private async inspect(accessToken: string): Promise<Validation> {
    const response=await this.fetcher('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:`OAuth ${accessToken}`},signal:AbortSignal.timeout(15000)});
    if (response.status===401) throw new TwitchAuthError('reconnect_required');
    if (!response.ok) throw new TwitchAuthError('provider_unavailable');
    const value=await response.json() as Validation;
    if (value.client_id!==this.options.clientId || value.user_id!==this.options.scope.channelId) throw new TwitchAuthError('wrong_identity');
    const missing=this.scopes.filter(scope=>!value.scopes.includes(scope));
    if(missing.length) throw new TwitchAuthError('missing_permission',missing);
    return value;
  }
  private async grant(params: URLSearchParams): Promise<Credentials> {
    params.set('client_id',this.options.clientId); params.set('client_secret',this.options.clientSecret);
    const response=await this.fetcher('https://id.twitch.tv/oauth2/token',{method:'POST',body:params,signal:AbortSignal.timeout(15000)});
    // Only 400 (invalid grant/code) and 401 mean the authorization itself is dead; 429, 408 and the rest are transient.
    if(!response.ok) throw new TwitchAuthError(response.status===400||response.status===401?'reconnect_required':'provider_unavailable',[],retryAfter(response,this.now()));
    const value=await response.json() as {access_token:string;refresh_token:string;expires_in:number};
    if(!value.access_token||!value.refresh_token) throw new TwitchAuthError('reconnect_required');
    const valid=await this.inspect(value.access_token);
    return {accessToken:value.access_token,refreshToken:value.refresh_token,expiresAtMs:this.now()+valid.expires_in*1000,scopes:valid.scopes};
  }
  async exchange(code:string) {
    // A new authorization attempt supersedes older validation and grant responses.
    const version=++this.generation;
    try{
      const value=await this.grant(new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:this.options.redirectUri}));
      if(version!==this.generation) throw new TwitchAuthError('reconnect_required');
      this.retain(value);
    }catch(error){if(version===this.generation&&error instanceof TwitchAuthError&&error.code==='missing_permission')this.missing=[...error.missing];throw error;}
  }
  private refresh(): Promise<Credentials> {
    if(this.flight) return this.flight;
    const fence=this.fence(),saved=fence.saved; if(!saved) return Promise.reject(new TwitchAuthError('reconnect_required'));
    if(this.now()<this.refreshRetryAt) return Promise.reject(new TwitchAuthError('provider_unavailable'));
    this.flight=(async()=>{try {
      const value=await this.grant(new URLSearchParams({grant_type:'refresh_token',refresh_token:saved.refreshToken}));
      if(!this.current(fence,false)) throw new TwitchRequestCancelled();
      this.retain(value);return value;
    } catch(error) {if(!this.current(fence,false))throw new TwitchRequestCancelled();if(error instanceof TwitchAuthError && error.code!=='provider_unavailable'){if(error.code==='missing_permission')this.missing=[...error.missing];return this.revoke();}
      // Keep the grant and back off: 1 s doubling to 60 s, or longer when Twitch asks for it.
      this.refreshFailures++;this.refreshRetryAt=this.now()+Math.max(error instanceof TwitchAuthError?error.retryAfterMs??0:0,Math.min(60000,1000*2**(this.refreshFailures-1)));
      throw error;} finally {this.flight=null;}})();
    return this.flight;
  }
  async validate() {
    const fence=this.fence(),saved=fence.saved; if(!saved) {this.connected=false; return false;}
    try {const valid=await this.inspect(saved.accessToken);if(!this.current(fence))return false;this.retain({...saved,expiresAtMs:this.now()+valid.expires_in*1000,scopes:valid.scopes},false);return true;}
    catch(error) {
      // Old successes and failures have no authority over the current authorization.
      if(!this.current(fence))return false;
      // A rejected access token may still be renewable; only a rejected refresh revokes the grant.
      if(error instanceof TwitchAuthError && error.code==='reconnect_required') {
        try{await this.refresh();return this.connected;}catch(refreshError){if(refreshError instanceof TwitchRequestCancelled)return false;if(this.current(fence)&&refreshError instanceof TwitchAuthError&&refreshError.code!=='provider_unavailable')this.connected=false;throw refreshError;}
      }
      this.connected=false;
      if(error instanceof TwitchAuthError && error.code!=='provider_unavailable'){if(error.code==='missing_permission')this.missing=[...error.missing];this.revoke();}throw error;
    }
  }
  async start() {await this.validate(); if(!this.timer) {this.timer=setInterval(()=>{void this.validate().catch(()=>{});},3600000);this.timer.unref();}}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  disconnect(){this.generation++;this.connected=false;this.refreshFailures=0;this.refreshRetryAt=0;this.options.tokenVault.disconnect(this.options.scope);this.options.onRevoked?.();}
  async authorizedFetch(url: string, init: RequestInit = {}, beforeRequest?:()=>boolean): Promise<Response> {
    let saved=this.saved(); if(!saved) throw new TwitchAuthError('reconnect_required');
    if(saved.expiresAtMs<=this.now()+30000) saved=await this.refresh();
    const call=(token:string)=>{if(beforeRequest&&!beforeRequest())throw new TwitchRequestCancelled();return this.fetcher(url,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),Authorization:`Bearer ${token}`,'Client-Id':this.options.clientId},signal:init.signal ?? AbortSignal.timeout(15000)});};
    let response=await call(saved.accessToken);
    if(response.status===401) {
      const latest=this.saved(),renewed=latest&&latest.accessToken!==saved.accessToken?latest:await this.refresh(),retried=this.fence();
      response=await call(renewed.accessToken);
      if(response.status===401){
        if(!this.current(retried,false)||retried.saved?.accessToken!==renewed.accessToken||retried.saved.refreshToken!==renewed.refreshToken)throw new TwitchRequestCancelled();
        this.revoke();
      }
    }
    return response;
  }
}
