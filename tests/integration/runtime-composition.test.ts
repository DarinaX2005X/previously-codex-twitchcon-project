import {describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStorage} from '../../src/server/storage/index.js';
import {createLiveRuntime} from '../../src/server/runtime/live.js';
import {loadConfig} from '../../src/server/runtime/config.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';

describe('live application composition', () => {
  it('starts and stops with no token, no microphone action and paid mode off without reaching any provider', async () => {
    const path = mkdtempSync(join(tmpdir(), 'previously-composition-'));
    const clock = {now: () => Date.now(), iso: () => new Date().toISOString()};
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
    const storage = createStorage({path: join(path, 'state.sqlite'), encryptionKey: Buffer.alloc(32, 7)});
    const updates = new RevisionStream();
    let live: Awaited<ReturnType<typeof createLiveRuntime>> = null;
    try {
      const config = loadConfig({DATA_DIR: path, SESSION_SECRET: 's'.repeat(32), TWITCH_CLIENT_ID: 'authored', TWITCH_CLIENT_SECRET: 'authored', TWITCH_CHANNEL_LOGIN: 'authored_fixture', OPENAI_API_KEY: 'unused-authored-key', OPENAI_PAID_CALLS_ENABLED: 'false'}, path);
      live = await createLiveRuntime({config, storage, updates, clock, channel: {id: '123456', login: 'authored_fixture', displayName: 'Authored fixture'}});
      expect(live).not.toBeNull();
      await live!.start();
      expect(live!.setup().twitch.connected).toBe(false);
      expect(live!.setup().openai.paidCallsEnabled).toBe(false);
      expect(live!.engine.activeSessionId()).toBeNull();
      await live!.close();
      expect(fetcher).not.toHaveBeenCalled();
      expect(storage.budget.status().usedMicroUsd).toBe(0);
    } finally {await live?.close(); updates.close(); storage.close(); fetcher.mockRestore(); rmSync(path, {recursive: true, force: true});}
  });
});
