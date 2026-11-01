import {readFileSync, existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {VercelBlobStore} from '../src/cloud/blob-store.js';
import {PublicationService} from '../src/cloud/service.js';
import {buildAuthoredExport} from '../src/server/replay/export.js';
import {signedHeaders} from '../src/cloud/signing.js';
import {encodeAssetUpload} from '../src/cloud/http.js';

const local = (file: string) => existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
const env = {...local('.env'), ...local('.env.local'), ...process.env};
const origin = env.RECAP_PUBLIC_ORIGIN, secret = env.PUBLISH_SHARED_SECRET, token = env.BLOB_READ_WRITE_TOKEN;
const channelLogin = process.argv[2], channelId = process.argv[3];
if (!origin || new URL(origin).protocol !== 'https:' || !secret || !token || !channelLogin || !channelId) throw new Error('Supply the configured channel login/id and private cloud configuration.');
const service = new PublicationService({store: new VercelBlobStore(token), channelLogin});
const current = await service.getHead(channelId), existing = current?.head.exports.find(item => item.id === 'authored-notes');
if (existing) {
  if (existing.status === 'revoked') throw new Error('The authored recording is withdrawn. Rebuild with a reviewed new revision before publishing.');
  console.log('The authored recording is already registered.');
} else {
  const {manifest, assets} = buildAuthoredExport();
  const base = {channelId, channelLogin, publishSeq: (current?.head.publishSeq ?? 0) + 1, privacyRevision: current?.head.privacyRevision ?? 0};
  const send = async (path: string, bytes: Uint8Array) => {
    const response = await fetch(`${origin}${path}`, {method: 'POST', headers: {...signedHeaders(secret, 'POST', path, channelId, base.publishSeq, bytes, Date.now()), 'Content-Type': 'application/octet-stream'}, body: new Uint8Array(bytes), redirect: 'error', signal: AbortSignal.timeout(30_000)});
    if (!response.ok) throw new Error(`Replay publication failed with HTTP ${response.status}.`);
  };
  for (const {asset, bytes} of assets) await send('/api/publish/export-assets', encodeAssetUpload({...base, exportId: manifest.id, revision: manifest.revision, asset}, bytes));
  await send('/api/publish', new TextEncoder().encode(JSON.stringify({...base, operation: 'export_manifest', manifest})));
  console.log('The authored recording is registered behind the current manifest gate.');
}
