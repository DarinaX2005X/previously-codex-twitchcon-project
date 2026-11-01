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

The independent `engine-throughput-optimized.json` run, after checkpoint-first hydration and source-fence repairs, took 58.101 seconds for the same 1,000 messages: 4.84 times faster overall. Its four segments measured 23.96, 15.32, 14.36 and 17.93 events/s. Final retained heap was 14,380,112 bytes, RSS 120,877,056 bytes and database footprint 2,813,952 bytes. The separate reducer stress had ended before this run, though other project workers were still active. **The warm segments did not sustain 20 events/s on this shared machine.** MAIN and the runtime owner were notified; further performance work is in progress. A previous intermediate 35.49-second run is not this final sample and must not be substituted for it.

The subsequent `ingestBatch` repair keeps per-event durable receipts and commits already-queued events together. Separate measurements preserve their scope:

| Actual engine path | 1,000-event wall time | Last warm segment | Atomic call mean / p95 / max |
| --- | ---: | ---: | ---: |
| Batch of 2 | 14.606 s | 49.26 events/s | 29.11 / 43.22 / 112.00 ms |
| Batch of 20 | 7.164 s | 112.13 events/s | 142.63 / 204.64 / 214.79 ms |

Artifacts are `engine-throughput-batch2.json` and `engine-throughput-batch20.json`. Both retain 500 sources and a 2,813,952-byte database footprint; final retained heap/RSS are 14,114,736/118,185,984 bytes for size 2 and 13,040,616/156,770,304 bytes for size 20. These measurements exceed the normal 20/s rate for already-queued processing. They do not include waiting in an intake queue, an intentional wait to fill a batch, actual socket delivery, providers, or the specified long run. The batch-20 warm rate remains below 200/s; overflow must retain the tested explicit gap and privacy behavior. Twitch queue integration and measured intake latency require the runtime/Twitch evidence.

`calibration.json` is a smaller raw-ingress/reducer calibration: 1,200 messages at 20/s virtual input, 12.082 seconds wall time, 1,712,128 bytes database footprint. It does not include the complete StoryEngine hydration path and is not interchangeable with the baseline above. Its provider-delay path was not exercised within the 60-second calibration interval.

The corrected `virtual-boundaries.json` spans eight virtual hours with **1 chat/s baseline**, a full **200 chat/s burst for 60 virtual seconds**, hourly quiet windows, metadata changes and delayed synthetic provider results. It processed 40,260 chat messages, including 2,368 commands, 47 message deletions and 415 synthetic provider failure/hold outcomes; 81 chapters were retained. Wall time was 705.064 seconds. The source window reached 500, reaction windows 30, simultaneous generation 1 and evidence-packet maximum 2,147 UTF-8 bytes. One actor produced zero false moments. The 82 maximum candidate records include published records across chapters; this is not a count of 82 pending jobs or a violation of the per-entity candidate cap.

After the first 30 virtual minutes, retained heap grew from 13,522,640 to 15,949,504 bytes while chapter history grew from 5 to 81; RSS changed from 113,836,032 to 110,530,560 bytes. These measurements show bounded source/reaction windows and modest retained growth for this profile. They do **not** establish a plateau for a full 300-chapter history or the required baseline event rate. An earlier run had a harness offset/absolute-clock mismatch that prevented provider completion; its zero-chapter JSON was replaced and is not final evidence.

The required eight-hour **20 chat/s baseline** profile remains outstanding. Exact commands, from `project/`:

```powershell
# Representative actual runtime; use separate paths to retain before/after results.
node --expose-gc --import tsx scripts/stress/engine-throughput.mts docs/testing/reliability/engine-throughput-optimized.json
node --expose-gc --import tsx scripts/stress/engine-throughput.mts docs/testing/reliability/engine-throughput-batch2.json 2
node --expose-gc --import tsx scripts/stress/engine-throughput.mts docs/testing/reliability/engine-throughput-batch20.json 20

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

The follow-up `release-audit.json` scans 285 tracked files and a fresh isolated public-mode build (30 files), and checks ignore rules without revealing configured values. Four configured secret comparisons found no match; no tracked private database, credentials or raw audio was found. All eight ignore probes now pass, including `.pfx` after MAIN repaired that omission. The private-database sample contained zero nontrivial source strings, so no transcript-leak conclusion follows from that comparison. Fresh public mode excludes the local experience, development showcase, owner HTTP client, microphone acquisition and server/SQLite code. The existing `dist-public` still held older local/dev chunks at inspection and must be regenerated before deployment. A local OAuth link in shared dock code was found and its replay rendering was guarded; strict removal of that literal from the public bundle is tracked by MAIN. A static PCM worklet is copied from `public/` but has no public microphone entrypoint. Environment-variable names in local setup instructions were reviewed as documentation, not leaked values.

```powershell
node --import tsx scripts/stress/audit-public.mts
node --import tsx scripts/stress/audit-release.mts
npx vitest run tests/reliability tests/twitch/eventsub.test.ts
```

## Outstanding scope

The required full-load profile, actual short microphone capture/cleanup, browser suspension, real provider failure behavior, and live cloud CAS/revocation remain outside this worker's completed evidence. Existing adapter/domain/auth/publication tests cover many synthetic failure and isolation cases; their mere presence is not fresh execution evidence.

Initial inspection found that owner HTTP exposed paginated sessions and raw sources, while the dock's earlier-chapters control only revealed more of its existing snapshot. MAIN subsequently authorized the historical retrieval repair. The reliability/storage worker added `HistoryPersistence`, repository graph/page methods and eight storage tests: 71 lore roots beyond the hot 50-item limit, stable time/ID pagination, cursor advancement through rejected roots, scope isolation, raw-text omission, active revision/privacy/bans/chat-clear/term checks, EN/RU presentation and candidate closure, and explicit oversized-graph failure. Graph reads cap 512 nodes, 4,096 edges, 128 levels and 1 MB; per-page raw reads cap 50 roots. Source SQL omits the transcript column.

Generation retrieval additionally selects at most four exactly mentioned, verified lore roots and four owner-pinned chapters with safe published candidates. Input is bounded to 12,000 characters; each SQL candidate window is at most 32 rows before graph validation. Unicode normalization and word boundaries prevent a substring such as “brickwork” from guessing the “brick” topic. The runtime supplies only current safe evidence and remains responsible for selecting eligible current-language presentations and freezing dependency references. No raw transcript is retrieved by this path.

After the generation-selection checks were added, the storage-history and reliability suites passed 14 tests across three files. The story/runtime and UI owners integrate these methods into historical projection and editing. Storage tests do not themselves verify historical UI navigation, language rendering or editing. Those integration results belong to their owners and must be checked before claiming the full R24 behavior.


## Actual-engine full profile

`engine-full-profile.mts` runs the actual `StoryEngine.ingestBatch`, `ingest` and `executeStory` paths against file-backed SQLite. The full profile was launched at 2026-11-01 22:46:16 UTC; its final result is pending. It processes 20 chats per virtual second, a 200/s burst during virtual seconds 7200–7259, and the final 60 seconds of each virtual hour without chat: 577,200 distinct chat messages over 28,800 virtual seconds. Metadata and synthetic pre-reviewed speech arrive every five virtual minutes. It also includes duplicate-delivery probes, ten-minute message deletions, virtual delayed/failing deterministic story jobs, and a bounded local publication sink.

The 620-second harness calibration (`engine-full-calibration.json`) completed 12,400 distinct chats in 190.128 wall seconds with 3 duplicate probes, 1 deletion, 7 synthetic provider calls (5 failed/held, 2 done) and 2 chapters. SQLite quick-check, receipt/source counts and 12,406-row paginated retrieval passed. It retained at most 500 sources, one pending story job, zero false single-actor moments, and stayed within the packet cap.

```powershell
node --expose-gc --import tsx scripts/stress/engine-full-profile.mts 28800 docs/testing/reliability/engine-full-profile.json
```

This profile uses accelerated timestamps and already-queued batches of at most 20. It is not an eight-hour wall-clock soak, socket queue/latency test, real provider-quality test or cloud-publication test. Chat stays pending safety; supplied speech is synthetic pre-reviewed text, and metadata/story checks use deterministic local stubs. The sink acknowledges local outbox work without external publication. The normal file-backed repository durability configuration is unchanged. Process priority is BelowNormal; other workers and the separate reducer stress share the machine. Source hashes, hardware, exact scope, progress, retained heap/RSS and database footprint are recorded. The SQLite file is retained under the path in the result for diagnosis; no user data or credentials are used.

After this full profile started, hydration was changed to retrieve blocked-lore controls through an indexed binary key range. The running process retains the earlier `LIKE` query, which scans all controls in the scope, including accumulated event receipts. The full result therefore measures that earlier implementation; it cannot establish the repaired query’s long-run performance. A single read-only plan/timing comparison and the later repair are recorded in `engine-full-profile.conditions.json`. Owner-edit recovery changes made after launch are also outside this profile, which does not dispatch owner edits.
