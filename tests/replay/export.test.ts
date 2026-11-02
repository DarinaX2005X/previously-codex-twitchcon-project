import {describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalReplayStore,createLocalReplayHandler} from '../../src/server/replay/local.js';
import {PublicationService} from '../../src/cloud/service.js';
import {bootstrapAuthoredReplay} from '../../src/server/replay/export.js';
import {LocalReplayRecorder,assertNoCredentials} from '../../src/server/replay/recorder.js';
import {createAuthoredBundle} from '../../fixtures/authored-notes.js';

describe('recording export',()=>{
  it('serves gated authored assets, old links return 410 after revoke, restart preserves revoke',async()=>{const dir=await mkdtemp(join(tmpdir(),'previously-replay-'));try{const handler=await createLocalReplayHandler(dir),url='https://localhost/api/public/replays/foxlight';expect((await handler(new Request(url))).status).toBe(200);expect((await handler(new Request(url+'/assets/bundle?revision=1'))).status).toBe(200);
    const service=new PublicationService({store:new LocalReplayStore(join(dir,'replay-registry')),channelLogin:'authored_channel'});const head=(await service.getHead('authored_channel'))!.head;await service.publish({channelId:'authored_channel',channelLogin:'authored_channel',publishSeq:head.publishSeq+1,privacyRevision:head.privacyRevision+1,operation:'retract',sessionIds:[],exportIds:['foxlight'],snapshots:[]},'retraction');expect((await handler(new Request(url))).status).toBe(410);expect((await handler(new Request(url+'/assets/bundle?revision=1'))).status).toBe(410);expect((await bootstrapAuthoredReplay(service,'authored_channel','authored_channel')).status).toBe('revoked');const restarted=await createLocalReplayHandler(dir);expect((await restarted(new Request(url+'/assets/clip-moon?revision=1'))).status).toBe(410);expect((await restarted(new Request(url))).status).toBe(410);
    }finally{await rm(dir,{recursive:true,force:true});}});
  it('rejects credentials and destroys capture on forget',()=>{expect(()=>assertNoCredentials({headers:{authorization:'hidden'}})).toThrow('credentials');const b=createAuthoredBundle(),recorder=new LocalReplayRecorder(b.initial);for(const e of b.events)recorder.event(e.atMs,e.event);for(const p of b.providers)recorder.provider(p);recorder.forget({kind:'interval',sessionId:b.initial.session.id,fromMs:0,toMs:1000});expect(()=>recorder.privateDraft(b)).toThrow('capture_invalidated_by_privacy');});
});
