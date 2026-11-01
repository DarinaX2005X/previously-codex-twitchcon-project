// Paced authored socket traffic through real EventSub/runtime/engine/SQLite. No network/provider work.
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {chatIntakeFixture} from '../../tests/integration/acceptance-chat-fixture.js';
const rate = Number(process.argv[2] ?? 20), count = Number(process.argv[3] ?? 1000), warmup = Math.min(500, Math.floor(count / 2)), overload = process.argv.includes('--overload');
if (!Number.isInteger(count) || count < 20 || count > 12000 || !Number.isFinite(rate) || rate <= 0 || rate > 200) throw new Error('Expected rate <=200 and count20..12000');
const directory = mkdtempSync(join(tmpdir(), 'previously-intake-benchmark-'));
const received = new Map<string, number>(), planned = new Map<string, number>(), completed = new Map<string, number>();
const batchSizes: number[] = [], batchDurations: number[] = [];
const privacyTargets = new Set<string>(), privacyApplied = new Set<string>(), memory: {offered: number; heapUsed: number; rss: number}[] = [];
let maxQueue = 0, detachedOffers = 0;
const f = await chatIntakeFixture({path: join(directory, 'state.sqlite'), autoWelcome: true, onCommitted: value => {
  if(value.event.type==='privacy'&&value.event.target.kind==='message')privacyApplied.add(value.event.target.externalMessageId);
  if (value.event.type !== 'source') return;
  const id = value.event.source.id.replace(/^chat:/, ''); completed.set(id, performance.now());
}});
const batch = f.engine.ingestBatch.bind(f.engine);
f.engine.ingestBatch = async items => {const at = performance.now(); batchSizes.push(items.length); await batch(items); batchDurations.push(performance.now() - at);};
const stats = (input: number[]) => {const values = input.slice().sort((a, b) => a - b); const at = (n: number) => Number((values[Math.min(values.length - 1, Math.floor(values.length * n))] ?? 0).toFixed(2)); return {samples: values.length, p50: at(0.5), p95: at(0.95), max: at(1)};};
try {
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const id = `paced-${i}`, target = started + i * 1000 / rate;
    const delay = target - performance.now(); if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    planned.set(id, target);
    const socket=f.sockets.at(-1)!;
    if(socket.listenerCount('message')){received.set(id,performance.now());socket.wire(f.wire(id));}else detachedOffers++;
    maxQueue=Math.max(maxQueue,f.transport.diagnostics().queuedOrdinary);
    if(overload&&f.transport.status().state==='active'&&i>100&&privacyTargets.size<Math.floor(i/1000)+1){
      const targetId=[...completed.keys()].at(-1);
      if(targetId&&!privacyTargets.has(targetId)){privacyTargets.add(targetId);socket.wire(f.wire(`delete-${i}`,'channel.chat.message_delete',{message_id:targetId}));}
    }
    if(i%2000===0){globalThis.gc?.();const usage=process.memoryUsage();memory.push({offered:i,heapUsed:usage.heapUsed,rss:usage.rss});}
    if (i === warmup) process.stdout.write(`Warmup dispatched: ${warmup}; received=${received.size}; committed=${completed.size}\n`);
  }
  const offeringEnded=performance.now();
  const deadline = performance.now() + 15000;
  while ((overload?f.transport.diagnostics().queuedOrdinary>0||f.transport.diagnostics().privacyDraining:completed.size<count) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const measured = Array.from({length: count - warmup}, (_, i) => `paced-${i + warmup}`).filter(id => completed.has(id));
  const last = Math.max(...completed.values()), firstMeasured = planned.get(`paced-${warmup}`)!,measurementEnded=Math.max(last,offeringEnded);
  globalThis.gc?.();const endingMemory=process.memoryUsage();memory.push({offered:count,heapUsed:endingMemory.heapUsed,rss:endingMemory.rss});
  const result = {scope: 'authored-socket-to-real-EventSub-runtime-engine-file-SQLite', overload, ratePerSecond: rate, count, warmup, offered:count, receivedByAttachedTransport:received.size, detachedOffers, committed: completed.size, uncommittedOffered:count-completed.size,maxQueuedOrdinary:maxQueue,
    measuredThroughputPerSecond: Number((measured.length / ((measurementEnded - firstMeasured) / 1000)).toFixed(2)),
    receiveToCommitMs: stats(measured.map(id => completed.get(id)! - received.get(id)!)), plannedToCommitMs: stats(measured.map(id => completed.get(id)! - planned.get(id)!)),
    ingressSchedulingDriftMs: stats(measured.map(id => received.get(id)! - planned.get(id)!)), batchSizes: Object.fromEntries([...new Set(batchSizes)].sort((a, b) => a - b).map(size => [size, batchSizes.filter(value => value === size).length])),
    engineBatchMs: stats(batchDurations), gaps: f.states.filter(state => state === 'gap').length, privacy:{requested:privacyTargets.size,applied:privacyApplied.size,allTargetsWithdrawn:[...privacyTargets].every(id=>f.storage.repository.getSource(f.scope,`chat:${id}`)?.text==null)},memory,offeringElapsedMs:Number((offeringEnded-started).toFixed(2)),lastCommitAtMs:Number((last-started).toFixed(2)),totalElapsedMs:Number((performance.now()-started).toFixed(2)),paidMicroUsd: f.storage.budget.status().usedMicroUsd};
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if(overload){if(maxQueue>100||privacyApplied.size!==privacyTargets.size||!result.privacy.allTargetsWithdrawn)process.exitCode=1;}
  else if (completed.size !== count || result.gaps) process.exitCode = 1;
} finally {await f.close(); rmSync(directory, {recursive: true, force: true});}
