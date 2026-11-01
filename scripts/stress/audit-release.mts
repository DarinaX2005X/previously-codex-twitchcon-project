/** Read-only source/data inspection. Only paths, finding kinds and counts are emitted. */
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,readdirSync,statSync,mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parse} from 'dotenv';
import {build} from 'vite';
const root=process.cwd(),temp=mkdtempSync(join(tmpdir(),'previously-public-audit-')),out=join(temp,'public');
const findings:{file:string;kind:string}[]=[],notes:{file:string;kind:string}[]=[];
const env=existsSync('.env')?parse(readFileSync('.env')):{},secrets=Object.entries(env).filter(([key,value])=>/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(key)&&value.length>=16);
const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,windowsHide:true}).toString().split('\0').filter(Boolean);
const ignorePaths=['.env','.env.production','.data/previously.sqlite','.data/audio-tmp/private.wav','.data/certs/local-cert.pem','local.pem','local.key','local.pfx'];
const ignored=execFileSync('git',['check-ignore','--no-index','-z','--stdin'],{cwd:root,input:ignorePaths.join('\0')+'\0',windowsHide:true}).toString().split('\0').filter(Boolean);
const privateTexts:string[]=[];let privateDatabaseSamples=0;
const dataDir=resolve(env.DATA_DIR??'.data');
if(existsSync(dataDir))for(const entry of readdirSync(dataDir,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.sqlite'))continue;
  const file=join(dataDir,entry.name);let db:DatabaseSync|undefined;
  try{db=new DatabaseSync(file,{readOnly:true});const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sources'").get();if(exists){const rows=db.prepare('SELECT text FROM sources WHERE text IS NOT NULL AND length(text)>=48 ORDER BY start_ms DESC LIMIT 2000').all();privateTexts.push(...rows.map(row=>String(row.text)));privateDatabaseSamples+=rows.length;}}
  catch{notes.push({file:relative(root,file).replaceAll('\\','/'),kind:'private-database-sample-unavailable'});}finally{db?.close();}
}
const uniquePrivate=[...new Set(privateTexts)];
function files(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const file=join(dir,entry.name);return entry.isDirectory()?files(file):entry.isFile()?[file]:[];});}
function inspect(file:string,label:string,publicBundle:boolean){
  const bytes=readFileSync(file);
  if(/(?:^|\/)\.env(?:\.|$)/i.test(label)&&!/(?:^|\/)\.env\.(?:example|sample)$/i.test(label)||/\.(?:sqlite|sqlite3|db|pem|pfx|key|pcm|wav)$/i.test(label)||/(?:^|\/)\.data\//.test(label))findings.push({file:label,kind:'private-file-or-raw-audio'});
  for(const [key,value] of secrets)if(bytes.includes(Buffer.from(value)))findings.push({file:label,kind:`configured-secret:${key}`});
  if(/\.(?:[cm]?[jt]sx?|html|json|css|md|txt)$/i.test(label)){
    const text=bytes.toString('utf8');
    if(/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))findings.push({file:label,kind:'credential-pattern'});
    if(/https?:\/\/[^\s"'<>]+[?&](?:cap|capability|token)=[A-Za-z0-9_-]{24,}/.test(text))findings.push({file:label,kind:'literal-capability-url'});
    if(uniquePrivate.some(value=>text.includes(value)))findings.push({file:label,kind:'exact-private-source-text-match-needs-review'});
    if(publicBundle&&/\.js$/.test(label))for(const [kind,pattern] of [['local-owner-client',/OwnerHttpClient|\/api\/owner\//],['local-capture',/getUserMedia|\/api\/audio\//],['local-auth-link',/\/api\/auth\/twitch|\/api\/auth\/overlay/],['server-module',/node:sqlite|TokenVault|process\.env\.(?:PUBLISH_SHARED_SECRET|OPENAI_API_KEY)/]] as const)if(pattern.test(text))findings.push({file:label,kind});
  }
}
let publicFiles:string[]=[],publicBuildSucceeded=false;
try{
  for(const file of tracked)if(existsSync(file)&&statSync(file).isFile())inspect(resolve(file),file,false);
  for(const path of ignorePaths)if(!ignored.includes(path))findings.push({file:path,kind:'not-gitignored'});
  try{await build({configFile:resolve('vite.config.ts'),mode:'public',logLevel:'silent',build:{outDir:out,emptyOutDir:true}});publicBuildSucceeded=true;publicFiles=files(out);for(const file of publicFiles)inspect(file,'fresh-public/'+relative(out,file).replaceAll('\\','/'),true);}
  catch{notes.push({file:'fresh-public',kind:'build-incomplete-no-public-isolation-conclusion'});}
  const staleFiles=existsSync('dist-public')?files(resolve('dist-public')).filter(file=>/LocalExperience|FoundationShowcase/.test(file)).map(file=>relative(root,file).replaceAll('\\','/')):[];
  for(const file of staleFiles)notes.push({file,kind:'local-or-dev-chunk-in-existing-artifact-review-fresh-build-before-deploy'});
  if(existsSync(join(out,'worklets','pcm-capture.js')))notes.push({file:'fresh-public/worklets/pcm-capture.js',kind:'static-worklet-copied-without-microphone-entrypoint'});
  const result={checkedAt:new Date().toISOString(),scope:'Tracked files plus a fresh public-mode Vite build in a separate temporary directory. Exact comparisons against configured secrets and up to2000 recent nontrivial source strings per top-level private SQLite database. No values or matching lines are emitted. Not a deployed-host or complete historical transcript/audio audit.',trackedFiles:tracked.length,publicBuildSucceeded,publicFiles:publicFiles.length,configuredSecretValues:secrets.length,privateDatabaseSamples,uniquePrivateStrings:uniquePrivate.length,ignoreChecks:ignorePaths.map(file=>({file,ignored:ignored.includes(file)})),findings,notes};
  mkdirSync('docs/testing/reliability',{recursive:true});writeFileSync('docs/testing/reliability/release-audit.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(findings.length||!publicBuildSucceeded)process.exitCode=1;
}finally{if(!resolve(temp).startsWith(resolve(tmpdir())+sep)||!temp.includes('previously-public-audit-'))throw Error('Unsafe audit cleanup');rmSync(temp,{recursive:true,force:true});}
