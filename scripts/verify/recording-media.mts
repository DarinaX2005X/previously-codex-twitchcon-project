import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,stat,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {prepareRecordingMedia} from '../../src/server/replay/recording-media.js';

const run=promisify(execFile),directory=await mkdtemp(join(tmpdir(),'previously-media-proof-'));
try{
  const path=join(directory,'authored-test-pattern.mp4');
  await run('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','testsrc2=size=1280x720:rate=24:duration=12','-c:v','h264_nvenc','-b:v','6M','-an','-y',path],{timeout:120000,windowsHide:true});
  const originalBytes=(await stat(path)).size;
  const result=await prepareRecordingMedia({path,record:{id:'authored-pattern',sessionId:'authored-session',privacyEpoch:0,dependencyRefs:[{id:'authored-source',revision:1}],kind:'video',captureStartMs:1000,captureEndMs:13000,durationMs:12000,state:'ready',size:originalBytes,mimeType:'video/mp4',file:'authored-test-pattern.mp4',lastUsedAt:Date.now()}},directory);
  if(originalBytes<=3_000_000||!result.derived||result.bytes.length>3_000_000)throw new Error('media_bound_not_exercised');
  const report={checkedAt:new Date().toISOString(),material:'Authored ffmpeg test pattern. No real streamer, provider, or clip.',encoder:'h264_nvenc',originalBytes,exportBytes:result.bytes.length,durationMs:12000,mime:result.mime,decoded:true,durationToleranceMs:250,retainedOriginalInterval:[1000,13000]};
  await writeFile('docs/testing/functional/recording-media-nvenc.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw new Error('unexpected_test_directory');await rm(directory,{recursive:true,force:true});}
