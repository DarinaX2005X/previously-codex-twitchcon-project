import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { BlobPreconditionFailedError, del, get, put } from '@vercel/blob';

// Opt-in account validation. Only this run's generated probe pathname is mutated.
const environment = { ...parseEnv(readFileSync('.env.local', 'utf8')), ...process.env };
const token = environment.BLOB_READ_WRITE_TOKEN;
assert(token, 'The linked private store must be configured in .env.local.');
const pathname = `verification/${randomUUID()}/cas.json`;
const options = { token, access: 'private' as const, addRandomSuffix: false, contentType: 'application/json' };
let created = false;
try {
  const initial = await put(pathname, JSON.stringify({ revision: 1, kind: 'authored-storage-probe' }), options);
  created = true;
  const privateRead = await get(pathname, { token, access: 'private', useCache: false });
  assert(privateRead?.statusCode === 200);
  assert.equal((await new Response(privateRead.stream).json()).revision, 1);
  const anonymous = await fetch(initial.url);
  assert([401, 403, 404].includes(anonymous.status), 'A private object must reject anonymous reads.');
  await anonymous.body?.cancel();

  const raced = await Promise.allSettled([2, 3].map(revision => put(pathname,
    JSON.stringify({ revision, kind: 'authored-storage-probe' }),
    { ...options, allowOverwrite: true, ifMatch: initial.etag })));
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
  const loser = raced.find(result => result.status === 'rejected');
  assert(loser?.status === 'rejected' && loser.reason instanceof BlobPreconditionFailedError);
  const winnerIndex = raced.findIndex(result => result.status === 'fulfilled');
  const latest = await get(pathname, { token, access: 'private', useCache: false });
  assert(latest?.statusCode === 200);
  assert.equal((await new Response(latest.stream).json()).revision, winnerIndex + 2);
  console.log('Private Blob verified: authenticated read, anonymous denial, one CAS winner, uncached latest read.');
} finally {
  if (created) await del(pathname, { token });
}
