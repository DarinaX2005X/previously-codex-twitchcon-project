import {TwitchRequestCancelled,type TwitchTokens} from '../auth/tokens.js';
export class HelixError extends Error {constructor(public readonly status:number,public readonly code:string,public readonly retryAfterMs=0){super(code);}}
export type TwitchStream={id:string;user_id:string;started_at:string;title:string;game_name:string};
export type BannedUser={user_id:string;created_at:string;expires_at:string};
export type TwitchClip={id:string;broadcaster_id:string;creator_id:string;created_at:string;duration:number;video_id:string;vod_offset:number|null;url:string;embed_url:string;title:string};
export class TwitchHelix {
  constructor(readonly channelId:string,private readonly tokens:Pick<TwitchTokens,'authorizedFetch'>,private readonly base='https://api.twitch.tv/helix'){}
  async request<T>(path:string,init?:RequestInit,beforeRequest?:()=>boolean):Promise<T>{
    if(beforeRequest&&!beforeRequest())throw new TwitchRequestCancelled();
    const response=await this.tokens.authorizedFetch(`${this.base}/${path}`,init,beforeRequest);
    if(!response.ok)throw new HelixError(response.status,response.status===403?'permission_or_disabled':response.status===404?'offline_or_unavailable':'twitch_request_failed',Number(response.headers.get('Retry-After')??0)*1000);
    return (response.status===204 ? null:await response.json()) as T;
  }
  async currentStream(){return (await this.request<{data:TwitchStream[]}>(`streams?user_id=${encodeURIComponent(this.channelId)}`)).data[0]??null;}
  async bannedUsers(onPage:(users:BannedUser[])=>void|Promise<void>,userId?:string){
    let cursor='';const seen=new Set<string>();
    do {const query=new URLSearchParams({broadcaster_id:this.channelId,first:'100'});if(cursor)query.set('after',cursor);if(userId)query.set('user_id',userId);
      const page=await this.request<{data:BannedUser[];pagination?:{cursor?:string}}>(`moderation/banned?${query}`);await onPage(page.data);cursor=page.pagination?.cursor??'';
      if(cursor&&seen.has(cursor))throw new HelixError(502,'pagination_cycle');if(cursor)seen.add(cursor);
    }while(cursor);
  }
  subscribe(type:string,version:string,condition:Record<string,string>,sessionId:string){return this.request('eventsub/subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,version,condition,transport:{method:'websocket',session_id:sessionId}})});}
  async sendChat(message:string,beforeRequest?:()=>boolean){if([...message].length>500)throw new Error('Chat exceeds 500 characters');return (await this.request<{data:{message_id:string;is_sent:boolean;drop_reason?:{code:string;message:string}|null}[]}>('chat/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({broadcaster_id:this.channelId,sender_id:this.channelId,message})},beforeRequest)).data[0];}
  async createClip(beforeRequest?:()=>boolean){return (await this.request<{data:{id:string;edit_url:string}[]}>(`clips?broadcaster_id=${encodeURIComponent(this.channelId)}`,{method:'POST'},beforeRequest)).data[0];}
  async getClip(id:string){return (await this.request<{data:TwitchClip[]}>(`clips?id=${encodeURIComponent(id)}`)).data[0]??null;}
  async downloadUrl(id:string){const q=new URLSearchParams({broadcaster_id:this.channelId,editor_id:this.channelId,clip_id:id});const value=await this.request<{data:{clip_id:string;landscape_download_url:string|null}[]}>(`clips/downloads?${q}`);return value.data.find(item=>item.clip_id===id)?.landscape_download_url??null;}
  async marker(description:string,beforeRequest?:()=>boolean){return this.request('streams/markers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:this.channelId,description:[...description].slice(0,140).join('')})},beforeRequest);}
  /** Get Clips is popularity ordered. Sort this bounded 30-day sample locally; never call its first item newest. */
  async previousClips(before:string,now=Date.now()):Promise<TwitchClip[]>{
    const query=new URLSearchParams({broadcaster_id:this.channelId,first:'100',started_at:new Date(now-30*86400000).toISOString(),ended_at:new Date(now).toISOString()});
    const page=await this.request<{data:TwitchClip[]}>(`clips?${query}`);
    return page.data.slice(0,100).filter(clip=>clip.broadcaster_id===this.channelId&&Date.parse(clip.created_at)<Date.parse(before)).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  }
}
/** This app token is short-lived bootstrap only; it never becomes an owner session. */
export async function resolveConfiguredChannel(options:{clientId:string;clientSecret:string;login:string;fetch?:typeof fetch}){
  if(!/^[a-z0-9_]{1,25}$/.test(options.login))throw new Error('Configure a Twitch channel login');
  const fetcher=options.fetch??fetch;
  const grant=await fetcher('https://id.twitch.tv/oauth2/token',{method:'POST',body:new URLSearchParams({client_id:options.clientId,client_secret:options.clientSecret,grant_type:'client_credentials'}),signal:AbortSignal.timeout(15000)});
  if(!grant.ok)throw new HelixError(grant.status,'channel_resolution_failed');
  const {access_token}=await grant.json() as {access_token:string};
  const response=await fetcher(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(options.login)}`,{headers:{Authorization:`Bearer ${access_token}`,'Client-Id':options.clientId},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new HelixError(response.status,'channel_resolution_failed');
  const user=(await response.json() as {data:{id:string;login:string;display_name:string}[]}).data[0];
  if(!user||!/^\d+$/.test(user.id)||user.login!==options.login)throw new Error('Configured Twitch channel was not found');
  return {id:user.id,login:user.login,displayName:user.display_name};
}
