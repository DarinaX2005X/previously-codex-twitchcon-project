import {createHash} from 'node:crypto';
import {Router} from 'express';
import type {DomainEffect,DomainMedia,DomainState} from '../../core/types.js';
import type {Channel,Clock,EventEnvelope,Moment,PublicSnapshot,Scope,Session,VersionRef} from '../../shared/contracts/index.js';
import {bindControlStore,createTwitchAuth,type AuthOptions} from '../auth/index.js';
import type {PrivateMediaCache,MediaDescriptor} from '../media/cache.js';
import {TwitchBanSync,TwitchEffects,TwitchEventSub,TwitchHelix,composeReply,parseCommand,type ChatCommand,type ConnectionState,type EffectContext,type EventSubOptions,type TwitchClip,type TwitchStream,type MarkerContext,type MarkerResult} from '../twitch/index.js';
import type {RuntimeConfig} from './config.js';
import type {RuntimeStorage,StoryEngine} from './engine.js';
import {ApiError} from './errors.js';
import type {RevisionStream} from './updates.js';

type EnginePort=Pick<StoryEngine,'state'|'dispatch'|'ingest'|'observeStream'|'resolveSession'|'activeSessionId'|'allowed'|'setStatus'>&Partial<Pick<StoryEngine,'ingestBatch'>>;
type EventSubPort=Pick<TwitchEventSub,'start'|'stop'>;
type ClipContext=EffectContext&{momentId?:string;key?:string;publicationRevision?:number|null;previousApproved?:boolean};
type PreviousSelection={clip:TwitchClip;status:'candidate'|'preparing'|'ready'|'unavailable'|'rejected';sessionId:string|null;reason?:string};
type PreviousPermission={id:string;revision:number;selectionRevision:number;clip:TwitchClip;mediaId:string;approved:boolean;state:'queued'|'running'|'ready'|'failed'|'revoked';leaseUntilMs:number|null;durationMs:number|null;attachments:{sessionId:string;mediaId:string}[]};
type Gap={since:number;until:number|null};
export interface TwitchRuntimeOptions {
  config:Pick<RuntimeConfig,'twitch'|'origin'|'sessionSecret'|'publicOrigin'>;
  scope:Scope;channel:Channel;storage:RuntimeStorage;engine:EnginePort;updates:RevisionStream;clock:Clock;
  media?:Pick<PrivateMediaCache,'prepare'|'revoke'|'alias'>;
  markerEnabled?:boolean;publicUrl?:string;
  fetch?:typeof fetch;helix?:TwitchHelix;
  onPrivacyBlocked?:(blocked:boolean)=>void;
  eventSubFactory?:(options:EventSubOptions)=>EventSubPort;
  authFactory?:(options:AuthOptions)=>ReturnType<typeof createTwitchAuth>;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const clamp=(value:number)=>Math.max(0,Math.min(172800000,value));
const unique=(refs:VersionRef[])=>[...new Map(refs.map(ref=>[`${ref.id}:${ref.revision}`,ref])).values()];

/** Composition only: domain state remains in StoryEngine/SQLite, and all pending effects use durable work. */
export function createTwitchRuntime(options:TwitchRuntimeOptions) {
  const {config,scope,channel,storage,engine,updates,clock}=options;
  if(scope.runId!=='live'||scope.channelId!==channel.id||!/^\d+$/.test(channel.id))throw new Error('Twitch runtime requires the configured numeric live channel');
  if(!config.twitch.clientId||!config.twitch.clientSecret||!config.sessionSecret||!storage.tokenVault)throw new Error('Complete Twitch and local session configuration before constructing the integration');
  const control=bindControlStore(storage.repository,scope),repository=storage.repository;
  let running=false,tickBusy=false,networkStarting:Promise<void>|null=null,previousBusy=false,tickFlight:Promise<void>|null=null;
  const inFlightIngest=new Set<string>();
  const retryableChatIngest=new Set<string>();
  let connection:{state:ConnectionState;quotesReady:boolean;reason?:string;privacyBlocked:boolean}={state:'disconnected',quotesReady:false,privacyBlocked:false};
  let lastFailure:string|null=null;
  const publicUrl=options.publicUrl??config.publicOrigin;
  const permissionId=(clipId:string)=>`previous:${digest(clipId).slice(0,32)}`;
  const permissionKey=(id:string)=>`twitch:previous-permission:${id}`;
  const permissions=()=>control.get<string[]>('twitch:previous-permissions')??[];
  const revokePermission=(clipId:string)=>{
    const id=permissionId(clipId),permission=control.get<PreviousPermission>(permissionKey(id));
    if(permission&&permission.state!=='revoked')control.put(permissionKey(id),{...permission,revision:permission.revision+1,state:'revoked',approved:false,leaseUntilMs:null});
    control.put(`twitch:clip-block:${clipId}`,true);
    const settings=repository.getSettings(scope);if(settings.earlyWelcomeClipId===clipId)repository.updateSettings(scope,settings.revision,{earlyWelcomeClipId:null});
  };
  const sessionPages=function*():Generator<Session>{
    let cursor:{startedAt:string;id:string}|undefined;
    for(;;){const rows=repository.listSessions(scope,{limit:50,cursor});for(const row of rows)yield row;if(rows.length<50)return;const last=rows.at(-1)!;cursor={startedAt:last.startedAt,id:last.id};}
  };
  const liveId=()=>{let found:Session|null=null;for(const session of sessionPages())if(session.status==='live'&&(!found||session.startedAt>found.startedAt))found=session;return found?.id??null;};
  const setFailure=(message:string)=>{lastFailure=message;engine.setStatus('chat',{state:'error',lastObservedAt:clock.iso(),message,action:'Reconnect Twitch'});};
  const mutateAcrossSessions=async(actorId:string,throughAt:string|null)=>{
    for(const session of sessionPages()){
      if(throughAt&&Date.parse(session.startedAt)>Date.parse(throughAt))continue;
      const throughMs=throughAt?clamp(Math.min(Date.parse(throughAt),session.endedAt?Date.parse(session.endedAt):Infinity)-Date.parse(session.startedAt)):null;
      const state=engine.state(session.id);
      if(throughMs===null&&!state.bannedActors.includes(actorId))continue;
      const requestBody={operation:throughMs===null?'twitch.unban':'twitch.ban',actorId,throughMs};
      await engine.dispatch(session.id,throughMs===null?{type:'unban',actorId}:{type:'ban',actorId,throughMs},{idempotencyKey:`twitch-moderation:${digest([session.id,requestBody])}`,requestBody});
    }
  };
  const bans=new TwitchBanSync({control,helix:options.helix??{bannedUsers:async(page,userId)=>helix.bannedUsers(page,userId)},now:clock.now.bind(clock),onBlocked:(actorId,throughAt)=>mutateAcrossSessions(actorId,throughAt)});
  const safeRefs=(state:DomainState,refs:VersionRef[]):boolean=>{
    const pending=[...refs],seen=new Set<string>();
    while(pending.length){if(seen.size>1000)return false;const ref=pending.pop()!;if(seen.has(ref.id))continue;seen.add(ref.id);
      const source=state.sources.find(source=>source.id===ref.id)??repository.getSource(scope,ref.id);
      if(source){if(source.status!=='active'||source.revision!==ref.revision)return false;if(source.kind==='chat'){
        if(!source.actorId||!bans.allows(source.actorId))return false;
        const absolute=Date.parse(repository.getSession(scope,source.sessionId).startedAt)+source.endMs;
        if(absolute<=(control.get<number>('twitch:chat-cleared-through')??-Infinity))return false;
      }continue;}
      const node=state.nodes[ref.id];if(!node||!node.active||node.revision!==ref.revision)return false;pending.push(...node.supports,...node.exposedTo);
    }return true;
  };
  const allowed=(input:EffectContext&{kind:string;actorId?:string}):boolean=>{
    if(!running||!authService.status().connected||!engine.allowed(input))return false;
    try{
      const state=engine.state(input.sessionId),extended=input as ClipContext;
      if(!safeRefs(state,input.dependencyRefs))return false;
      if(extended.momentId&&!state.moments.some(moment=>moment.id===extended.momentId))return false;
      if(input.actorId&&!bans.allows(input.actorId))return false;
      if(['chat','clip','marker'].includes(input.kind)){
        if(connection.state!=='active'||!connection.quotesReady||!bans.ready()||state.session.status!=='live'||liveId()!==input.sessionId||state.settings.listeningPaused)return false;
        if(input.kind==='chat'&&extended.publicationRevision!==undefined&&(state.published?.revision??null)!==extended.publicationRevision)return false;
        if(input.kind==='clip'&&!state.settings.autoClips)return false;
        if(input.kind==='marker'&&(!options.markerEnabled||state.session.twitchStreamId!==(input as EffectContext&{streamId?:string}).streamId))return false;
      }
      if(input.kind==='previous.clip'&&!state.session.endedAt&&state.session.status!=='live')return false;
      return true;
    }catch{return false;}
  };
  const mediaId=(input:ClipContext,clipId?:string)=>input.momentId?`moment-media:${digest([input.sessionId,input.momentId]).slice(0,32)}`:`previous-media:${digest([input.sessionId,clipId]).slice(0,32)}`;
  const revokeMedia=async(id:string,clipId?:string)=>{if(clipId)revokePermission(clipId);await options.media?.revoke(id);};
  const onClip=async(input:EffectContext&{clip:TwitchClip|null;status:'pending'|'ready'|'unavailable'|'revoked';reason?:string;previousSession?:boolean})=>{
    const extended=input as ClipContext&typeof input,id=mediaId(extended,input.clip?.id);
    if(input.previousSession){const selection=control.get<PreviousSelection>('twitch:previous');if(selection?.clip.id===input.clip?.id)control.put('twitch:previous',{...selection,status:input.status==='ready'?'ready':input.status==='pending'?'preparing':'unavailable',reason:input.reason});}
    if(input.status==='revoked'){await revokeMedia(id,input.clip?.id);return;}
    if(!engine.allowed(input)){if(input.clip)revokePermission(input.clip.id);await options.media?.revoke(id);return;}
    const prepared=control.get<{durationMs:number}>(`twitch:media:${id}`);
    const state=engine.state(input.sessionId);
    const media:DomainMedia={id,revision:1,momentId:extended.momentId??null,refs:input.dependencyRefs,captureStartMs:input.captureStartMs??0,captureEndMs:input.captureEndMs??0,durationMs:prepared?.durationMs??Math.round((input.clip?.duration??0)*1000),state:input.status,kind:'video',previousSession:Boolean(input.previousSession),ownerApproved:input.previousSession?extended.previousApproved===true:true,...(input.clip?{clipId:input.clip.id,manageUrl:'https://dashboard.twitch.tv/content/clips',clip:{id:input.clip.id,url:input.clip.url,embedUrl:input.clip.embed_url}}:{})};
    if(media.momentId&&!state.moments.some(moment=>moment.id===media.momentId)){await revokeMedia(id,input.clip?.id);return;}
    await engine.dispatch(input.sessionId,{type:'media',media,privacyEpoch:input.privacyEpoch});
  };
  const stopNetwork=async()=>{bans.stop();await eventSub.stop();};
  const connect=async()=>{
    if(!running||!authService.status().connected)return;
    if(networkStarting)return networkStarting;
    networkStarting=eventSub.start().finally(()=>{networkStarting=null;});await networkStarting;
  };
  const authService=(options.authFactory??createTwitchAuth)({scope,clientId:config.twitch.clientId,clientSecret:config.twitch.clientSecret,redirectUri:config.twitch.redirectUri,origin:config.origin,sessionSecret:config.sessionSecret,tokenVault:storage.tokenVault,sessions:storage.sessions,control,now:clock.now.bind(clock),fetch:options.fetch,markerEnabled:options.markerEnabled,onAuthorized:connect,onDisconnect:()=>{void stopNetwork().catch(()=>setFailure('Twitch is disconnected. Reconnect to continue.'));updates.revoke(principal=>principal.channelId===scope.channelId&&principal.runId===scope.runId);},onOverlayRotated:()=>updates.revoke(principal=>principal.channelId===scope.channelId&&principal.runId===scope.runId&&principal.role==='overlay')});
  const helix=options.helix??new TwitchHelix(channel.id,authService.tokens);
  const onMarker=(input:MarkerContext,result:MarkerResult)=>{
    control.put(`twitch:marker:${input.sessionId}:${input.momentId}`,{...result,at:clock.iso(),expiresAtMs:input.expiresAtMs},clock.now()+7*86400000);
    updates.publish({...scope,event:'snapshot.changed',data:{sessionId:input.sessionId,revision:engine.state(input.sessionId).revision}});
  };
  const markerStatus=(sessionId:string|null=liveId())=>({enabled:Boolean(options.markerEnabled),sessionId,items:sessionId?engine.state(sessionId).moments.map(moment=>{
    const saved=control.get<MarkerResult&{at:string;expiresAtMs:number}>(`twitch:marker:${sessionId}:${moment.id}`);
    // A process may die after sending but before persisting confirmation. Never leave that as queued forever.
    const result=saved?.status==='queued'&&saved.expiresAtMs<=clock.now()?{...saved,status:'unknown_outcome' as const,reason:'marker_not_confirmed'}:saved;
    return {momentId:moment.id,timecodeMs:moment.endMs,...(result??{status:'unavailable' as const,reason:options.markerEnabled?'marker_not_queued':'marker_disabled'})};
  }):[]});
  const effects=new TwitchEffects({scope,helix,repository,control,now:clock.now.bind(clock),allowed,
    prepareMedia:async input=>{if(!options.media)throw new Error('private_media_unavailable');const extended=input as ClipContext&typeof input;const clipId=input.id.startsWith('clip:')?input.id.slice(5):undefined;const id=mediaId(extended,clipId);const result=await options.media.prepare({...input,id});control.put(`twitch:media:${id}`,{durationMs:result.durationMs});return result;},
    onClip,onMarker,previousPermitted:clip=>clip.broadcaster_id===channel.id&&!control.get(`twitch:clip-block:${clip.id}`),
    onResult:(_id,result)=>{if(result.status==='unknown_outcome')lastFailure='Twitch did not confirm an external action. It will not be sent again automatically.';},
  });
  const refreshPrevious=async()=>{
    if(previousBusy||!running||!authService.status().connected)return;previousBusy=true;
    try{const id=liveId();const before=id?repository.getSession(scope,id).startedAt:clock.iso();const candidate=await effects.previousCandidate(before);const current=control.get<PreviousSelection>('twitch:previous');
      if(!running)return;
      if(candidate){if(current?.clip.id!==candidate.id||current.status==='candidate')control.put('twitch:previous',{clip:candidate,status:'candidate',sessionId:null} satisfies PreviousSelection);}
      else if(!current||current.status==='candidate')control.delete('twitch:previous');
      control.put('twitch:previous-checked',clock.now());
    }catch{lastFailure='Previous clips could not be checked. Retry from Twitch setup.';}finally{previousBusy=false;}
  };
  const observeStream=async(stream:TwitchStream|null,occurredAt:string,streamId?:string)=>{
    if(!running)return;
    if(stream){
      for(const session of sessionPages())if(session.status==='live'&&session.twitchStreamId!==stream.id){repository.cancelSessionEffects(scope,session.id);await engine.observeStream(null,stream.started_at,session.twitchStreamId??undefined);}
    }
    await engine.observeStream(stream,occurredAt,streamId);
    if(!stream){const id=streamId?engine.resolveSession(occurredAt,streamId)?.id:engine.resolveSession(occurredAt)?.id;if(id)repository.cancelSessionEffects(scope,id);}
    if(!control.get<number>('twitch:previous-checked')||clock.now()-(control.get<number>('twitch:previous-checked')??0)>300000)await refreshPrevious();
    if(stream)await attachApproved(`stream_${stream.id}`);
  };
  const onStatus=(state:ConnectionState,detail:{quotesReady:boolean;gapSince:string|null;reason?:string;privacyBlocked?:boolean})=>{
    const wasBlocked=connection.privacyBlocked;
    connection={state,quotesReady:detail.quotesReady,reason:detail.reason,privacyBlocked:detail.privacyBlocked===true};
    if(wasBlocked!==connection.privacyBlocked)options.onPrivacyBlocked?.(connection.privacyBlocked);
    try{
      if(connection.privacyBlocked)bans.stop();
      else if(!detail.quotesReady)bans.suspend();
      else if(state==='active'&&running)bans.start();
      if(state==='gap')control.put('twitch:gap',{since:control.get<Gap>('twitch:gap')?.since??Date.parse(detail.gapSince??clock.iso()),until:null} satisfies Gap);
      if(state==='active'){const gap=control.get<Gap>('twitch:gap');if(gap&&gap.until===null)control.put('twitch:gap',{...gap,until:clock.now()});}
    }catch{lastFailure='Twitch safety recovery is waiting for local storage.';}
    engine.setStatus('chat',{state:state==='active'&&detail.quotesReady?'ready':state==='gap'?'delayed':state==='revoked'?'error':state==='disconnected'?'disconnected':'connecting',lastObservedAt:clock.iso(),message:state==='gap'?'Chat coverage has a gap. Reconnecting and checking bans.':state==='revoked'?'Twitch permissions changed. Reconnect Twitch.':state==='disconnected'?'Twitch is disconnected.':state==='active'?null:'Connecting Twitch and checking channel restrictions.',action:state==='revoked'||state==='disconnected'?'Reconnect Twitch':null});
    if(state==='revoked')lastFailure='Twitch permissions changed. Reconnect Twitch.';
    if(state==='revoked'&&detail.reason==='authorization_revoked')authService.tokens.disconnect();
  };
  const safeReply=(state:DomainState,command:ChatCommand):{snapshot:PublicSnapshot|null;refs:VersionRef[];blocked:boolean}=>{
    const snapshot=state.published?structuredClone(state.published):null;if(!snapshot)return {snapshot:null,refs:[],blocked:false};
    const refs:VersionRef[]=[];const blocked=command.kind==='lore'&&repository.isTermBlocked(scope,state.session.id,command.term);
    if(command.kind==='lore'){
      const wanted=snapshot.lore.find(lore=>lore.term.normalize('NFKC').toLowerCase()===command.term.toLowerCase());const owned=wanted&&state.lore.find(lore=>lore.id===wanted.id);
      if(owned&&!blocked)refs.push({id:owned.id,revision:owned.revision});else snapshot.lore=[];
    }else{
      snapshot.chapters=snapshot.chapters.slice(-2).filter(chapter=>{
        const candidate=state.candidates.find(candidate=>candidate.entityId===chapter.id&&candidate.revision===chapter.revision&&candidate.language===snapshot.language&&candidate.status==='published');
        const node=candidate?state.nodes[candidate.id]:state.nodes[chapter.id];if(!node?.active||!candidate&&node.revision!==chapter.revision)return false;refs.push({id:node.id,revision:node.revision});return true;
      });
      if(snapshot.current){const candidate=state.candidates.find(candidate=>candidate.status==='published'&&candidate.language===snapshot.language&&JSON.stringify(candidate.current)===JSON.stringify(snapshot.current));if(candidate&&state.nodes[candidate.id])refs.push({id:candidate.id,revision:state.nodes[candidate.id].revision});else snapshot.current=null;}
    }
    return {snapshot,refs:unique(refs).slice(0,100),blocked};
  };
  const chatDecision=(envelope:EventEnvelope,state:DomainState|null)=>{
    const payload=record(envelope.payload),actor=typeof payload.chatter_user_id==='string'?payload.chatter_user_id:'',text=record(payload.message).text;
    const echo=typeof payload.message_id==='string'&&effects.isOwnEcho(payload.message_id);
    const deleted=typeof payload.message_id==='string'&&control.get(`twitch:deleted-message:${digest(payload.message_id)}`)!==null;
    const cleared=actor&&Date.parse(envelope.occurredAt)<=(control.get<number>(`twitch:actor-cleared:${actor}`)??-Infinity);
    const contentAllowed=Boolean(state&&!state.settings.listeningPaused&&connection.quotesReady&&bans.ready()&&!echo&&!deleted&&!cleared&&actor&&bans.allows(actor)&&!payload.late);
    return {actor,text,contentAllowed,accepted:contentAllowed?envelope:{...envelope,payload:{quotesReady:false}}};
  };
  const enqueueCommand=(envelope:EventEnvelope,actor:string,text:string)=>{
    if(!publicUrl||!envelope.sessionId)return;
    const command=parseCommand(text);if(!command)return;
    const fresh=engine.state(envelope.sessionId),reply=safeReply(fresh,command);
    effects.enqueueChat({sessionId:fresh.session.id,privacyEpoch:fresh.session.privacyEpoch,dependencyRefs:reply.refs,publicationRevision:fresh.published?.revision??null,message:composeReply(command,reply.snapshot,fresh.settings.recapLanguage,publicUrl,reply.blocked),actorId:actor,key:`command:${envelope.externalId}`} as EffectContext&{publicationRevision:number|null;message:string;actorId:string;key:string});
  };
  async function ingestBatch(envelopes:readonly EventEnvelope[]):Promise<void>{
    if(!envelopes.length)return;
    const sessionId=envelopes[0].sessionId;
    if(envelopes.length>20||!sessionId||envelopes.some(event=>event.origin!=='twitch'||event.runId!=='live'||event.channelId!==channel.id||event.sessionId!==sessionId||event.kind!=='channel.chat.message'))throw new ApiError(400,'invalid_chat_batch','Chat batches contain at most twenty messages from one live stream.');
    if(!engine.ingestBatch){for(const envelope of envelopes)await ingest(envelope);return;}
    const claimed:{envelope:EventEnvelope;key:string}[]=[];
    try{
      repository.runDomainBatch(()=>{
        for(const envelope of envelopes){
          const key=`twitch:ingest:${digest(envelope.externalId)}`;
          if(retryableChatIngest.has(key)&&!inFlightIngest.has(key)&&control.get(key)==='processing')control.delete(key);
          if(!control.claim(key,'processing',clock.now()+7*86400000))continue;
          claimed.push({envelope,key});inFlightIngest.add(key);retryableChatIngest.add(key);
        }
      });
      if(!claimed.length)return;
      const before=engine.state(sessionId),items=claimed.map(({envelope})=>({envelope,...chatDecision(envelope,before)}));
      await engine.ingestBatch(items.map(item=>item.accepted));
      // Command outbox work and callback receipts become durable only after all source events commit.
      repository.runDomainBatch(()=>{
        for(const item of items)if(item.contentAllowed&&typeof item.text==='string')enqueueCommand(item.envelope,item.actor,item.text);
        for(const {key} of claimed)control.put(key,'done',clock.now()+7*86400000);
      });
      for(const {key} of claimed)retryableChatIngest.delete(key);
    }catch(error){repository.runDomainBatch(()=>{for(const {key} of claimed)control.delete(key);});throw error;}
    finally{for(const {key} of claimed)inFlightIngest.delete(key);}
  }
  async function ingest(envelope:EventEnvelope):Promise<void>{
    if(envelope.origin!=='twitch'||envelope.runId!=='live'||envelope.channelId!==channel.id)throw new ApiError(403,'live_twitch_scope','Mock and replay events require their own isolated engine.');
    const key=`twitch:ingest:${digest(envelope.externalId)}`;
    const privacy=['channel.chat.message_delete','channel.chat.clear','channel.chat.clear_user_messages','channel.ban','channel.unban'].includes(envelope.kind);
    // A durable EventSub privacy inbox can retry after a process dies inside this callback.
    // Reclaim only interrupted privacy work, never a concurrently executing callback or an ambiguous external action.
    if(privacy&&!inFlightIngest.has(key)&&control.get(key)==='processing')control.delete(key);
    if(!control.claim(key,'processing',clock.now()+7*86400000))return;
    inFlightIngest.add(key);
    try{
      const payload=record(envelope.payload);
      if(envelope.kind==='channel.chat.message_delete'){
        const messageId=String(payload.message_id??'');if(!messageId)throw new ApiError(400,'invalid_twitch_event','The deleted message identifier is missing.');
        control.put(`twitch:deleted-message:${digest(messageId)}`,true);
        const source=repository.getSource(scope,`chat:${messageId}`);
        if(source)await engine.ingest({...envelope,sessionId:source.sessionId,sessionOffsetMs:source.endMs});
        else {for(const session of sessionPages())if(session.startedAt<=envelope.occurredAt)await engine.dispatch(session.id,{type:'privacy',target:{kind:'message',sessionId:session.id,externalMessageId:messageId}},{idempotencyKey:`twitch-delete:${digest([envelope.externalId,session.id])}`,requestBody:{messageId}});await engine.ingest({...envelope,kind:'twitch.message_delete.observed',payload:null});}
      }else if(envelope.kind==='channel.chat.clear_user_messages'){
        const actor=String(payload.target_user_id??'');if(!/^\d+$/.test(actor))throw new ApiError(400,'invalid_twitch_event','The cleared actor identifier is missing.');
        const cutoff=Date.parse(envelope.occurredAt);control.put(`twitch:actor-cleared:${actor}`,Math.max(cutoff,control.get<number>(`twitch:actor-cleared:${actor}`)??0));
        for(const session of sessionPages())if(Date.parse(session.startedAt)<=cutoff){const target={kind:'user' as const,sessionId:session.id,actorId:actor,throughMs:clamp(cutoff-Date.parse(session.startedAt))};await engine.dispatch(session.id,{type:'privacy',target},{idempotencyKey:`twitch-clear-user:${digest([envelope.externalId,session.id])}`,requestBody:target});}
        await engine.ingest({...envelope,kind:'twitch.clear_user.observed',payload:null});
      }else if(envelope.kind==='channel.ban'||envelope.kind==='channel.unban'){
        const actor=String(payload.user_id??'');
        if(envelope.kind==='channel.ban')await bans.ban({user_id:actor,banned_at:typeof payload.banned_at==='string'?payload.banned_at:envelope.occurredAt,ends_at:typeof payload.ends_at==='string'?payload.ends_at:null,is_permanent:payload.is_permanent===true});
        else if(await bans.unban({user_id:actor}))await mutateAcrossSessions(actor,null);
        await engine.ingest({...envelope,kind:'twitch.moderation.observed',payload:{actorId:actor}});
      }else{
        const state=envelope.sessionId?engine.state(envelope.sessionId):null;
        const {actor,text,contentAllowed}=chatDecision(envelope,state);
        const accepted=envelope.kind==='channel.chat.message'&&!contentAllowed?{...envelope,payload:{quotesReady:false}}:envelope;
        if(envelope.kind==='channel.chat.clear')control.put('twitch:chat-cleared-through',Math.max(Date.parse(envelope.occurredAt),control.get<number>('twitch:chat-cleared-through')??0));
        if(envelope.kind==='channel.raid'&&state&&!state.settings.autoRaid)await engine.ingest({...envelope,kind:'twitch.raid.observed',payload:null});else await engine.ingest(accepted);
        if(publicUrl&&state&&envelope.kind==='channel.chat.message'&&contentAllowed&&typeof text==='string'){
          enqueueCommand(envelope,actor,text);
        }
        if(publicUrl&&state&&envelope.kind==='channel.raid'&&state.settings.autoRaid&&!payload.late){const fresh=engine.state(state.session.id),reply=safeReply(fresh,{kind:'previously'});const prefix=fresh.settings.recapLanguage==='ru'?'Добро пожаловать! ':'Welcome, raiders! ';const body=composeReply({kind:'previously'},reply.snapshot,fresh.settings.recapLanguage,publicUrl);const message=[...prefix+body].length<=500?prefix+body:body;effects.enqueueChat({sessionId:state.session.id,privacyEpoch:fresh.session.privacyEpoch,dependencyRefs:reply.refs,publicationRevision:fresh.published?.revision??null,message,actorId:channel.id,key:`raid-welcome:${envelope.externalId}`} as EffectContext&{publicationRevision:number|null;message:string;actorId:string;key:string});}
      }
      control.put(key,'done',clock.now()+7*86400000);
    }catch(error){control.delete(key);throw error;}finally{inFlightIngest.delete(key);}
  }
  const eventSub=(options.eventSubFactory??(input=>new TwitchEventSub(input)))({channelId:channel.id,runId:'live',helix,control,ingest,...(engine.ingestBatch?{ingestBatch}:{}),resolveSession:engine.resolveSession.bind(engine),onStream:observeStream,bans,status:onStatus,now:clock.now.bind(clock)});
  const queueRevoke=(sessionId:string,id:string,clipId?:string)=>{if(clipId)revokePermission(clipId);repository.enqueueJob(scope,{sessionId,kind:'twitch.media.revoke',businessKey:`twitch-media-revoke:${id}`,payload:{id,clipId},priority:1000});};
  const onEffects=(sessionId:string,domainEffects:readonly DomainEffect[],state:DomainState)=>{
    // clip.request is persisted atomically by storage as twitch.clip.intent; tick converts it once.
    if(state.session.status!=='live')repository.cancelSessionEffects(scope,sessionId);
    for(const effect of domainEffects){
      if(effect.type==='clip.cleanup')revokePermission(effect.clipId);
      if(effect.type==='privacy'||effect.type==='cancel')for(const item of state.media)if(item.state==='revoked'||item.momentId&&!state.moments.some(moment=>moment.id===item.momentId))queueRevoke(sessionId,item.id,item.clipId);
    }
  };
  const allowsMedia=(input:MediaDescriptor)=>{
    if(input.sessionId===null){
      const binding=input.channelApproval;if(binding.channelId!==scope.channelId)return false;
      const permission=control.get<PreviousPermission>(permissionKey(binding.id));
      if(!permission||permission.revision!==binding.revision||permission.state==='revoked'||control.get(`twitch:clip-block:${permission.clip.id}`))return false;
      // SQLite's privacy transaction is authoritative even if post-commit cleanup/permission writes failed.
      if(permission.attachments.some(attachment=>repository.getEntity(scope,attachment.mediaId)?.status!=='active'))return false;
      // The preview source remains owner-only at the HTTP guard. Scene aliases require explicit Use.
      return input.id===permission.mediaId||permission.approved&&input.id.startsWith('previous-scene:');
    }
    if(!engine.allowed(input))return false;const state=engine.state(input.sessionId);
    const media=state.media.find(media=>media.id===input.id);if(media?.state==='revoked'||media?.momentId&&!state.moments.some(moment=>moment.id===media.momentId))return false;
    if(media?.clipId&&control.get(`twitch:clip-block:${media.clipId}`))return false;
    return safeRefs(state,input.dependencyRefs);
  };
  const attachApproved=async(sessionId:string)=>{
    if(!options.media)return;
    for(const id of permissions()){
      const permission=control.get<PreviousPermission>(permissionKey(id));if(!permission||permission.state!=='ready')continue;
      const state=engine.state(sessionId);
      if(!permission.approved){const prior=state.media.find(media=>media.previousSession&&media.clipId===permission.clip.id&&media.ownerApproved);if(prior)await engine.dispatch(sessionId,{type:'media',media:{...prior,ownerApproved:false,state:'unavailable'},privacyEpoch:state.session.privacyEpoch});continue;}
      if(state.media.some(media=>media.previousSession&&media.clipId===permission.clip.id&&media.state==='ready'&&media.ownerApproved))continue;
      if(control.get(`twitch:clip-block:${permission.clip.id}`)||Date.parse(permission.clip.created_at)>=Date.parse(state.session.startedAt))continue;
      if(permission.attachments.length>=50&&!permission.attachments.some(item=>item.sessionId===sessionId)){lastFailure='Choose another previous clip before reusing this asset in more sessions.';continue;}
      const aliasId=`previous-scene:${digest([sessionId,permission.id]).slice(0,32)}`;
      await options.media.alias(permission.mediaId,aliasId);
      const latest=control.get<PreviousPermission>(permissionKey(id));if(!latest||latest.state!=='ready'||!latest.approved||latest.revision!==permission.revision){await options.media.revoke(aliasId);continue;}
      const media:DomainMedia={id:aliasId,revision:1,momentId:null,refs:[],captureStartMs:0,captureEndMs:Math.ceil(permission.clip.duration*1000),durationMs:permission.durationMs??Math.ceil(permission.clip.duration*1000),state:'ready',kind:'video',previousSession:true,ownerApproved:true,clipId:permission.clip.id,manageUrl:'https://dashboard.twitch.tv/content/clips',clip:{id:permission.clip.id,url:permission.clip.url,embedUrl:permission.clip.embed_url}};
      // Save the authorization relationship before committing the scene entity. A failed commit stays closed.
      control.put(permissionKey(id),{...latest,attachments:[...latest.attachments.filter(item=>item.sessionId!==sessionId),{sessionId,mediaId:aliasId}].slice(-50)});
      await engine.dispatch(sessionId,{type:'media',media,privacyEpoch:state.session.privacyEpoch},{idempotencyKey:`previous-attach:${digest([sessionId,id,permission.revision,permission.selectionRevision])}`,requestBody:{sessionId,approvalId:id,revision:permission.revision,selectionRevision:permission.selectionRevision}});
      const after=control.get<PreviousPermission>(permissionKey(id));if(after?.revision===permission.revision&&after.state!=='revoked')control.put(permissionKey(id),{...after,attachments:[...after.attachments.filter(item=>item.sessionId!==sessionId),{sessionId,mediaId:aliasId}].slice(-50)});
    }
  };
  const prepareChannelPrevious=async()=>{
    for(const id of permissions()){
      const permission=control.get<PreviousPermission>(permissionKey(id));if(!permission)continue;
      if(permission.state==='revoked'){
        await options.media?.revoke(permission.mediaId);for(const attachment of permission.attachments)await options.media?.revoke(attachment.mediaId);
        control.put('twitch:previous-permissions',permissions().filter(value=>value!==id));continue;
      }
      if(!running||!authService.status().connected||permission.state!=='queued'&&!(permission.state==='running'&&(permission.leaseUntilMs??0)<=clock.now()))continue;
      if(!options.media){control.put(permissionKey(id),{...permission,state:'failed'});continue;}
      const claimed={...permission,state:'running' as const,leaseUntilMs:clock.now()+30000};control.put(permissionKey(id),claimed);
      const renewal=setInterval(()=>{const current=control.get<PreviousPermission>(permissionKey(id));if(current?.revision===claimed.revision&&current.state==='running')control.put(permissionKey(id),{...current,leaseUntilMs:clock.now()+30000});},10000);renewal.unref();
      try{
        const url=await helix.downloadUrl(permission.clip.id);if(!url||!running||!authService.status().connected)throw new Error('download_unavailable');
        const result=await options.media.prepare({id:permission.mediaId,url,kind:'video',mimeType:'video/mp4',sessionId:null,privacyEpoch:0,dependencyRefs:[],channelApproval:{channelId:scope.channelId,id:permission.id,revision:permission.revision},captureStartMs:0,captureEndMs:Math.ceil(permission.clip.duration*1000)});
        const current=control.get<PreviousPermission>(permissionKey(id));if(!current||current.revision!==claimed.revision||current.state==='revoked'){await options.media.revoke(permission.mediaId);continue;}
        control.put(permissionKey(id),{...current,state:'ready',durationMs:result.durationMs,leaseUntilMs:null});
        const selection=control.get<PreviousSelection>('twitch:previous');if(selection?.clip.id===permission.clip.id)control.put('twitch:previous',{...selection,status:'ready'});
        const active=liveId();if(active)await attachApproved(active);
      }catch{
        const current=control.get<PreviousPermission>(permissionKey(id));if(current?.revision===claimed.revision&&current.state!=='revoked')control.put(permissionKey(id),{...current,state:'failed',leaseUntilMs:null});
        const selection=control.get<PreviousSelection>('twitch:previous');if(selection?.clip.id===permission.clip.id)control.put('twitch:previous',{...selection,status:'unavailable',reason:'download_unavailable'});
      }finally{clearInterval(renewal);}
      break; // One channel-bound download per tick; persisted queued records survive restart.
    }
  };
  const runTick=async()=>{
    if(!running||tickBusy)return;tickBusy=true;
    try{
      const revoke=repository.claimJob(scope,{kinds:['twitch.media.revoke']});if(revoke){const value=record(revoke.payload);try{await revokeMedia(String(value.id),typeof value.clipId==='string'?value.clipId:undefined);repository.finishJob(scope,revoke.id,revoke.leaseToken,'done');}catch{repository.finishJob(scope,revoke.id,revoke.leaseToken,'failed',clock.now()+5000);}}
      const gap=control.get<Gap>('twitch:gap');if(gap?.until!==null&&gap?.until!==undefined){for(const session of sessionPages()){const start=Date.parse(session.startedAt),end=session.endedAt?Date.parse(session.endedAt):gap.until;if(start>gap.until||end<gap.since)continue;const body={type:'gap' as const,startMs:clamp(gap.since-start),endMs:clamp(Math.min(gap.until,end)-start)};await engine.dispatch(session.id,body,{idempotencyKey:`twitch-gap:${digest([session.id,gap])}`,requestBody:body});}control.delete('twitch:gap');}
      await prepareChannelPrevious();
      if(!authService.status().connected)return;
      await bans.tick();const active=liveId();if(active){const state=engine.state(active);for(const actor of state.bannedActors.filter(actor=>bans.allows(actor)).slice(0,10))await mutateAcrossSessions(actor,null);}
      if(active)await attachApproved(active);
      const markerIntent=repository.claimJob(scope,{kinds:['twitch.marker.intent']});if(markerIntent){
        const state=engine.state(markerIntent.sessionId),moment=state.moments.find(item=>item.id===record(markerIntent.payload).momentId);
        if(!moment||markerIntent.privacyEpoch!==state.session.privacyEpoch)repository.finishJob(scope,markerIntent.id,markerIntent.leaseToken,'failed');
        else{
          const context:MarkerContext={sessionId:markerIntent.sessionId,privacyEpoch:markerIntent.privacyEpoch,dependencyRefs:moment.dependencyRefs,momentId:moment.id,streamId:state.session.twitchStreamId??'',expiresAtMs:Date.parse(state.session.startedAt)+moment.endMs+60000};
          repository.runIdempotentControl(scope,`twitch-marker-convert:${markerIntent.id}`,{momentId:moment.id,privacyEpoch:markerIntent.privacyEpoch},()=>{
            // A generic description never copies chat or unreviewed moment wording into Twitch.
            const id=effects.enqueueMarker({...context,key:`marker:${moment.id}:${markerIntent.privacyEpoch}`,description:'Previously saved moment',enabled:Boolean(options.markerEnabled)});
            onMarker(context,id?{status:'queued'}:{status:'unavailable',reason:!options.markerEnabled?'marker_disabled':context.expiresAtMs<=clock.now()?'marker_expired':'marker_not_eligible'});
            repository.finishJob(scope,markerIntent.id,markerIntent.leaseToken,'done');return id;
          });
        }
      }
      const intent=repository.claimJob(scope,{kinds:['twitch.clip.intent']});if(intent){
        const value=record(intent.payload),moment=value.moment as Moment|undefined;const state=engine.state(intent.sessionId);
        if(!moment||intent.privacyEpoch!==state.session.privacyEpoch||!state.moments.some(item=>item.id===moment.id)){repository.finishJob(scope,intent.id,intent.leaseToken,'failed');}
        else{
          const at=clamp(clock.now()-Date.parse(state.session.startedAt));const context:ClipContext&{key:string;auto:boolean;autoEnabled:boolean}={sessionId:intent.sessionId,privacyEpoch:intent.privacyEpoch,dependencyRefs:moment.dependencyRefs,captureStartMs:Math.max(0,at-85000),captureEndMs:Math.min(172800000,at+5000),momentId:moment.id,key:`clip:${moment.id}:${intent.privacyEpoch}`,auto:true,autoEnabled:state.settings.autoClips};
          const id=repository.runIdempotentControl(scope,`twitch-clip-convert:${intent.id}`,{momentId:moment.id,privacyEpoch:intent.privacyEpoch},()=>{const result=effects.enqueueClip(context);repository.finishJob(scope,intent.id,intent.leaseToken,result?'done':'failed');return result;});if(!id)await onClip({...context,clip:null,status:'unavailable',reason:'clip_not_eligible_or_cooldown'});
        }
      }
      await effects.tick();
    }catch{setFailure('A Twitch task could not be completed. Saved context remains available.');}finally{tickBusy=false;}
  };
  const tick=()=>{if(tickFlight)return tickFlight;tickFlight=runTick().finally(()=>{tickFlight=null;});return tickFlight;};
  const preparePrevious=async(clipId:string,sessionId:string|null,approved:boolean,idempotencyKey?:string)=>{
    const selection=control.get<PreviousSelection>('twitch:previous');if(!selection||selection.clip.id!==clipId||control.get(`twitch:clip-block:${clipId}`))throw new ApiError(404,'previous_clip_unavailable','This previous clip is unavailable.');
    if(sessionId){const state=engine.state(sessionId);if(Date.parse(selection.clip.created_at)>=Date.parse(state.session.startedAt))throw new ApiError(409,'previous_clip_session','Choose a clip from before this stream.');}
    const body={clipId,sessionId,approved},id=permissionId(clipId);
    repository.runIdempotentControl(scope,`previous-prepare:${idempotencyKey??digest(body)}`,body,()=>{
      const existing=control.get<PreviousPermission>(permissionKey(id));if(existing?.state==='revoked')throw new ApiError(409,'previous_clip_revoked','This clip was revoked. Choose another clip.');
      const index=permissions();if(!index.includes(id)&&index.length>=3)throw new ApiError(429,'previous_clip_capacity','Finish or reject an existing clip preview first.');
      if(approved)for(const otherId of index){if(otherId===id)continue;const other=control.get<PreviousPermission>(permissionKey(otherId));if(other?.approved)control.put(permissionKey(otherId),{...other,approved:false,selectionRevision:other.selectionRevision+1});}
      const value:PreviousPermission=existing?{...existing,approved:existing.approved||approved,selectionRevision:existing.selectionRevision+(approved&&!existing.approved?1:0),state:existing.state==='failed'?'queued':existing.state}:{id,revision:1,selectionRevision:1,clip:selection.clip,mediaId:`previous-preview:${digest([channel.id,clipId]).slice(0,32)}`,approved,state:'queued',leaseUntilMs:null,durationMs:null,attachments:[]};
      if(approved){const settings=repository.getSettings(scope);if(settings.earlyWelcomeClipId!==clipId)repository.updateSettings(scope,settings.revision,{earlyWelcomeClipId:clipId});}
      control.put(permissionKey(id),value);if(!index.includes(id))control.put('twitch:previous-permissions',[...index,id]);control.put('twitch:previous',{...selection,status:value.state==='ready'?'ready':'preparing',sessionId});return {id};
    });
    const permission=control.get<PreviousPermission>(permissionKey(id))!;
    const active=liveId();updates.publish({...scope,event:'snapshot.changed',data:{sessionId:active,revision:active?engine.state(active).revision:0}});
    return {jobId:id,status:permission.state==='ready'?'ready' as const:'queued' as const,mediaId:permission.mediaId,previousSession:true,ownerApproved:permission.approved};
  };
  const ownerRouter=Router();ownerRouter.use(authService.ownerRouter);
  ownerRouter.get('/twitch/markers',(req,res,next)=>{try{const sessionId=typeof req.query.sessionId==='string'?req.query.sessionId:liveId();res.json(markerStatus(sessionId));}catch(error){next(error);}});
  ownerRouter.get('/twitch/previous-clip',(_req,res)=>{const selected=control.get<PreviousSelection>('twitch:previous');res.json({candidate:selected,previousSession:true,checkedAt:control.get<number>('twitch:previous-checked')});});
  ownerRouter.post('/twitch/previous-clip/refresh',async(_req,res,next)=>{try{await refreshPrevious();res.json({candidate:control.get<PreviousSelection>('twitch:previous')});}catch(error){next(error);}});
  ownerRouter.post('/twitch/previous-clip/prepare',async(req,res,next)=>{try{if(typeof req.body?.clipId!=='string'||req.body.sessionId!==null&&req.body.sessionId!==undefined&&typeof req.body.sessionId!=='string'||typeof req.body?.use!=='boolean')throw new ApiError(400,'invalid_clip_selection','Choose a previous clip and whether to use it.');res.status(202).json(await preparePrevious(req.body.clipId,req.body.sessionId??null,req.body.use,typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined));}catch(error){next(error);}});
  ownerRouter.post('/twitch/previous-clip/reject',async(req,res,next)=>{try{const selection=control.get<PreviousSelection>('twitch:previous');if(!selection||selection.clip.id!==req.body?.clipId)throw new ApiError(404,'previous_clip_unavailable','This previous clip is unavailable.');revokePermission(selection.clip.id);control.put('twitch:previous',{...selection,status:'rejected'});for(const session of sessionPages())for(const media of engine.state(session.id).media.filter(media=>media.clipId===selection.clip.id&&media.state!=='revoked')){queueRevoke(session.id,media.id,selection.clip.id);await engine.dispatch(session.id,{type:'privacy',target:{kind:'entity',sessionId:session.id,id:media.id},reason:'previous_clip_rejected'});}res.sendStatus(204);}catch(error){next(error);}});
  return {
    auth:authService.auth,authRouter:authService.router,ownerRouter,routers:{auth:authService.router,owner:ownerRouter},ingest,onEffects,tick,allowsMedia,isOwnEcho:(id:string)=>effects.isOwnEcho(id),
    permitsOverlayMedia(id:string){const active=liveId();if(!active)return false;const state=engine.state(active),media=state.media.find(media=>media.id===id);if(!media||media.state!=='ready'||!media.ownerApproved||!state.playbacks.some(playback=>['queued','preparing','playing'].includes(playback.status)&&playback.plan?.media.some(item=>item.id===id)))return false;if(media.previousSession&&media.clipId){const permission=control.get<PreviousPermission>(permissionKey(permissionId(media.clipId)));if(!permission?.approved||permission.state!=='ready')return false;}return engine.allowed({sessionId:active,privacyEpoch:state.session.privacyEpoch,dependencyRefs:[{id:media.id,revision:media.revision}]});},
    privacyBlocked:()=>connection.privacyBlocked,
    status:()=>({...authService.status(),connection:{...connection},lastFailure,previousClip:control.get<PreviousSelection>('twitch:previous')?.status??'none'}),
    previousCandidate:()=>control.get<PreviousSelection>('twitch:previous'),refreshPrevious,preparePrevious,markerStatus,
    async start(){if(running)return;running=true;try{await authService.start();await connect();}catch{setFailure('Reconnect Twitch to continue.');}},
    async stop(){running=false;authService.stop();await stopNetwork();await tickFlight;},
  };
}
