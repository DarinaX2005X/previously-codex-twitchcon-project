/** Isolated smoke for the documented replay startup. Never connects provider accounts. */
import assert from 'node:assert/strict';
import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../../src/server/index.js';
import { loadConfig, readLocalEnvironment } from '../../src/server/runtime/config.js';
import { ReplayGate } from '../../src/replay/gate.js';
import { ReplayDriver } from '../../src/replay/driver.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const local=readLocalEnvironment(root);
if(!local.LOCAL_TLS_PASSPHRASE)throw new Error('Run npm run setup:local before this check.');
const ca=new X509Certificate(await readFile(resolve(root,'.data/tls/localhost.cer'))).toString();
const temporary=await mkdtemp(join(tmpdir(),'previously-keyless-'));
const config=loadConfig({
  DATA_DIR:join(temporary,'data'),LOCAL_TLS_PFX:resolve(root,local.LOCAL_TLS_PFX??'.data/tls/localhost.pfx'),
  LOCAL_TLS_PASSPHRASE:local.LOCAL_TLS_PASSPHRASE,
  SESSION_SECRET:randomBytes(32).toString('base64'),TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('base64'),
  OPENAI_PAID_CALLS_ENABLED:'false',
},root);
const originalFetch=globalThis.fetch;
let externalFetches=0;
globalThis.fetch=async()=>{externalFetches++;throw new Error('External fetch is forbidden in keyless verification.');};
let runtime:Awaited<ReturnType<typeof startRuntime>>|undefined;
let gate:ReplayGate|undefined;
try {
  // Only this probe chooses an ephemeral port. Normal startup remains localhost:4317.
  runtime=await startRuntime({config:{...config,port:0},cwd:root,replay:true});
  const address=runtime.server.address();assert(address&&typeof address!=='string');
  const get=(path:string)=>new Promise<Response>((done,reject)=>{
    const req=request({hostname:'127.0.0.1',port:address.port,servername:'localhost',ca,path,headers:{Host:'localhost:4317'}},res=>{
      const parts:Buffer[]=[];res.on('data',chunk=>parts.push(Buffer.from(chunk)));
      res.on('end',()=>{const headers=new Headers();for(const [name,value]of Object.entries(res.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);done(new Response(Buffer.concat(parts),{status:res.statusCode,headers}));});res.on('error',reject);
    });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('Local request timed out.')));req.end();
  });
  assert.equal((await get('/health')).status,200);
  const ready=await(await get('/ready')).json();assert.equal(ready.ready,true);assert.equal(ready.configuration,'incomplete');
  const setup=await(await get('/api/setup/status')).json();assert.equal(setup.mode,'replay');assert.equal(setup.openai.paidCallsEnabled,false);assert.equal(setup.auth.available,false);
  assert.equal((await get('/replay')).status,200);
  const fetcher:typeof fetch=async input=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,'https://localhost:4317');
    return get(url.pathname+url.search);
  };
  gate=new ReplayGate('/api/public/replays/foxlight',()=>{},fetcher);
  const bundle=await gate.load();assert.equal(bundle.origin,'authored');assert.equal(bundle.media.length,4);
  const driver=new ReplayDriver(bundle,'documentation-smoke');driver.control({action:'seek',milestone:'published'});
  assert.equal(driver.snapshot().published?.chapters.length,1);
  driver.control({action:'seek',milestone:'raid'});assert.equal(driver.snapshot().published?.chapters.length,4);assert(driver.snapshot().playback.some(item=>item.plan));
  assert.equal(externalFetches,0);
  console.log('Keyless check passed: isolated SQLite, trusted HTTPS, replay manifest integrity, published chapter and raid plan; no external fetches.');
} finally {
  gate?.dispose();await runtime?.close();globalThis.fetch=originalFetch;
  const target=resolve(temporary),boundary=resolve(tmpdir())+sep;
  if(!target.startsWith(boundary)||!target.split(sep).at(-1)?.startsWith('previously-keyless-'))throw new Error('Unexpected temporary directory.');
  await rm(target,{recursive:true,force:true});
}
