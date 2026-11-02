import {describe,it,expect} from 'vitest';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFoxlightBundle,foxlightRaid,FOXLIGHT_MEDIA,FOXLIGHT_RAID_MILESTONE_MS} from '../../fixtures/foxlight.js';
import {ReplayDriver} from '../../src/replay/driver.js';
import {validateBundle} from '../../src/replay/contracts.js';
import {buildAuthoredExport} from '../../src/server/replay/export.js';
import {createLocalReplayHandler,LocalReplayStore} from '../../src/server/replay/local.js';
import {PublicationService} from '../../src/cloud/service.js';
import {exampleSnapshot} from '../../src/features/replay/ExampleRecapPage.js';
import {PublicSnapshotSchema,RecapPlanSchema} from '../../src/shared/contracts/index.js';

const TITLES=['Fox learns to jump','The moon jump','Spring gets a speed limit','Lanterns light the cave'];
const atRaid=(run:string)=>{const d=new ReplayDriver(createFoxlightBundle(),run);d.control({action:'seek',milestone:'raid'});return d;};
const logical=(d:ReplayDriver,value:string)=>d.ids.map(value,'logical');

describe('Foxlight example recording',()=>{
  it('is a valid authored bundle that replays deterministically in separate runs',()=>{
    const bundle=createFoxlightBundle();
    expect(validateBundle(bundle).origin).toBe('authored');
    expect(bundle.providers.every(p=>p.model==='authored-no-model')).toBe(true);
    expect(bundle.media.map(m=>m.assetId)).toEqual(['clip-run','clip-moon','clip-fixed','clip-lanterns']);
    const a=new ReplayDriver(bundle,'tab-a'),b=new ReplayDriver(createFoxlightBundle(),'a much longer browser worker scope-17');
    a.advanceTo(bundle.durationMs);for(const at of [1234.5,114000,215000,377000,430300,bundle.durationMs])b.advanceTo(at);
    expect(a.error).toBeNull();expect(b.error).toBeNull();
    expect(a.state.sources[0]?.id).not.toBe(b.state.sources[0]?.id);
    expect(a.normalizedHash()).toBe(b.normalizedHash());
    expect(a.sink.actions.every(action=>action.id==='simulated'||action.kind!=='publication')).toBe(true);
  });
  it('holds the first chapter for 75 seconds and publishes it at the published milestone',()=>{
    const d=new ReplayDriver(createFoxlightBundle(),'hold'),published=d.milestones.find(m=>m.id==='published')!.atMs;
    d.advanceTo(published-1000);expect(d.state.published?.chapters.length??0).toBe(0);
    d.advanceTo(published);expect(d.state.published?.chapters.map(c=>c.title)).toEqual(['Fox learns to jump']);
  });
  it('reaches four published chapters, the current state, the lore term and the chat moment at the raid',()=>{
    const d=atRaid('raid-state'),published=d.state.published!;
    expect(d.error).toBeNull();
    expect(published.chapters.map(c=>[c.title,c.startMs])).toEqual([[TITLES[0],5000],[TITLES[1],100000],[TITLES[2],210000],[TITLES[3],320000]]);
    expect(published.session.title).toBe('Building a tiny cave platformer');
    expect(published.current).toMatchObject({goal:'Make the lanterns light up the cave.',change:'The spring no longer launches the fox to the moon.',now:'Making the lantern behind the waterfall reachable.'});
    expect(published.lore).toEqual([expect.objectContaining({term:'moon jump',originKind:'spoken',originMs:125000,firstSeenMs:100800,explanation:'When the spring had no speed limit, it launched the fox through the ceiling, and chat named it the moon jump.'})]);
    const burst=d.state.moments.find(m=>m.triggerReasons.includes('activity_burst'))!;
    expect(burst).toMatchObject({startMs:100000,endMs:110000,count:45,distinctActors:23,mediaState:'ready'});
    expect(burst.triggerReasons).toEqual(expect.arrayContaining(['activity_burst','clip_it']));
    expect(logical(d,burst.mediaId!)).toBe('fx-media-moon');
    // Every chapter has exactly its own clip moment, and every clip is published as a ready moment.
    const clipOf=(chapter:typeof published.chapters[number])=>chapter.momentIds.map(id=>d.state.moments.find(m=>m.id===id)?.mediaId).map(id=>id&&logical(d,id));
    expect(published.chapters.map(clipOf)).toEqual([['fx-media-run'],['fx-media-moon'],['fx-media-fixed'],['fx-media-lanterns']]);
    expect(published.moments.filter(m=>m.mediaState==='ready')).toHaveLength(4);
  });
  it('plays a raid RecapPlan from pixelmoth whose beats reference the example clips',()=>{
    const raid=foxlightRaid();
    expect(foxlightRaid()).toEqual(raid);
    expect(raid.atMs).toBe(FOXLIGHT_RAID_MILESTONE_MS);
    expect(RecapPlanSchema.parse(raid.plan).arrivals).toEqual([{triggerId:'fx-raid-pixelmoth',fromLogin:'pixelmoth',viewers:37}]);
    expect(raid.plan.variant).toBe('full');
    const media=new Set(raid.plan.media.map(m=>m.id));
    expect([...media].every(id=>FOXLIGHT_MEDIA.some(m=>m.id===id))).toBe(true);
    expect(raid.plan.beats.some(beat=>beat.mediaId&&media.has(beat.mediaId))).toBe(true);
    expect(PublicSnapshotSchema.parse(raid.snapshot).chapters.map(c=>c.title)).toEqual(TITLES);
    expect(JSON.stringify(raid)).not.toMatch(/[0-9a-f]{16}~/);
  });
  it('offers the owner correction after the last story update and publishes its checked wording in both languages',()=>{
    const d=new ReplayDriver(createFoxlightBundle(),'correction');
    d.advanceTo(300000);expect(d.correction).toBeNull();
    d.control({action:'seek',milestone:'raid'});
    const correction=d.correction!,target=d.state.chapters.find(c=>c.id===correction.targetId)!;
    expect(target.title).toBe('Spring gets a speed limit');
    d.editChapter(target.id,{title:correction.title,summary:correction.summary,baseRevision:target.revision});
    expect(d.error).toBeNull();expect(d.correctionApplied).toBe(true);
    expect(d.state.published?.chapters.find(c=>c.id===target.id)).toMatchObject({title:'Moon jump becomes a cheat code',edited:true});
    d.setSettings({baseRevision:d.state.settings.revision,recapLanguage:'ru'});
    expect(d.error).toBeNull();
    expect(d.state.published?.chapters.map(c=>c.title)).toEqual(['Лиса учится прыгать','Лунный прыжок','Лунный прыжок стал чит-кодом','Фонари освещают пещеру']);
    expect(d.state.published?.lore[0]?.term).toBe('лунный прыжок');
    expect(d.preview()?.language).toBe('ru');
    d.advanceTo(d.durationMs);expect(d.error).toBeNull();
  });
  it('keeps telling the story after a language switch in the middle of the recording',()=>{
    const d=new ReplayDriver(createFoxlightBundle(),'mid-switch');d.advanceTo(200000);
    expect(d.availableLanguages).toEqual(['en','ru']);
    d.setSettings({baseRevision:d.state.settings.revision,recapLanguage:'ru'});
    d.control({action:'seek',milestone:'raid'});
    expect(d.error).toBeNull();
    expect(d.state.published?.language).toBe('ru');
    expect(d.state.published?.chapters).toHaveLength(4);
    expect(d.state.published?.current?.now).toBe('Прокладывает путь к фонарю за водопадом.');
    d.setSettings({baseRevision:d.state.settings.revision,recapLanguage:'en'});
    expect(d.state.published?.chapters.map(c=>c.title)).toEqual(TITLES);
  });
  it('accepts a language switch at any point of the story without a missing recorded outcome',()=>{
    for(const at of [150000,260000,340000,400000]){
      const d=new ReplayDriver(createFoxlightBundle(),`switch-${at}`);d.advanceTo(at);
      expect(d.availableLanguages).toContain('ru');
      d.setSettings({baseRevision:d.state.settings.revision,recapLanguage:'ru'});
      expect(d.state.settings.recapLanguage).toBe('ru');
      d.advanceTo(FOXLIGHT_RAID_MILESTONE_MS);
      expect([at,d.error]).toEqual([at,null]);
      expect(d.state.published?.chapters.map(c=>c.title)).toEqual(['Лиса учится прыгать','Лунный прыжок','Пружине ограничили скорость','Фонари освещают пещеру']);
    }
  });
  it('forgetting the moon jump interval revokes its clip and removes it from the raid plan',()=>{
    const bundle=createFoxlightBundle();
    bundle.events.push({atMs:150000,event:{type:'privacy',target:{kind:'interval',sessionId:bundle.initial.session.id,fromMs:100000,toMs:110500}}});
    bundle.events.sort((a,b)=>a.atMs-b.atMs);
    const d=new ReplayDriver(bundle,'forget');d.control({action:'seek',milestone:'raid'});
    const moon=d.state.media.find(m=>logical(d,m.id)==='fx-media-moon');
    expect(moon?.state).toBe('revoked');
    const plan=d.state.playbacks.find(p=>p.plan)?.plan??d.preview();
    expect(plan?.media.some(m=>logical(d,m.id)==='fx-media-moon')??false).toBe(false);
    expect(d.state.published?.moments.some(m=>m.startMs===100000)).toBe(false);
  });
  it('serves the clips behind the export gate and withdraws them with the recording',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'previously-foxlight-')),media=join(dir,'media');
    try{
      await mkdir(media);for(const item of FOXLIGHT_MEDIA)await writeFile(join(media,`${item.assetId}.mp4`),Buffer.from(`fake mp4 ${item.assetId}`));
      const {manifest}=buildAuthoredExport(1,{mediaDirectory:media});
      expect(manifest.assets.filter(a=>a.kind==='video').map(a=>a.id)).toEqual(FOXLIGHT_MEDIA.map(m=>m.assetId));
      const handler=await createLocalReplayHandler(join(dir,'data'),{mediaDirectory:media}),url='https://localhost/api/public/replays/foxlight';
      expect(await(await handler(new Request('https://localhost/api/public/replays'))).json()).toEqual({id:'foxlight'});
      const clip=await handler(new Request(url+'/assets/clip-moon?revision=1',{headers:{range:'bytes=0-3'}}));
      expect(clip.status).toBe(206);expect(clip.headers.get('content-type')).toBe('video/mp4');expect(await clip.text()).toBe('fake');
      // Restarting with the same files keeps the revision; changed footage publishes a new revision.
      expect((await(await (await createLocalReplayHandler(join(dir,'data'),{mediaDirectory:media}))(new Request(url))).json()).revision).toBe(1);
      await writeFile(join(media,'clip-moon.mp4'),Buffer.from('new footage'));
      const updated=await createLocalReplayHandler(join(dir,'data'),{mediaDirectory:media});
      expect((await(await updated(new Request(url))).json()).revision).toBe(2);
      expect((await updated(new Request(url+'/assets/clip-moon?revision=1'))).status).toBe(410);
      const service=new PublicationService({store:new LocalReplayStore(join(dir,'data','replay-registry')),channelLogin:'authored_channel'}),head=(await service.getHead('authored_channel'))!.head;
      await service.publish({channelId:'authored_channel',channelLogin:'authored_channel',publishSeq:head.publishSeq+1,privacyRevision:head.privacyRevision+1,operation:'retract',sessionIds:[],exportIds:['foxlight'],snapshots:[]},'withdraw');
      expect((await updated(new Request(url+'/assets/clip-moon?revision=2'))).status).toBe(410);
      expect((await updated(new Request('https://localhost/api/public/replays'))).status).toBe(410);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('turns the raid snapshot into a live public read for the example page',()=>{
    const d=atRaid('public-example'),now=Date.parse('2026-11-02T18:00:00.000Z');
    const snapshot=exampleSnapshot(d.state.published!,d.atMs,now);
    expect(snapshot.channel.login).toBe('foxlight_dev');
    expect(snapshot.session.id).toBe('foxlight-session');
    expect(Date.parse(snapshot.session.startedAt)).toBe(now-d.atMs);
    expect(Date.parse(snapshot.liveLeaseUntil!)).toBeGreaterThan(now);
    expect(now-(Date.parse(snapshot.session.startedAt)+snapshot.current!.sourceTimeMs)).toBe(d.atMs-347000);
    expect(snapshot.chapters.map(c=>c.title)).toEqual(TITLES);
  });
});
