import {afterEach, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chatIntakeFixture, flushIntake} from './acceptance-chat-fixture.js';
afterEach(() => vi.useRealTimers());

it('already-queued chat batches stay bounded and a durable deletion wins before the remaining FIFO drains', async () => {
  const f = await chatIntakeFixture(); let release!: () => void, began!: () => void;
  const entered = new Promise<void>(resolve => {began = resolve;});
  const original = f.engine.ingestBatch.bind(f.engine);
  const batches: string[][] = [];
  const spy = vi.spyOn(f.engine, 'ingestBatch').mockImplementation(async items => {
    batches.push(items.map(item => item.externalId));
    if (items[0].externalId === 'first') {began(); await new Promise<void>(resolve => {release = resolve;});}
    await original(items);
  });
  try {
    f.sockets[0].wire(f.wire('first')); await entered;
    for (let i = 1; i <= 45; i++) f.sockets[0].wire(f.wire(String(i)));
    f.sockets[0].wire(f.wire('delete-10', 'channel.chat.message_delete', {message_id: '10'}));
    f.sockets[0].wire(f.wire('raid', 'channel.raid', {to_broadcaster_user_id: '123', from_broadcaster_user_login: 'authored_raider', viewers: 3}));
    release(); await flushIntake();
    expect(batches.map(items => items.length)).toEqual([1, 20, 20, 5]);
    expect(batches.flat()).toEqual(['first', ...Array.from({length: 45}, (_, i) => String(i + 1))]);
    expect(f.storage.repository.getSource(f.scope, 'chat:10')?.text ?? null).toBeNull();
    expect(f.storage.repository.getSource(f.scope, 'chat:45')?.text).toBe('Authored source 45');
    expect(f.engine.state('stream_batch').playbacks).toHaveLength(1);
    expect(f.states).not.toContain('gap');
  } finally {release?.(); spy.mockRestore(); await f.close();}
});

it('a rolled-back batch keeps its FIFO head, retries after reconnect, and does not send commands before commit', async () => {
  vi.useFakeTimers(); const committed: string[] = [];
  const f = await chatIntakeFixture({publicOrigin: 'https://authored.invalid', onCommitted: value => {if (value.event.type === 'source') committed.push(value.event.source.id);}});
  const original = f.storage.repository.applyDomainTransition.bind(f.storage.repository); let calls = 0;
  const failure = vi.spyOn(f.storage.repository, 'applyDomainTransition').mockImplementation((...args) => {
    if (++calls === 2) throw new Error('Authored batch rollback'); return original(...args);
  });
  const batches = vi.spyOn(f.engine, 'ingestBatch');
  const wires = [f.wire('one'), f.wire('two', 'channel.chat.message', {message: {text: '!previously'}}), f.wire('three')];
  try {
    for (const wire of wires) f.sockets[0].wire(wire); await flushIntake();
    expect(f.transport.status().state).toBe('gap'); expect(committed).toHaveLength(0); expect(f.sends()).toBe(0);
    for (const id of ['one', 'two', 'three']) {expect(f.storage.repository.getSource(f.scope, `chat:${id}`)).toBeNull(); expect(f.storage.repository.controlGet(f.scope, `eventsub:${id}`)).toBeNull();}
    failure.mockRestore(); await vi.advanceTimersByTimeAsync(1000); await f.welcome(); await flushIntake();
    expect(batches.mock.calls.map(([items]) => items.map(item => item.externalId))).toEqual([['one', 'two', 'three'], ['one', 'two', 'three']]);
    expect(committed).toEqual(['chat:one', 'chat:two', 'chat:three']);
    await f.runtime.tick(); expect(f.sends()).toBe(1);
    for (const wire of wires) f.sockets.at(-1)!.wire(wire); await flushIntake(); await f.runtime.tick();
    expect(committed).toHaveLength(3); expect(f.sends()).toBe(1);
  } finally {failure.mockRestore(); batches.mockRestore(); await f.close();}
});

it('committed batch receipts survive adapter/SQLite reopen when transport completion acknowledgement failed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'previously-chat-batch-')), path = join(directory, 'state.sqlite');
  let f = await chatIntakeFixture({path});
  const wires = [f.wire('committed-one'), f.wire('committed-two')];
  const put = f.storage.repository.controlPut.bind(f.storage.repository); let failed = false;
  const spy = vi.spyOn(f.storage.repository, 'controlPut').mockImplementation((scope, key, value, expires) => {
    if (!failed && key.startsWith('eventsub:committed-') && (value as {status?: string})?.status === 'done') {failed = true; throw new Error('Authored transport ACK write failure');}
    return put(scope, key, value, expires);
  });
  try {
    for (const wire of wires) f.sockets[0].wire(wire); await flushIntake();
    expect(f.transport.status().state).toBe('gap'); expect(f.storage.repository.getSource(f.scope, 'chat:committed-two')?.text).toBeTruthy();
    spy.mockRestore(); await f.close();
    f = await chatIntakeFixture({path}); const repeated = vi.spyOn(f.engine, 'ingestBatch');
    for (const wire of wires) f.sockets[0].wire(wire); await flushIntake();
    expect(repeated).not.toHaveBeenCalled(); expect(f.storage.repository.getSource(f.scope, 'chat:committed-one')?.revision).toBe(1);
    expect(f.storage.repository.controlGet(f.scope, 'eventsub:committed-two')).toEqual({status: 'done'});
  } finally {spy.mockRestore(); await f.close(); rmSync(directory, {recursive: true, force: true});}
});
