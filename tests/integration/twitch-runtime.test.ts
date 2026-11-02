import {afterEach,describe,expect,it,vi} from 'vitest';
import {createStorage} from '../../src/server/storage/index.js';
import {createTwitchRuntime} from '../../src/server/runtime/twitch-runtime.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {HelixError} from '../../src/server/twitch/index.js';
import {TWITCH_SCOPES} from '../../src/server/auth/index.js';
import type {BannedUser,EventSubOptions,TwitchClip,TwitchHelix,TwitchStream} from '../../src/server/twitch/index.js';
import type {EventEnvelope,Source,StoryProvider} from '../../src/shared/contracts/index.js';
import type {MediaInput,MediaRecord} from '../../src/server/media/cache.js';

const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
const startAt=Date.parse('2026-11-02T00:00:00.000Z');
const scope={channelId:'123',runId:'live'},channel={id:'123',login:'fixture_channel',displayName:'Fixture channel'};
const fixtureClip:TwitchClip={id:'ownclip',broadcaster_id:'123',creator_id:'123',created_at:'2026-11-01T00:00:00Z',duration:12,video_id:'',vod_offset:null,url:'https://clips.twitch.tv/ownclip',embed_url:'https://clips.twitch.tv/embed?clip=ownclip',title:'Previous permitted clip'};
function fixture(options:{authorized?:boolean;autoClips?:boolean;markers?:boolean;markerPermission?:boolean;initialBans?:BannedUser[];previous?:boolean;offline?:boolean;publicOrigin?:string|null}={}){
  let now=startAt+20000;const clock={now:()=>now,iso:()=>new Date(now).toISOString()};
  const storage=createStorage({path:':memory:',now:clock.now,encryptionKey:new Uint8Array(32).fill(7)});cleanup.push(storage.close);
  storage.repository.ensureChannel(scope,channel.login);storage.repository.updateSettings(scope,0,{listeningPaused:false,autoClips:options.autoClips??false});
  const scopes=[...TWITCH_SCOPES,...(options.markers&&options.markerPermission!==false?['channel:manage:broadcast']:[])];
  if(options.authorized!==false)storage.tokenVault!.put(scope,'twitch',{accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAtMs:now+3600000,scopes});
  const updates=new RevisionStream(1000,clock.now);cleanup.push(()=>updates.close());
  const safety=new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=> 'allowed'},clock.now);
  const propose=vi.fn<StoryProvider['propose']>(async()=>{throw new Error('This test never runs provider jobs');});
  let runtime:ReturnType<typeof createTwitchRuntime>|undefined;
  const engine=new StoryEngine({scope,channel,storage,clock,updates,safety,story:{propose},onEffects:(...args)=>runtime?.onEffects(...args),isOwnEcho:id=>runtime?.isOwnEcho(id)??false});
  let banned=options.initialBans??[];let stream:TwitchStream|null=options.offline?null:{id:'one',user_id:'123',started_at:new Date(startAt).toISOString(),title:'',game_name:'',type:'live'};
  const sendChat=vi.fn(async(_message:string)=>({message_id:'fixture-outgoing',is_sent:true}));const createClip=vi.fn(async()=>({id:'ownclip',edit_url:'https://clips.twitch.tv/ownclip/edit'}));
  const marker=vi.fn(async(_description:string,beforeRequest?:()=>boolean)=>{if(beforeRequest&&!beforeRequest())throw new Error('fence changed');return {id:'marker-one',created_at:clock.iso(),position_seconds:20,description:'Previously saved moment'};});
  const currentStream=vi.fn(async()=>stream);
  const helix={bannedUsers:async(page:(users:BannedUser[])=>void|Promise<void>,actor?:string)=>{await page(actor?banned.filter(user=>user.user_id===actor):banned);},currentStream,previousClips:async()=>options.previous?[fixtureClip]:[],sendChat,createClip,getClip:async()=>fixtureClip,downloadUrl:async()=> 'https://production.assets.clips.twitchcdn.net/fixture.mp4',subscribe:async()=>({}),marker} as unknown as TwitchHelix;
  const mediaRecords=new Map<string,MediaRecord>();const prepare=vi.fn(async(input:MediaInput):Promise<MediaRecord>=>{const {url:_url,...metadata}=input;const result:MediaRecord={...metadata,file:'fixture.media',size:10,durationMs:12000,mimeType:'video/mp4',lastUsedAt:now,state:'ready'};mediaRecords.set(input.id,result);return result;});const revoke=vi.fn(async(_id:string)=>{});const alias=vi.fn(async(sourceId:string,targetId:string):Promise<MediaRecord>=>{const result={...mediaRecords.get(sourceId)!,id:targetId};mediaRecords.set(targetId,result);return result;});
  const fetcher=vi.fn<typeof fetch>(async url=>{if(String(url)!=='https://id.twitch.tv/oauth2/validate')throw new Error('Unexpected network request');return Response.json({client_id:'fixture-client',user_id:'123',scopes,expires_in:3600});});
  let transport:EventSubOptions;const transportStart=vi.fn(async()=>{transport.status?.('connecting',{quotesReady:false,gapSince:null});await transport.bans.begin('fixture-sync');await helix.bannedUsers(users=>transport.bans.page('fixture-sync',users));await transport.bans.finish('fixture-sync');await transport.onStream(stream,clock.iso());transport.status?.('active',{quotesReady:true,gapSince:null});});const transportStop=vi.fn(async()=>{transport.status?.('disconnected',{quotesReady:false,gapSince:null});});
  runtime=createTwitchRuntime({config:{twitch:{markerEnabled:Boolean(options.markers),clientId:'fixture-client',clientSecret:'fixture-secret',channelLogin:channel.login,redirectUri:'https://localhost:4317/auth/twitch/callback'},origin:'https://localhost:4317',sessionSecret:'s'.repeat(32),publicOrigin:options.publicOrigin===undefined?'https://fixture-public.test':options.publicOrigin??undefined},scope,channel,storage,engine,updates,clock,media:{prepare,revoke,alias},markerEnabled:Boolean(options.markers),fetch:fetcher,helix,eventSubFactory:input=>{transport=input;return {start:transportStart,stop:transportStop,status:()=>({state:'active',quotesReady:true,gapSince:null})};}});
  cleanup.push(()=>runtime!.stop());
  const event=(kind:string,id:string,payload:unknown,at=clock.iso(),sessionId:string|null='stream_one'):EventEnvelope=>({...scope,schemaVersion:1,eventId:`twitch:${id}`,externalId:id,origin:'twitch',kind,occurredAt:at,receivedAt:clock.iso(),sessionId,sessionOffsetMs:Math.max(0,Date.parse(at)-startAt),payload});
  return {runtime,storage,engine,clock,fetcher,sendChat,createClip,marker,currentStream,prepare,revoke,alias,propose,transportStart,event,transport:()=>transport!,advance:(ms:number)=>{now+=ms;},setBans:(rows:BannedUser[])=>{banned=rows;},setStream:(next:TwitchStream|null)=>{stream=next;}};
}
describe('Twitch runtime composition with isolated adapters',()=>{
  it('durably saves one optional marker independently of automatic clips and preserves the moment timecode',async()=>{
    const f=fixture({markers:true});await f.runtime.start();
    await f.engine.dispatch('stream_one',{type:'moment.save',id:'marker-moment',atMs:20000});
    expect(f.storage.repository.pendingJobCount(scope,'stream_one',['twitch.marker.intent'])).toBe(1);
    await f.runtime.tick();await f.runtime.tick();
    await f.engine.dispatch('stream_one',{type:'moment.save',id:'marker-moment',atMs:20000});await f.runtime.tick();
    expect(f.marker).toHaveBeenCalledTimes(1);expect(f.createClip).not.toHaveBeenCalled();
    expect(f.marker.mock.calls[0][0]).toBe('Previously saved moment');
    expect(f.runtime.markerStatus().items).toEqual([expect.objectContaining({momentId:'marker-moment',timecodeMs:20000,status:'sent',externalId:'marker-one',positionSeconds:20})]);
    expect(f.engine.state('stream_one').moments[0]).toMatchObject({endMs:20000,clip:null,mediaState:'none'});
  });
  it.each([{markers:false,reason:'marker_disabled'},{markers:true,reason:'marker_vod_or_permission_unavailable'}])('keeps saved timecode when marker is $reason',async({markers,reason})=>{
    const f=fixture({markers});await f.runtime.start();f.marker.mockRejectedValue(new HelixError(403,'permission_or_disabled'));
    await f.engine.dispatch('stream_one',{type:'moment.save',id:'unavailable-marker',atMs:20000});await f.runtime.tick();await f.runtime.tick();
    expect(f.marker).toHaveBeenCalledTimes(markers?1:0);expect(f.runtime.markerStatus().items[0]).toMatchObject({timecodeMs:20000,status:'unavailable',reason});
    expect(f.engine.statuses().chat.state).toBe('ready');expect(f.engine.state('stream_one').moments[0].clip).toBeNull();
  });
  it('does not retry an ambiguous marker result or mark a new stream with an old moment',async()=>{
    const f=fixture({markers:true});await f.runtime.start();f.marker.mockRejectedValue(new Error('network timeout'));
    await f.engine.dispatch('stream_one',{type:'moment.save',id:'unknown-marker',atMs:20000});await f.runtime.tick();await f.runtime.tick();
    expect(f.marker).toHaveBeenCalledTimes(1);expect(f.runtime.markerStatus().items[0]).toMatchObject({status:'unknown_outcome'});
    await f.engine.dispatch('stream_one',{type:'moment.save',id:'old-marker',atMs:20000});f.setStream({id:'next-stream',user_id:'123',started_at:f.clock.iso(),title:'',game_name:'',type:'live'});await f.runtime.tick();
    expect(f.marker).toHaveBeenCalledTimes(1);expect(f.runtime.markerStatus().items[1]).toMatchObject({status:'unavailable',reason:'marker_stream_not_live'});
  });
  it('requires the optional scope and an actual marker confirmation',async()=>{
    const missing=fixture({markers:true,markerPermission:false});await missing.runtime.start();await missing.runtime.tick();
    expect(missing.runtime.status()).toMatchObject({connected:false,missingPermissions:['channel:manage:broadcast']});expect(missing.marker).not.toHaveBeenCalled();
    const f=fixture({markers:true});await f.runtime.start();f.marker.mockResolvedValue({id:'',created_at:f.clock.iso(),position_seconds:20,description:''});
    await f.engine.dispatch('stream_one',{type:'moment.save',id:'unconfirmed-marker',atMs:20000});await f.runtime.tick();await f.runtime.tick();
    expect(f.marker).toHaveBeenCalledTimes(1);expect(f.runtime.markerStatus().items[0]).toMatchObject({status:'unknown_outcome',reason:'marker_confirmation_missing'});
  });
  it('distinguishes a failed live lookup from an ambiguous marker POST',async()=>{
    const f=fixture({markers:true});await f.runtime.start();f.currentStream.mockRejectedValue(new Error('network unavailable'));
    await f.engine.dispatch('stream_one',{type:'moment.save',id:'lookup-marker',atMs:20000});await f.runtime.tick();
    expect(f.marker).not.toHaveBeenCalled();expect(f.runtime.markerStatus().items[0]).toMatchObject({status:'unavailable',reason:'marker_live_check_unavailable'});
  });
  it('rechecks privacy after the fresh live lookup and expires old marker intents',async()=>{
    const f=fixture({markers:true});await f.runtime.start();await f.engine.dispatch('stream_one',{type:'moment.save',id:'forgotten-marker',atMs:20000});
    const stream=await f.currentStream();f.currentStream.mockImplementationOnce(async()=>{await f.engine.dispatch('stream_one',{type:'privacy',target:{kind:'entity',sessionId:'stream_one',id:'forgotten-marker'}});return stream;});
    await f.runtime.tick();expect(f.marker).not.toHaveBeenCalled();expect(f.runtime.markerStatus().items).toHaveLength(0);
    await f.engine.dispatch('stream_one',{type:'moment.save',id:'expired-marker',atMs:20000});f.advance(60001);await f.runtime.tick();expect(f.marker).not.toHaveBeenCalled();expect(f.runtime.markerStatus().items[0]).toMatchObject({status:'unavailable',reason:'marker_expired'});
  });
  it('does no network work without a saved grant and never starts microphone or paid providers',async()=>{
    const f=fixture({authorized:false});await f.runtime.start();await f.runtime.tick();expect(f.fetcher).not.toHaveBeenCalled();expect(f.transportStart).not.toHaveBeenCalled();expect(f.sendChat).not.toHaveBeenCalled();expect(f.createClip).not.toHaveBeenCalled();expect(f.propose).not.toHaveBeenCalled();expect(f.engine.statuses().mic.state).toBe('paused');expect(f.storage.budget.status().usedMicroUsd).toBe(0);
  });
  it('uses the live public command path once, ignores own echo and rejects mock events',async()=>{
    const f=fixture();await f.runtime.start();const command=f.event('channel.chat.message','command',{message_id:'human-owner',chatter_user_id:'123',message:{text:'!previously'},quotesReady:true});await f.runtime.ingest(command);await f.runtime.ingest(command);await f.runtime.tick();expect(f.sendChat).toHaveBeenCalledTimes(1);expect(f.sendChat.mock.calls[0][0]).toContain('https://fixture-public.test/');expect(f.sendChat.mock.calls[0][0]).toContain('confirmed recap');
    f.advance(31000);await f.runtime.ingest(f.event('channel.chat.message','echo',{message_id:'fixture-outgoing',chatter_user_id:'123',message:{text:'!previously'},quotesReady:true}));await f.runtime.ingest(f.event('channel.chat.message','quoted',{message_id:'quoted',chatter_user_id:'456',message:{text:'someone said !previously'},quotesReady:true}));await f.runtime.tick();expect(f.sendChat).toHaveBeenCalledTimes(1);
    await expect(f.runtime.ingest({...command,externalId:'mock',origin:'mock'})).rejects.toMatchObject({code:'live_twitch_scope'});expect(f.createClip).not.toHaveBeenCalled();
  });
  it('answers !previously, !lore and a raid without a public origin, keeping cooldowns and own-echo filtering',async()=>{
    const f=fixture({publicOrigin:null});await f.runtime.start();
    await f.runtime.ingest(f.event('channel.chat.message','self-hosted',{message_id:'self-hosted',chatter_user_id:'456',message:{text:'!previously'},quotesReady:true}));await f.runtime.tick();
    expect(f.sendChat).toHaveBeenCalledTimes(1);const reply=f.sendChat.mock.calls[0][0];expect(reply).toContain('confirmed recap');expect(reply).not.toContain('https://');expect([...reply].length).toBeLessThanOrEqual(500);
    // The same viewer stays inside the 30-second actor cooldown; the bot's own echo never answers itself.
    await f.runtime.ingest(f.event('channel.chat.message','again',{message_id:'again',chatter_user_id:'456',message:{text:'!lore anything'},quotesReady:true}));
    await f.runtime.ingest(f.event('channel.chat.message','echo-self',{message_id:'fixture-outgoing',chatter_user_id:'123',message:{text:'!previously'},quotesReady:true}));
    f.advance(11000);await f.runtime.tick();expect(f.sendChat).toHaveBeenCalledTimes(1);
    f.advance(20000);await f.runtime.ingest(f.event('channel.chat.message','lore',{message_id:'lore',chatter_user_id:'456',message:{text:'!lore anything'},quotesReady:true}));await f.runtime.tick();
    expect(f.sendChat).toHaveBeenCalledTimes(2);expect(f.sendChat.mock.calls[1][0]).toBe('The origin of that joke is not confirmed yet.');
    f.advance(11000);await f.runtime.ingest(f.event('channel.raid','self-hosted-raid',{to_broadcaster_user_id:'123',from_broadcaster_user_login:'raider',viewers:2}));await f.runtime.tick();
    expect(f.sendChat).toHaveBeenCalledTimes(3);expect(f.sendChat.mock.calls[2][0]).toMatch(/^Welcome, raiders! /);expect(f.sendChat.mock.calls[2][0]).not.toContain('https://');
  });
  it('retains delete-before-create and actor cutoff across privacy events while collecting new allowed messages',async()=>{
    const f=fixture();await f.runtime.start();await f.runtime.ingest(f.event('channel.chat.message_delete','delete-first',{message_id:'late-message'}));await f.runtime.ingest(f.event('channel.chat.message','late',{message_id:'late-message',chatter_user_id:'456',message:{text:'this must never persist'},quotesReady:true}));expect(f.storage.repository.getSource(scope,'chat:late-message')).toBeNull();
    await f.runtime.ingest(f.event('channel.chat.message','normal',{message_id:'normal',chatter_user_id:'456',message:{text:'normal source'},quotesReady:true}));expect(f.storage.repository.getSource(scope,'chat:normal')?.text).toBe('normal source');
    await f.runtime.ingest(f.event('channel.chat.clear_user_messages','clear-user',{target_user_id:'456'}));expect(f.storage.repository.getSource(scope,'chat:normal')?.text).toBeNull();f.advance(1000);
    await f.runtime.ingest(f.event('channel.chat.message','after-clear',{message_id:'after-clear',chatter_user_id:'456',message:{text:'new source after cutoff'},quotesReady:true}));expect(f.storage.repository.getSource(scope,'chat:after-clear')?.text).toBe('new source after cutoff');
  });
  it('synchronizes a preexisting ban across historical sessions and verified unban permits only new sources',async()=>{
    const f=fixture({initialBans:[{user_id:'456',created_at:new Date(startAt-1000).toISOString(),expires_at:''}]});
    f.storage.repository.createSession(scope,{id:'stream_old',startedAt:new Date(startAt-100000).toISOString(),twitchStreamId:'old'});
    const source:Source={...scope,id:'chat:old',sessionId:'stream_old',revision:1,kind:'chat',startMs:1000,endMs:1000,actorId:'456',languageCodes:[],timePrecision:'event',text:'old banned text',status:'active',externalMessageId:'old',moderation:'allowed'};
    await f.engine.dispatch('stream_old',{type:'source',source});await f.runtime.start();expect(f.storage.repository.getSource(scope,'chat:old')?.text).toBeNull();expect(f.engine.state('stream_old').session.status).toBe('closing');
    await f.runtime.ingest(f.event('channel.chat.message','blocked',{message_id:'blocked',chatter_user_id:'456',message:{text:'blocked at startup'},quotesReady:true}));expect(f.storage.repository.getSource(scope,'chat:blocked')).toBeNull();
    f.setBans([]);await f.runtime.ingest(f.event('channel.unban','unban',{user_id:'456'}));f.advance(1000);await f.runtime.ingest(f.event('channel.chat.message','unbanned',{message_id:'unbanned',chatter_user_id:'456',message:{text:'new permitted message'},quotesReady:true}));expect(f.storage.repository.getSource(scope,'chat:unbanned')?.text).toBe('new permitted message');expect(f.storage.repository.getSource(scope,'chat:old')?.text).toBeNull();
  });
  it('converts a durable moment intent, prepares actual adapter output, and revokes the private file on Forget',async()=>{
    const f=fixture({autoClips:true});await f.runtime.start();await f.engine.dispatch('stream_one',{type:'moment.save',id:'moment-one',atMs:20000});await f.runtime.tick();expect(f.createClip).toHaveBeenCalledTimes(1);expect(f.engine.state('stream_one').moments[0].mediaState).toBe('pending');expect(f.prepare).not.toHaveBeenCalled();
    f.advance(1000);await f.runtime.tick();const state=f.engine.state('stream_one');expect(state.moments[0].mediaState).toBe('ready');expect(f.prepare).toHaveBeenCalledTimes(1);const media=state.media.find(item=>item.state==='ready')!;expect(media.captureEndMs).toBe(25000);expect(media.captureStartMs).toBe(0);
    await f.engine.dispatch('stream_one',{type:'privacy',target:{kind:'interval',sessionId:'stream_one',fromMs:10000,toMs:11000}});expect(f.runtime.allowsMedia({...f.prepare.mock.calls[0][0]})).toBe(false);await f.runtime.tick();expect(f.revoke).toHaveBeenCalledWith(media.id);expect(f.engine.state('stream_one').moments.every(moment=>moment.mediaState!=='ready')).toBe(true);
  });
  it('confirmed offline cancels queued sends and a late offline never closes the next stream',async()=>{
    const f=fixture();await f.runtime.start();await f.runtime.ingest(f.event('channel.chat.message','pending-command',{message_id:'pending-command',chatter_user_id:'456',message:{text:'!previously'},quotesReady:true}));await f.transport().onStream(null,f.clock.iso(),'one');await f.runtime.tick();expect(f.sendChat).not.toHaveBeenCalled();expect(f.engine.state('stream_one').session.status).toBe('closing');
    f.advance(1000);await f.transport().onStream({id:'two',user_id:'123',started_at:f.clock.iso(),title:'',game_name:''},f.clock.iso(),'two');await f.transport().onStream(null,new Date(startAt+20000).toISOString(),'one');expect(f.engine.state('stream_two').session.status).toBe('live');expect(f.engine.state('stream_one').session.status).toBe('closing');
  });
  it('prepares selected previous media through durable work and retains the previous-session label',async()=>{
    const f=fixture({previous:true});await f.runtime.start();expect(f.runtime.previousCandidate()?.clip.id).toBe('ownclip');const request=await f.runtime.preparePrevious('ownclip','stream_one',true,'previous-use-fixture');expect(request.status).toBe('queued');expect(f.prepare).not.toHaveBeenCalled();await f.runtime.tick();expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.engine.state('stream_one').media[0]).toMatchObject({previousSession:true,ownerApproved:true,state:'ready',momentId:null});expect(f.runtime.previousCandidate()?.status).toBe('ready');
  });
  it('downloads an owner preview before the first stream, attaches only after Use, and cannot resurrect after Forget',async()=>{
    const f=fixture({previous:true,offline:true});await f.runtime.start();expect(f.storage.repository.listSessions(scope)).toHaveLength(0);
    const preview=await f.runtime.preparePrevious('ownclip',null,false,'offline-preview-fixture');await f.runtime.tick();expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.prepare.mock.calls[0][0]).toMatchObject({sessionId:null,privacyEpoch:0,channelApproval:{channelId:'123'}});expect(f.storage.repository.listSessions(scope)).toHaveLength(0);expect(f.runtime.permitsOverlayMedia(preview.mediaId)).toBe(false);
    await f.runtime.preparePrevious('ownclip',null,true,'offline-use-fixture');await f.runtime.tick();expect(f.prepare).toHaveBeenCalledTimes(1);
    await f.transport().onStream({id:'one',user_id:'123',started_at:new Date(startAt).toISOString(),title:'',game_name:''},f.clock.iso(),'one');expect(f.alias).toHaveBeenCalledTimes(1);expect(f.prepare).toHaveBeenCalledTimes(1);const media=f.engine.state('stream_one').media[0];expect(media).toMatchObject({state:'ready',previousSession:true,ownerApproved:true});
    await f.runtime.ingest(f.event('channel.raid','early-raid',{to_broadcaster_user_id:'123',from_broadcaster_user_login:'raider',viewers:2}));expect(f.runtime.permitsOverlayMedia(media.id)).toBe(true);
    await f.engine.dispatch('stream_one',{type:'privacy',target:{kind:'interval',sessionId:'stream_one',fromMs:0,toMs:10000}});expect(f.runtime.allowsMedia(f.prepare.mock.calls[0][0])).toBe(false);await f.runtime.tick();expect(f.revoke).toHaveBeenCalledWith(preview.mediaId);
    f.advance(1000);await f.transport().onStream({id:'two',user_id:'123',started_at:f.clock.iso(),title:'',game_name:''},f.clock.iso(),'two');expect(f.engine.state('stream_two').media).toHaveLength(0);expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('persists reconnect coverage gaps, gates unknown chat, and revokes owner sessions on authorization loss',async()=>{
    const f=fixture();await f.runtime.start();const owner=f.storage.sessions.issue(scope,'123','owner');const gapStart=f.clock.iso();f.transport().status?.('gap',{quotesReady:false,gapSince:gapStart,reason:'socket_closed'});
    await f.runtime.ingest(f.event('channel.chat.message','gap-chat',{message_id:'gap-chat',chatter_user_id:'456',message:{text:'must not enter unknown coverage'},quotesReady:false}));expect(f.storage.repository.getSource(scope,'chat:gap-chat')).toBeNull();f.advance(3000);await f.transport().bans.begin('recovered');await f.transport().bans.finish('recovered');f.transport().status?.('active',{quotesReady:true,gapSince:gapStart});await f.runtime.tick();expect(f.engine.state('stream_one').gaps).toEqual([{startMs:20000,endMs:23000}]);await f.runtime.tick();expect(f.engine.state('stream_one').gaps).toHaveLength(1);
    f.transport().status?.('revoked',{quotesReady:false,gapSince:gapStart,reason:'authorization_revoked'});expect(f.storage.sessions.verify(scope,owner,'owner')).toBeNull();expect(f.runtime.status().connected).toBe(false);expect(f.engine.statuses().mic.state).toBe('paused');expect(f.sendChat).not.toHaveBeenCalled();
  });
  it('uses the transactional media tombstone even before post-commit permission cleanup runs',async()=>{
    const f=fixture({previous:true});await f.runtime.start();await f.runtime.preparePrevious('ownclip',null,true,'privacy-fence-fixture');await f.runtime.tick();const media=f.engine.state('stream_one').media[0];const descriptor=f.prepare.mock.calls[0][0];expect(f.runtime.allowsMedia(descriptor)).toBe(true);
    f.storage.repository.invalidate(scope,{kind:'entity',sessionId:'stream_one',id:media.id},{idempotencyKey:'simulate-crash-before-cleanup',reason:'owner_forget'});
    expect(f.runtime.allowsMedia(descriptor)).toBe(false);expect(f.runtime.permitsOverlayMedia(media.id)).toBe(false);
  });
});
