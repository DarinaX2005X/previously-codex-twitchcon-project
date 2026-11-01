# Reliability evidence — stage 05.1

This folder records synthetic and local functional evidence. It does not establish an eight-hour live broadcast, actual microphone/OBS capture, paid-provider quality, or production Blob consistency. Tests were run on Windows 10.0.19045, Node 22.13.0, Intel i7-1260P (16 logical CPUs), 34,071,896,064 bytes system memory. Other project workers were active, so timings include shared-machine contention and are observations, not an isolated benchmark guarantee.

## New cross-boundary checks

`tests/reliability/boundaries.test.ts` passes four scenarios:

- A saturated 1,000-item durable outbox rejects new ordinary work, but Forget commits, cancels queued/leased output, exposes the priority retract first, and records a late Clip ID only for owner cleanup.
- An actual SQLite maximum-page limit exhausts the test database. Failed ingress leaves no orphan event, earlier evidence remains readable, and restart preserves it. This tests the database cap, not an operating-system volume filled to zero bytes.
- A model response deliberately held inside `StoryEngine.executeStory` returns after Forget. No late chapter or EN/RU presentation reaches durable publication; the forgotten source/checkpoint text is absent.
- 605 sources remain available through seven owner-service pages after the hot context retains only 500. Forget of the oldest source survives database restart. This proves source pagination; it does not prove older chapter/lore UI navigation.

`tests/reliability/eventsub-overflow.test.ts` verifies ordinary intake stays at 100 pending notifications under a blocked consumer, reports a coverage gap, and disables quote readiness. Its second case originally failed: an already-received delete was discarded behind 100 normal messages. The Twitch owner repaired this with a durable privacy inbox. Both tests then passed alongside the four existing EventSub transport tests (nine total at that checkpoint, before the fourth boundaries test was added). The four-test boundaries file was separately rerun and passed.

The original privacy failure was reproduced before the repair and reported to MAIN; the Twitch owner changed the transport. Privacy-only saturation, persistence failure and actual child-process crash/restart are owned by that worker's additional regression tests.

## Load measurements

`engine-throughput-baseline.json` records the actual pre-repair `StoryEngine.ingest` path: normalization, SQLite transition/checkpoint, and state hydration, with synthetic pending-safety chat and no provider calls. The 1,000-message run took 280.974 seconds. Segment throughput fell from 16.97 events/s for messages 1–250 to 2.30 events/s for messages 751–1,000; the last two segments retained 500 sources. Final retained heap was 13,286,360 bytes, RSS 142,630,912 bytes, and database plus WAL/SHM footprint 2,813,952 bytes. This exposed a real repeated-hydration cost and was sent to the runtime owner for repair. Do not use this baseline as the optimized result.

`calibration.json` is a smaller raw-ingress/reducer calibration: 1,200 messages at 20/s virtual input, 12.082 seconds wall time, 1,712,128 bytes database footprint. It does not include the complete StoryEngine hydration path and is not interchangeable with the baseline above. Its provider-delay path was not exercised within the 60-second calibration interval.

The corrected `virtual-boundaries.json` spans eight virtual hours with **1 chat/s baseline**, a full **200 chat/s burst for 60 virtual seconds**, hourly quiet windows, metadata changes and delayed synthetic provider results. It processed 40,260 chat messages, including 2,368 commands, 47 message deletions and 415 synthetic provider failure/hold outcomes; 81 chapters were retained. Wall time was 705.064 seconds. The source window reached 500, reaction windows 30, simultaneous generation 1 and evidence-packet maximum 2,147 UTF-8 bytes. One actor produced zero false moments. The 82 maximum candidate records include published records across chapters; this is not a count of 82 pending jobs or a violation of the per-entity candidate cap.

After the first 30 virtual minutes, retained heap grew from 13,522,640 to 15,949,504 bytes while chapter history grew from 5 to 81; RSS changed from 113,836,032 to 110,530,560 bytes. These measurements show bounded source/reaction windows and modest retained growth for this profile. They do **not** establish a plateau for a full 300-chapter history or the required baseline event rate. An earlier run had a harness offset/absolute-clock mismatch that prevented provider completion; its zero-chapter JSON was replaced and is not final evidence.

The required eight-hour **20 chat/s baseline** profile remains outstanding. Exact commands, from `project/`:

```powershell
# Representative actual runtime; use separate paths to retain before/after results.
node --expose-gc --import tsx scripts/stress/engine-throughput.mts docs/testing/reliability/engine-throughput-optimized.json

# Full baseline load, pure reducer. Long-running; not a live broadcast.
node --expose-gc --import tsx scripts/stress/virtual-stream.mts 28800 docs/testing/reliability/virtual-full-core.json core 20

# Full reducer plus one real durable ingress transaction per source.
node --expose-gc --import tsx scripts/stress/virtual-stream.mts 28800 docs/testing/reliability/virtual-full-ingress.json durable 20

# Smaller baseline while retaining the full virtual time span and raid burst.
node --expose-gc --import tsx scripts/stress/virtual-stream.mts 28800 docs/testing/reliability/virtual-boundaries.json core 1
```

`core` mode deliberately does not persist messages; its database footprint and empty pagination result are not storage-growth evidence. The script reports `scope` and `baselineRate` explicitly. GC is forced at sample boundaries to measure retained heap. A single actor produces all chat signals, so the moment count checks spam resistance rather than legitimate crowd detection. Prompt measurements are UTF-8 evidence packet bytes, not billed provider tokens or total request bytes. Full structured request caps have separate provider tests.

## Public artifact audit

`public-audit.json` inspected 90 files (2,368,328 bytes) across `public/`, `dist-public/`, and `dist/`; compared four configured secret values without printing them; and checked private-file extensions, high-confidence key patterns and literal capability URLs. No findings. The output records Vite/Vercel input hashes. This is a filesystem artifact check, not a tracked-file audit, semantic review of transcript content, fresh deployment verification, or proof that later builds remain clean. Re-run after the final public build:

```powershell
node --import tsx scripts/stress/audit-public.mts
npx vitest run tests/reliability tests/twitch/eventsub.test.ts
```

## Outstanding scope

The required full-load profile, actual short microphone capture/cleanup, browser suspension, real provider failure behavior, and live cloud CAS/revocation remain outside this worker's completed evidence. Existing adapter/domain/auth/publication tests cover many synthetic failure and isolation cases; their mere presence is not fresh execution evidence.

Initial inspection found that owner HTTP exposed paginated sessions and raw sources, while the dock's earlier-chapters control only revealed more of its existing snapshot. MAIN subsequently authorized the historical retrieval repair. The reliability/storage worker added `HistoryPersistence`, repository graph/page methods and six storage tests: 71 lore roots beyond the hot 50-item limit, stable time/ID pagination, cursor advancement through rejected roots, scope isolation, raw-text omission, active revision/privacy/bans/chat-clear/term checks, EN/RU presentation and candidate closure, and explicit oversized-graph failure. Graph reads cap 512 nodes, 4,096 edges, 128 levels and 1 MB; per-page raw reads cap 50 roots. Source SQL omits the transcript column.

The story/runtime and UI owners integrate these methods into historical projection and editing. The six storage tests do not themselves verify historical UI navigation, language rendering or editing. Those integration results belong to their owners and must be checked before claiming the full R24 behavior.
