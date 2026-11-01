import {createHash} from 'node:crypto';
import {Router} from 'express';
import type {DomainEffect,DomainMedia,DomainState} from '../../core/types.js';
import type {Channel,Clock,EventEnvelope,Moment,PublicSnapshot,Scope,Session,VersionRef} from '../../shared/contracts/index.js';
import {bindControlStore,createTwitchAuth,type AuthOptions} from '../auth/index.js';
import type {PrivateMediaCache,MediaInput} from '../media/cache.js';
import {TwitchBanSync,TwitchEffects,TwitchEventSub,TwitchHelix,composeReply,parseCommand,type ChatCommand,type ConnectionState,type EffectContext,type EventSubOptions,type TwitchClip,type TwitchStream} from '../twitch/index.js';
import type {RuntimeConfig} from './config.js';
import type {RuntimeStorage,StoryEngine} from './engine.js';
import {ApiError} from './errors.js';
import type {RevisionStream} from './updates.js';

type EnginePort=Pick<StoryEngine,'state'|'dispatch'|'ingest'|'observeStream'|'resolveSession'|'activeSessionId'|'allowed'|'setStatus'>;
type EventSubPort=Pick<TwitchEventSub,'start'|'stop'|'status'>;
type ClipContext=EffectContext&{momentId?:string;key?:string;publicationRevision?:number|null;previousApproved?:boolean};
type PreviousSelection={clip:TwitchClip;status:'candidate'|'preparing'|'ready'|'unavailable'|'rejected';sessionId:string|null;reason?:string};
type Gap={since:number;until:number|null};
export interface TwitchRuntimeOptions {
  config:Pick<RuntimeConfig,'twitch'|'origin'|'sessionSecret'|'publicOrigin'>;
  scope:Scope;channel:Channel;storage:RuntimeStorage;engine:EnginePort;updates:RevisionStream;clock:Clock;
  media?:Pick<PrivateMediaCache,'prepare'|'revoke'>;
  markerEnabled?:boolean;publicUrl?:string;
  fetch?:typeof fetch;helix?:TwitchHelix;
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
  let running=false,tickBusy=false,networkStarting:Promise<void>|null=null,previousBusy=false;
  let connection:{state:ConnectionState;quotesReady:boolean;reason?:string}={state:'disconnected',quotesReady:false};
  let lastFailure:string|null=null;
  const publicUrl=options.publicUrl??config.publicOrigin;
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
      if(source){if(source.status!=='active'||source.revision!==ref.revision)return false;if(source.kind==='chat'&&(!source.actorId||!bans.allows(source.actorId)))return false;continue;}
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
      }
      if(input.kind==='previous.clip'&&!state.session.endedAt&&state.session.status!=='live')return false;
      return true;
    }catch{return false;}
  };
  const mediaId=(input:ClipContext,clipId?:string)=>input.momentId?`moment-media:${digest([input.sessionId,input.momentId]).slice(0,32)}`:`previous-media:${digest([input.sessionId,clipId]).slice(0,32)}`;
  const revokeMedia=async(id:string,clipId?:string)=>{if(clipId)control.put(`twitch:clip-block:${clipId}`,true);await options.media?.revoke(id);};
  const onClip=async(input:EffectContext&{clip:TwitchClip|null;status:'pending'|'ready'|'unavailable'|'revoked';reason?:string;previousSession?:boolean})=>{
    const extended=input as ClipContext&typeof input,id=mediaId(extended,input.clip?.id);
    if(input.previousSession){const selection=control.get<PreviousSelection>('twitch:previous');if(selection?.clip.id===input.clip?.id)control.put('twitch:previous',{...selection,status:input.status==='ready'?'ready':input.status==='pending'?'preparing':'unavailable',reason:input.reason});}
    if(input.status==='revoked'){await revokeMedia(id,input.clip?.id);return;}
    if(!engine.allowed(input)){if(input.clip)control.put(`twitch:clip-block:${input.clip.id}`,true);await options.media?.revoke(id);return;}
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
  const effects=new TwitchEffects({scope,helix,repository,control,now:clock.now.bind(clock),allowed,
    prepareMedia:async input=>{if(!options.media)throw new Error('private_media_unavailable');const extended=input as ClipContext&typeof input;const clipId=input.id.startsWith('clip:')?input.id.slice(5):undefined;const id=mediaId(extended,clipId);const result=await options.media.prepare({...input,id});control.put(`twitch:media:${id}`,{durationMs:result.durationMs});return result;},
    onClip,previousPermitted:clip=>clip.broadcaster_id===channel.id&&!control.get(`twitch:clip-block:${clip.id}`),
    onResult:(_id,result)=>{if(result.status==='unknown_outcome')lastFailure='Twitch did not confirm an external action. It will not be sent again automatically.';},
  });
  const refreshPrevious=async()=>{
    if(previousBusy||!running||!authService.status().connected)return;previousBusy=true;
    try{const id=liveId();const before=id?repository.getSession(scope,id).startedAt:clock.iso();const candidate=await effects.previousCandidate(before);const current=control.get<PreviousSelection>('twitch:previous');
      if(candidate){if(current?.clip.id!==candidate.id||current.status==='candidate')control.put('twitch:previous',{clip:candidate,status:'candidate',sessionId:null} satisfies PreviousSelection);}
      else if(!current||current.status==='candidate')control.delete('twitch:previous');
      control.put('twitch:previous-checked',clock.now());
    }catch{lastFailure='Previous clips could not be checked. Retry from Twitch setup.';}finally{previousBusy=false;}
  };
  const observeStream=async(stream:TwitchStream|null,occurredAt:string,streamId?:string)=>{
    if(stream){
      for(const session of sessionPages())if(session.status==='live'&&session.twitchStreamId!==stream.id){repository.cancelSessionEffects(scope,session.id);await engine.observeStream(null,stream.started_at,session.twitchStreamId??undefined);}
    }
    await engine.observeStream(stream,occurredAt,streamId);
    if(!stream){const id=streamId?engine.resolveSession(occurredAt,streamId)?.id:engine.resolveSession(occurredAt)?.id;if(id)repository.cancelSessionEffects(scope,id);}
    if(!control.get<number>('twitch:previous-checked')||clock.now()-(control.get<number>('twitch:previous-checked')??0)>300000)await refreshPrevious();
  };
  const onStatus=(state:ConnectionState,detail:{quotesReady:boolean;gapSince:string|null;reason?:string})=>{
    connection={state,quotesReady:detail.quotesReady,reason:detail.reason};
    if(!detail.quotesReady)bans.suspend();
    if(state==='gap')control.put('twitch:gap',{since:control.get<Gap>('twitch:gap')?.since??Date.parse(detail.gapSince??clock.iso()),until:null} satisfies Gap);
    if(state==='active'){const gap=control.get<Gap>('twitch:gap');if(gap&&gap.until===null)control.put('twitch:gap',{...gap,until:clock.now()});}
    engine.setStatus('chat',{state:state==='active'&&detail.quotesReady?'ready':state==='gap'?'delayed':state==='revoked'?'error':state==='disconnected'?'disconnected':'connecting',lastObservedAt:clock.iso(),message:state==='gap'?'Chat coverage has a gap. Reconnecting and checking bans.':state==='revoked'?'Twitch permissions changed. Reconnect Twitch.':state==='active'?null:'Connecting Twitch and checking channel restrictions.',action:state==='revoked'?'Reconnect Twitch':null});
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
  async function ingest(envelope:EventEnvelope):Promise<void>{
    if(envelope.origin!=='twitch'||envelope.runId!=='live'||envelope.channelId!==channel.id)throw new ApiError(403,'live_twitch_scope','Mock and replay events require their own isolated engine.');
    const key=`twitch:ingest:${digest(envelope.externalId)}`;if(!control.claim(key,'processing',clock.now()+7*86400000))return;
    try{
      const payload=record(envelope.payload);
      if(envelope.kind==='channel.ban'||envelope.kind==='channel.unban'){
        const actor=String(payload.user_id??'');
        if(envelope.kind==='channel.ban')await bans.ban({user_id:actor,banned_at:typeof payload.banned_at==='string'?payload.banned_at:envelope.occurredAt,ends_at:typeof payload.ends_at==='string'?payload.ends_at:null,is_permanent:payload.is_permanent===true});
        else if(await bans.unban({user_id:actor}))await mutateAcrossSessions(actor,null);
        await engine.ingest({...envelope,kind:'twitch.moderation.observed',payload:{actorId:actor}});
      }else{
        const state=envelope.sessionId?engine.state(envelope.sessionId):null;
        const actor=typeof payload.chatter_user_id==='string'?payload.chatter_user_id:'';
        const text=record(payload.message).text;
        const echo=typeof payload.message_id==='string'&&effects.isOwnEcho(payload.message_id);
        const contentAllowed=Boolean(state&&!state.settings.listeningPaused&&connection.quotesReady&&bans.ready()&&!echo&&actor&&bans.allows(actor)&&!payload.late);
        const accepted=envelope.kind==='channel.chat.message'&&!contentAllowed?{...envelope,payload:{quotesReady:false}}:envelope;
        if(envelope.kind==='channel.raid'&&state&&!state.settings.autoRaid)await engine.ingest({...envelope,kind:'twitch.raid.observed',payload:null});else await engine.ingest(accepted);
        if(publicUrl&&state&&envelope.kind==='channel.chat.message'&&contentAllowed&&typeof text==='string'){
          const command=parseCommand(text);if(command){const fresh=engine.state(state.session.id),reply=safeReply(fresh,command);const input={sessionId:state.session.id,privacyEpoch:fresh.session.privacyEpoch,dependencyRefs:reply.refs,publicationRevision:fresh.published?.revision??null,message:composeReply(command,reply.snapshot,fresh.settings.recapLanguage,publicUrl,reply.blocked),actorId:actor,key:`command:${envelope.externalId}`};effects.enqueueChat(input);}
        }
        if(publicUrl&&state&&envelope.kind==='channel.raid'&&state.settings.autoRaid&&!payload.late){const fresh=engine.state(state.session.id),reply=safeReply(fresh,{kind:'previously'});const prefix=fresh.settings.recapLanguage==='ru'?'Добро пожаловать! ':'Welcome, raiders! ';const body=composeReply({kind:'previously'},reply.snapshot,fresh.settings.recapLanguage,publicUrl);const message=[...prefix+body].length<=500?prefix+body:body;effects.enqueueChat({sessionId:state.session.id,privacyEpoch:fresh.session.privacyEpoch,dependencyRefs:reply.refs,publicationRevision:fresh.published?.revision??null,message,actorId:channel.id,key:`raid-welcome:${envelope.externalId}`} as EffectContext&{publicationRevision:number|null;message:string;actorId:string;key:string});}
      }
      control.put(key,'done',clock.now()+7*86400000);
    }catch(error){control.delete(key);throw error;}
  }
  const eventSub=(options.eventSubFactory??(input=>new TwitchEventSub(input)))({channelId:channel.id,runId:'live',helix,control,ingest,resolveSession:engine.resolveSession.bind(engine),onStream:observeStream,bans,status:onStatus,now:clock.now.bind(clock)});
  const queueRevoke=(sessionId:string,id:string,clipId?:string)=>{if(clipId)control.put(`twitch:clip-block:${clipId}`,true);repository.enqueueJob(scope,{sessionId,kind:'twitch.media.revoke',businessKey:`twitch-media-revoke:${id}`,payload:{id,clipId},priority:1000});};
  const onEffects=(sessionId:string,domainEffects:readonly DomainEffect[],state:DomainState)=>{
    // clip.request is persisted atomically by storage as twitch.clip.intent; tick converts it once.
    if(state.session.status!=='live')repository.cancelSessionEffects(scope,sessionId);
    for(const effect of domainEffects){
      if(effect.type==='clip.cleanup')control.put(`twitch:clip-block:${effect.clipId}`,true);
      if(effect.type==='privacy'||effect.type==='cancel')for(const item of state.media)if(item.state==='revoked'||item.momentId&&!state.moments.some(moment=>moment.id===item.momentId))queueRevoke(sessionId,item.id,item.clipId);
    }
  };
  const allowsMedia=(input:Omit<MediaInput,'url'>)=>{
    if(!engine.allowed(input))return false;const state=engine.state(input.sessionId);
    const media=state.media.find(media=>media.id===input.id);if(media?.state==='revoked'||media?.momentId&&!state.moments.some(moment=>moment.id===media.momentId))return false;
    if(media?.clipId&&control.get(`twitch:clip-block:${media.clipId}`))return false;
    return safeRefs(state,input.dependencyRefs);
  };
  const tick=async()=>{
    if(!running||tickBusy)return;tickBusy=true;
    try{
      const revoke=repository.claimJob(scope,{kinds:['twitch.media.revoke']});if(revoke){const value=record(revoke.payload);try{await revokeMedia(String(value.id),typeof value.clipId==='string'?value.clipId:undefined);repository.finishJob(scope,revoke.id,revoke.leaseToken,'done');}catch{repository.finishJob(scope,revoke.id,revoke.leaseToken,'failed',clock.now()+5000);}}
      const gap=control.get<Gap>('twitch:gap');if(gap?.until!==null&&gap?.until!==undefined){for(const session of sessionPages()){const start=Date.parse(session.startedAt),end=session.endedAt?Date.parse(session.endedAt):gap.until;if(start>gap.until||end<gap.since)continue;const body={type:'gap' as const,startMs:clamp(gap.since-start),endMs:clamp(Math.min(gap.until,end)-start)};await engine.dispatch(session.id,body,{idempotencyKey:`twitch-gap:${digest([session.id,gap])}`,requestBody:body});}control.delete('twitch:gap');}
      if(!authService.status().connected)return;
      await bans.tick();const active=liveId();if(active){const state=engine.state(active);for(const actor of state.bannedActors.filter(actor=>bans.allows(actor)).slice(0,10))await mutateAcrossSessions(actor,null);}
      const intent=repository.claimJob(scope,{kinds:['twitch.clip.intent']});if(intent){
        const value=record(intent.payload),moment=value.moment as Moment|undefined;const state=engine.state(intent.sessionId);
        if(!moment||intent.privacyEpoch!==state.session.privacyEpoch||!state.moments.some(item=>item.id===moment.id)){repository.finishJob(scope,intent.id,intent.leaseToken,'failed');}
        else{
          const at=clamp(clock.now()-Date.parse(state.session.startedAt));const context:ClipContext&{key:string;auto:boolean;autoEnabled:boolean}={sessionId:intent.sessionId,privacyEpoch:intent.privacyEpoch,dependencyRefs:moment.dependencyRefs,captureStartMs:Math.max(0,at-85000),captureEndMs:Math.min(172800000,at+5000),momentId:moment.id,key:`clip:${moment.id}:${intent.privacyEpoch}`,auto:true,autoEnabled:state.settings.autoClips};
          const id=effects.enqueueClip(context);if(!id)await onClip({...context,clip:null,status:'unavailable',reason:'clip_not_eligible_or_cooldown'});repository.finishJob(scope,intent.id,intent.leaseToken,id?'done':'failed');
        }
      }
      await effects.tick();
    }catch{setFailure('A Twitch task could not be completed. Saved context remains available.');}finally{tickBusy=false;}
  };
  const preparePrevious=async(clipId:string,sessionId:string,approved:boolean)=>{
    const selection=control.get<PreviousSelection>('twitch:previous');if(!selection||selection.clip.id!==clipId||control.get(`twitch:clip-block:${clipId}`))throw new ApiError(404,'previous_clip_unavailable','This previous clip is unavailable.');
    const state=engine.state(sessionId);if(Date.parse(selection.clip.created_at)>=Date.parse(state.session.startedAt))throw new ApiError(409,'previous_clip_session','Choose a clip from before this stream.');
    control.put('twitch:previous',{...selection,status:'preparing',sessionId});
    const context:ClipContext={sessionId,privacyEpoch:state.session.privacyEpoch,dependencyRefs:[],captureStartMs:0,captureEndMs:Math.ceil(selection.clip.duration*1000),previousApproved:approved};
    const ready=await effects.preparePrevious(selection.clip,context);return {ready,previousSession:true,ownerApproved:approved};
  };
  const ownerRouter=Router();ownerRouter.use(authService.ownerRouter);
  ownerRouter.get('/twitch/previous-clip',(_req,res)=>{const selected=control.get<PreviousSelection>('twitch:previous');res.json({candidate:selected,previousSession:true,checkedAt:control.get<number>('twitch:previous-checked')});});
  ownerRouter.post('/twitch/previous-clip/refresh',async(_req,res,next)=>{try{await refreshPrevious();res.json({candidate:control.get<PreviousSelection>('twitch:previous')});}catch(error){next(error);}});
  ownerRouter.post('/twitch/previous-clip/prepare',async(req,res,next)=>{try{if(typeof req.body?.clipId!=='string'||typeof req.body?.sessionId!=='string'||typeof req.body?.use!=='boolean')throw new ApiError(400,'invalid_clip_selection','Choose a previous clip and whether to use it.');res.json(await preparePrevious(req.body.clipId,req.body.sessionId,req.body.use));}catch(error){next(error);}});
  ownerRouter.post('/twitch/previous-clip/reject',(req,res,next)=>{const selection=control.get<PreviousSelection>('twitch:previous');if(!selection||selection.clip.id!==req.body?.clipId){next(new ApiError(404,'previous_clip_unavailable','This previous clip is unavailable.'));return;}control.put(`twitch:clip-block:${selection.clip.id}`,true);control.put('twitch:previous',{...selection,status:'rejected'});if(selection.sessionId)queueRevoke(selection.sessionId,mediaId({sessionId:selection.sessionId,privacyEpoch:0,dependencyRefs:[]},selection.clip.id),selection.clip.id);res.sendStatus(204);});
  return {
    auth:authService.auth,authRouter:authService.router,ownerRouter,routers:{auth:authService.router,owner:ownerRouter},ingest,onEffects,tick,allowsMedia,isOwnEcho:(id:string)=>effects.isOwnEcho(id),
    status:()=>({...authService.status(),connection:{...connection},lastFailure,previousClip:control.get<PreviousSelection>('twitch:previous')?.status??'none'}),
    previousCandidate:()=>control.get<PreviousSelection>('twitch:previous'),refreshPrevious,preparePrevious,
    async start(){if(running)return;running=true;try{await authService.start();await connect();}catch{setFailure('Reconnect Twitch to continue.');}},
    async stop(){running=false;authService.stop();await stopNetwork();},
  };
}
