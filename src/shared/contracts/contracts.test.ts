import { describe, expect, it } from 'vitest';
import { filterSnapshotAt, PublicSnapshotSchema, type PublicSnapshot } from './index.js';

const snapshot: PublicSnapshot = {
  schemaVersion: 1, channel: { id: 'c1', login: 'sample_channel', displayName: 'Sample channel' },
  session: { id: 's1', title: 'We fixed it', category: 'Software and Game Development', startedAt: '2026-11-01T18:00:00Z', endedAt: null, status: 'live', metadataMaxDependencyEndMs: 90000 },
  revision: 3, privacyEpoch: 0, language: 'en', asOf: '2026-11-01T18:01:30Z', publishedAt: '2026-11-01T18:02:45Z', liveLeaseUntil: '2026-11-01T18:03:15Z',
  current: { goal: 'Save the note', change: 'The note survived a reload', now: 'Checking a second reload', sourceTimeMs: 90000, maxDependencyEndMs: 90000 },
  chapters: [{ id: 'ch1', revision: 2, title: 'The fix worked', summary: 'The note survived after changing the key.', startMs: 10000, endMs: 90000, mood: 'relieved', claimIds: ['claim1'], momentIds: ['m1'], pinned: false, edited: false, sourceLabels: [], maxDependencyEndMs: 90000 }],
  lore: [], moments: [{ id: 'm1', startMs: 20000, endMs: 40000, label: 'The reload', triggerReasons: ['manual'], clip: null, mediaState: 'none', maxDependencyEndMs: 40000 }],
  gaps: [], lastSyncedAt: null, vodUrl: null,
};
describe('public contract', () => {
  it('does not accept hidden transcript data in a public projection', () => {
    expect(PublicSnapshotSchema.safeParse({ ...snapshot, transcript: 'private' }).success).toBe(false);
    expect(PublicSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it('removes a late conclusion from an early chapter and channel heading at the reading cutoff', () => {
    const early = filterSnapshotAt(snapshot, 50000);
    expect(early.current).toBeNull();
    expect(early.session.title).toBe('');
    expect(early.chapters).toHaveLength(0);
    expect(early.moments).toHaveLength(1);
  });
});
