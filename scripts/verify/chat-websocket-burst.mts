// Independent producer thread + actual loopback WebSocket; all Helix/providers remain authored fixtures.
import {Worker} from 'node:worker_threads';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import WebSocket from 'ws';
import {chatIntakeFixture} from '../../tests/integration/acceptance-chat-fixture.js';
const rate = 200, count = 12000, directory = mkdtempSync(join(tmpdir(), 'previously-ws-burst-'));
const output = resolve(process.argv[2] ?? 'docs/testing/functional/chat-websocket-burst.json');
const producer = new Worker(new URL('./chat-burst-producer.mjs', import.meta.url), {workerData: {rate, count}});
let finish!: (value: any) => void, ready!: (port: number) => void;
const readyPort = new Promise<number>(done => {ready = done;}), finished = new Promise<any>(done => {finish = done;});
producer.on('message', value => {if (value.type === 'ready') ready(value.port); if (value.type === 'done') finish(value);});
const port = await readyPort, received = new Map<string, {received: number; planned: number; offered: number}>(), committed = new Map<string, number>();
const requestedDeletes = new Set<string>(), receivedDeletes = new Set<string>(), appliedDeletes = new Set<string>(), memory: unknown[] = [], batchSizes: number[] = [];
let duplicateCommits = 0, maxQueue = 0, receiveFrames = 0, sampleTimer: ReturnType<typeof setInterval> | undefined;
let fixture: Awaited<ReturnType<typeof chatIntakeFixture>> | undefined;
const stats = (values: number[]) => {const sorted = values.toSorted((a, b) => a - b), at = (n: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * n))] ?? 0; return {samples: sorted.length, p50: at(.5), p95: at(.95), max: at(1)};};
try {
  fixture = await chatIntakeFixture({path: join(directory, 'state.sqlite'), externalSocketFactory: () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.on('message', raw => {
      const value = JSON.parse(raw.toString());
      if(value.payload?.subscription?.type==='channel.chat.message_delete')receivedDeletes.add(value.payload.event.message_id);
      if (value.payload?.subscription?.type !== 'channel.chat.message') return;
      const event = value.payload.event; receiveFrames++;
      received.set(event.message_id, {received: Date.now(), planned: event.fixturePlannedAt, offered: event.fixtureOfferedAt});
      queueMicrotask(() => {if (fixture) maxQueue = Math.max(maxQueue, fixture.transport.diagnostics().queuedOrdinary);});
    });
    return socket;
  }, onCommitted: value => {
    if (value.event.type === 'privacy' && value.event.target.kind === 'message') appliedDeletes.add(value.event.target.externalMessageId);
    if (value.event.type !== 'source') return;
    const id = value.event.source.id.replace(/^chat:/, ''); if (committed.has(id)) duplicateCommits++; committed.set(id, Date.now());
    if (committed.size % 100 === 0) {requestedDeletes.add(id); producer.postMessage({type: 'delete', id});}
  }});
  const f = fixture, batch = f.engine.ingestBatch.bind(f.engine);
  f.engine.ingestBatch = async items => {batchSizes.push(items.length); await batch(items);};
  const sample = () => {globalThis.gc?.(); const usage = process.memoryUsage(); memory.push({at: Date.now(), committed: committed.size, queued: f.transport.diagnostics().queuedOrdinary, heapUsed: usage.heapUsed, rss: usage.rss});};
  sample(); sampleTimer = setInterval(sample, 10000);
  producer.postMessage({type: 'start'});
  const production = await finished;
  process.stdout.write(`Producer finished: ${production.offered} offers in ${production.ended - production.started} ms; ${committed.size} committed so far.\n`);
  const deadline = Date.now() + 30000;
  while ((f.transport.diagnostics().queuedOrdinary > 0 || receivedDeletes.size > appliedDeletes.size || f.transport.diagnostics().privacyDraining) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  sample(); clearInterval(sampleTimer);
  const ids = [...committed.keys()], state = f.engine.state('stream_batch');
  const result = {scope: 'Independent authored producer thread over actual loopback WebSocket into real EventSub/runtime/engine/file SQLite; no live Twitch or providers.', plannedRate: rate, plannedWindowMs: count * 1000 / rate, producer: production, receivedFrames: receiveFrames, receivedUnique: received.size, committedUnique: committed.size, duplicateCommits, rejectedReceived: received.size - committed.size, maxQueuedOrdinary: maxQueue, remainingOrdinary: f.transport.diagnostics().queuedOrdinary, gaps: f.states.filter(value => value === 'gap').length,
    receiveToCommitMs: stats(ids.map(id => committed.get(id)! - received.get(id)!.received)), offeredToCommitMs: stats(ids.map(id => committed.get(id)! - received.get(id)!.offered)), plannedToCommitMs: stats(ids.map(id => committed.get(id)! - received.get(id)!.planned)),
    batchSizes: Object.fromEntries([...new Set(batchSizes)].sort((a, b) => a - b).map(size => [size, batchSizes.filter(value => value === size).length])),
    privacy: {requested: requestedDeletes.size, received:receivedDeletes.size, missedDuringGap:requestedDeletes.size-receivedDeletes.size, applied: appliedDeletes.size, allReceivedTargetsWithdrawn: [...receivedDeletes].every(id => f.storage.repository.getSource(f.scope, `chat:${id}`)?.text == null)}, stateBounds: {retainedSources: state.sources.length, nodes: Object.keys(state.nodes).length, candidates: state.candidates.length}, memory, ended: Date.now(), paidMicroUsd: f.storage.budget.status().usedMicroUsd};
  mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (maxQueue > 100 || duplicateCommits || result.remainingOrdinary || result.privacy.received !== result.privacy.applied || !result.privacy.allReceivedTargetsWithdrawn) process.exitCode = 1;
} finally {
  if (sampleTimer) clearInterval(sampleTimer); await fixture?.close(); producer.postMessage({type: 'stop'}); await producer.terminate(); rmSync(directory, {recursive: true, force: true});
}
