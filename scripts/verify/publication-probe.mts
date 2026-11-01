import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { VercelBlobStore } from '../../src/cloud/blob-store.js';
import { runBlobSmoke } from '../../tests/publication/live-store-smoke.js';

const environment = {...parseEnv(readFileSync('.env.local', 'utf8')), ...process.env};
if (!environment.BLOB_READ_WRITE_TOKEN) throw new Error('Link the private Blob store first.');
// This login/ID pair is a verification namespace, never the configured Twitch identity.
const result = await runBlobSmoke({store: new VercelBlobStore(environment.BLOB_READ_WRITE_TOKEN), channelLogin: 'previously_probe', channelId: 'previously_probe_storage'});
console.log(JSON.stringify({passed: result.passed, finalPublishSeq: result.publishSeq}));
