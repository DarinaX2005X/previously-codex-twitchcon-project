import {readFile,writeFile,stat} from 'node:fs/promises';
import {ReplayGate} from '../../replay/gate.js';
import {ReplayDriver} from '../../replay/driver.js';
import {MAX_BUNDLE_BYTES,validateBundle} from '../../replay/contracts.js';
import {loadOfflineArchive} from './offline-archive.js';
/** Explicit download for an owner-reviewed public export; never used by the public page. */
export async function downloadCurrentReplay(manifestUrl:string,outputPath:string){const gate=new ReplayGate(manifestUrl,()=>{});try{const bundle=await gate.load();await writeFile(outputPath,JSON.stringify(bundle),{flag:'wx',mode:0o600});return {path:outputPath,revision:bundle.revision,origin:bundle.origin,notice:'A downloaded offline copy cannot be remotely revoked.'};}finally{gate.dispose();}}
export async function replayOffline(path:string,atMs?:number){
  if((await stat(path)).size>MAX_BUNDLE_BYTES)throw new Error('recording_bundle_too_large');
  const bytes=await readFile(path);
  if(bytes.length>MAX_BUNDLE_BYTES)throw new Error('recording_bundle_too_large');
  if(bytes.length>=4&&bytes.readUInt32LE(0)===0x04034b50){const archive=loadOfflineArchive(bytes);archive.driver.advanceTo(atMs??archive.bundle.durationMs);return {...archive,hash:archive.driver.normalizedHash()};}
  const bundle=validateBundle(JSON.parse(bytes.toString('utf8'))),driver=new ReplayDriver(bundle,'offline-run');driver.advanceTo(atMs??bundle.durationMs);return {bundle,driver,hash:driver.normalizedHash(),resolveMedia:(_id:string):{bytes:Uint8Array;mime:string}|null=>null};
}
