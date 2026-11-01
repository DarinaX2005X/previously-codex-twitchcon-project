import {readFile,writeFile} from 'node:fs/promises';
import {ReplayGate} from '../../replay/gate.js';
import {ReplayDriver} from '../../replay/driver.js';
import {validateBundle} from '../../replay/contracts.js';
/** Explicit download for an owner-reviewed public export; never used by the public page. */
export async function downloadCurrentReplay(manifestUrl:string,outputPath:string){const gate=new ReplayGate(manifestUrl,()=>{});try{const bundle=await gate.load();await writeFile(outputPath,JSON.stringify(bundle),{flag:'wx',mode:0o600});return {path:outputPath,revision:bundle.revision,origin:bundle.origin,notice:'A downloaded offline copy cannot be remotely revoked.'};}finally{gate.dispose();}}
export async function replayOffline(path:string,atMs?:number){const bundle=validateBundle(JSON.parse(await readFile(path,'utf8'))),driver=new ReplayDriver(bundle,'offline-run');driver.advanceTo(atMs??bundle.durationMs);return {driver,hash:driver.normalizedHash()};}
