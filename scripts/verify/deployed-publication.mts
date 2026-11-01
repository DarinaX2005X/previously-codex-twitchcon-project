import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {VercelBlobStore} from '../../src/cloud/blob-store.js';
import {signedHeaders, sha256} from '../../src/cloud/signing.js';
import {encodeAssetUpload} from '../../src/cloud/http.js';
import type {PublicationOperation} from '../../src/cloud/contracts.js';
import type {PublicSnapshot} from '../../src/shared/contracts/index.js';

const env = {...parseEnv(readFileSync('.env', 'utf8')), ...parseEnv(readFileSync('.env.local', 'utf8')), ...process.env};
const origin = env.PROBE_ORIGIN, secret = env.PUBLISH_SHARED_SECRET, token = env.BLOB_READ_WRITE_TOKEN;
if (!origin || !secret || !token || new URL(origin).protocol !== 'https:') throw new Error('Set the HTTPS probe origin and local cloud credentials.');
const channelLogin = 'previously_verify', channelId = 'previously_verify_http';
const store = new VercelBlobStore(token);
const prior = await store.get(`channels/${channelId}/head.json`);
const previous = prior ? JSON.parse(new TextDecoder().decode(prior.bytes)) : null;
let sequence = Number(previous?.publishSeq ?? 0), privacyRevision = Number(previous?.privacyRevision ?? 0);
const sessionId = `http_probe_${Date.now()}`, exportId = `${sessionId}_replay`;
const passed: string[] = [];
function assert(value: unknown, label: string): asserts value {if (!value) throw new Error(`Deployed check failed: ${label}`); passed.push(label);}
const send = async (path: string, body: string | Uint8Array, seq: number) => {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const headers = signedHeaders(secret!, 'POST', path, channelId, seq, bytes, Date.now());
  return fetch(`${origin}${path}`, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: new Uint8Array(bytes), redirect: 'error', signal: AbortSignal.timeout(30_000)});
};
const operation = async (value: PublicationOperation) => {
  const response = await send('/api/publish', JSON.stringify(value), value.publishSeq);
  if (!response.ok) throw new Error(`Publication failed with HTTP ${response.status}`);
  return response.json();
};
const get = (path: string, headers?: Record<string, string>) => fetch(`${origin}${path}`, {headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000)});
const now = new Date().toISOString();
const snapshot: PublicSnapshot = {schemaVersion: 1, channel: {id: channelId, login: channelLogin, displayName: 'Authored verification'}, session: {id: sessionId, title: 'Authored HTTP verification', category: 'Software and Game Development', startedAt: now, endedAt: null, status: 'live', metadataMaxDependencyEndMs: 0}, revision: 1, privacyEpoch: 0, language: 'en', asOf: now, publishedAt: now, liveLeaseUntil: new Date(Date.now() + 30_000).toISOString(), current: {goal: null, change: null, now: 'Checking signed publication.', sourceTimeMs: 0, maxDependencyEndMs: 0}, chapters: [], lore: [], moments: [], gaps: [], lastSyncedAt: null, vodUrl: null};
try {
  const unsigned = await fetch(`${origin}/api/publish`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  assert(unsigned.status === 401, 'unsigned publication rejected');
  const first: PublicationOperation = {operation: 'snapshot', channelId, channelLogin, publishSeq: ++sequence, privacyRevision, snapshots: [snapshot], activeSessionId: sessionId, liveLeaseUntil: snapshot.liveLeaseUntil};
  await operation(first); const duplicate = await operation(first);
  assert(duplicate.publishSeq === sequence, 'same-body retry acknowledged');
  assert((await send('/api/publish', JSON.stringify({...first, activeSessionId: null}), sequence)).status === 409, 'same-sequence changed body rejected');
  const response = await get(`/api/public/channels/${channelLogin}`);
  const read = await response.json();
  assert(response.status === 200 && read.session.id === sessionId && read.current.now === snapshot.current!.now, 'deployed public read matches published state');
  assert(response.headers.get('cache-control')?.includes('no-store'), 'deployed public read disables caching');
  const bytes = new TextEncoder().encode('{"origin":"authored","probe":true}');
  const asset = {id: 'events', hash: sha256(bytes), bytes: bytes.length, mime: 'application/json' as const, kind: 'events' as const};
  const exportSequence = ++sequence;
  const upload = await send('/api/publish/export-assets', encodeAssetUpload({channelId, channelLogin, publishSeq: exportSequence, privacyRevision, exportId, revision: 1, asset}, bytes), exportSequence);
  assert(upload.ok, 'signed replay asset uploaded');
  await operation({operation: 'export_manifest', channelId, channelLogin, publishSeq: exportSequence, privacyRevision, manifest: {schemaVersion: 1, id: exportId, revision: 1, origin: 'authored', sourceSessionId: sessionId, durationMs: 1000, bundleHash: sha256(bytes), assets: [asset], milestones: [], providerVersions: {probe: 'authored'}}});
  assert((await get(`/api/public/replays/${exportId}?revision=1`)).status === 200, 'current replay manifest readable');
  const assetUrl = `/api/public/replays/${exportId}/assets/events?revision=1`;
  const range = await get(assetUrl, {Range: 'bytes=0-3'});
  assert(range.status === 206 && (await range.arrayBuffer()).byteLength === 4, 'deployed private asset range gated');
  assert((await get(`/api/public/replays/${exportId}?revision=0`)).status === 410, 'old replay revision rejected');
  const finished = {...snapshot, revision: 2, session: {...snapshot.session, status: 'finalized' as const, endedAt: new Date().toISOString()}, liveLeaseUntil: null};
  await operation({operation: 'snapshot', channelId, channelLogin, publishSeq: ++sequence, privacyRevision, snapshots: [finished], activeSessionId: null, liveLeaseUntil: null});
  assert((await get(`/api/public/sessions/${sessionId}`)).status === 200, 'finalized episode readable without live lease');
  await operation({operation: 'retract', channelId, channelLogin, publishSeq: ++sequence, privacyRevision: ++privacyRevision, sessionIds: [sessionId], exportIds: [exportId], snapshots: []});
  assert((await get(assetUrl)).status === 410, 'old asset URL revoked');
  assert((await get(`/api/public/sessions/${sessionId}`)).status === 410, 'forgotten episode revoked');
  assert((await send('/api/publish', JSON.stringify(first), first.publishSeq)).status === 409, 'stale publication cannot restore forgotten state');
} finally {
  // The isolated authored namespace has no user data. Retraction remains the first cleanup step.
  await operation({operation: 'retract', channelId, channelLogin, publishSeq: ++sequence, privacyRevision: ++privacyRevision, sessionIds: [sessionId], exportIds: [exportId], snapshots: []});
  const paths = (await store.list(`channels/${channelId}/objects/`)).paths.filter(path => path.includes(sessionId) || path.includes(exportId));
  if (paths.length) {
    const cleanup = await send('/api/publish/maintenance', JSON.stringify({channelId, publishSeq: sequence, paths: paths.slice(0, 100)}), sequence);
    if (!cleanup.ok) throw new Error(`Probe cleanup failed with HTTP ${cleanup.status}`);
  }
}
console.log(JSON.stringify({origin, passed, authored: true}));
