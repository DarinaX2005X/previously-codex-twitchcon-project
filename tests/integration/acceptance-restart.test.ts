import {it, expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

it('acceptance: chat/clip business keys and pending clip poll survive two actual Node processes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'previously-outbox-restart-'));
  const worker = fileURLToPath(new URL('../../scripts/verify/outbox-restart-worker.mts', import.meta.url));
  const exec = promisify(execFile);
  try {
    const run = async (phase: string) => JSON.parse((await exec(process.execPath, ['--import', 'tsx', worker, join(directory, 'state.sqlite'), phase], {windowsHide: true, timeout: 10000})).stdout);
    const first = await run('enqueue');
    expect(first).toMatchObject({sends: 1, creates: 1, polls: 0, prepares: 0, clipStates: ['pending'], ownEcho: true, pendingPolls: 1, paidMicroUsd: 0});
    const second = await run('recover');
    expect(second.pid).not.toBe(first.pid);
    expect(second).toMatchObject({chat: {queued: false, reason: 'duplicate'}, sends: 0, creates: 0, polls: 1, prepares: 1, clipStates: ['ready'], ownEcho: true, pendingPolls: 0, paidMicroUsd: 0});
  } finally {rmSync(directory, {recursive: true, force: true});}
}, 20000);

it('acceptance: durable privacy controls replay after a process dies inside the first ingest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'previously-privacy-restart-'));
  const worker = fileURLToPath(new URL('../../scripts/verify/eventsub-restart-worker.mts', import.meta.url));
  const exec = promisify(execFile);
  try {
    const run = async (phase: string) => JSON.parse((await exec(process.execPath, ['--import', 'tsx', worker, join(directory, 'state.sqlite'), phase], {windowsHide: true, timeout: 10000})).stdout);
    const first = await run('crash'); expect(first).toMatchObject({started: ['durable-0'], pending: 3, claim: {status: 'processing'}});
    const second = await run('recover'); expect(second.pid).not.toBe(first.pid);
    expect(second).toMatchObject({received: ['durable-0', 'durable-1', 'durable-2'], pending: 0, claim: {status: 'done'}});
  } finally {rmSync(directory, {recursive: true, force: true});}
}, 20000);
