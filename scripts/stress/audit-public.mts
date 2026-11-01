/** Never emits secret values or matching lines, only paths and finding kinds. */
import {existsSync,readFileSync,readdirSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'dotenv';
const root=process.cwd(),roots=['public','dist-public','dist'],findings:{file:string;kind:string}[]=[],files:string[]=[];
function walk(dir:string){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(entry.isFile())files.push(path);}}
for(const path of roots)if(existsSync(path))walk(resolve(path));
const env=existsSync('.env')?parse(readFileSync('.env')):{},secrets=Object.entries(env).filter(([key,value])=>/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(key)&&value.length>=16);
for(const file of files){const name=relative(root,file).replaceAll('\\','/'),bytes=readFileSync(file);
  if(/(?:^|\/)\.env(?:\.|$)|\.(?:sqlite|sqlite3|pem|key|pcm|wav)$/i.test(name))findings.push({file:name,kind:'private-file-or-raw-audio-extension'});
  for(const [key,value] of secrets)if(bytes.includes(Buffer.from(value)))findings.push({file:name,kind:`configured-secret:${key}`});
  if(/\.(?:js|html|json|css|txt|map)$/i.test(name)){
    const content=bytes.toString('utf8');
    for(const [kind,regex] of [['openai-key',/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['literal-capability-url',/https?:\/\/[^\s"'<>]+[?&](?:cap|capability|token)=[A-Za-z0-9_-]{24,}/]] as const)if(regex.test(content))findings.push({file:name,kind});
  }
}
const result={scope:'Current filesystem public/, dist-public/, dist/ artifacts against configured secret values and narrow high-confidence patterns. Not tracked-file, deployed-host or semantic transcript review.',checkedAt:new Date().toISOString(),files:files.length,totalBytes:files.reduce((n,f)=>n+statSync(f).size,0),configuredSecretsCompared:secrets.length,roots:roots.filter(existsSync),inputs:['vite.config.ts','vercel.json'].map(file=>({file,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')})),findings};
mkdirSync('docs/testing/reliability',{recursive:true});writeFileSync('docs/testing/reliability/public-audit.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(findings.length)process.exitCode=1;
