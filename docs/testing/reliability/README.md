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

The eight-hour **20 chat/s baseline** pure-reducer profile is complete; its final scope and results appear below. The original actual-engine profile was stopped after its freshness failure; repaired calibration and full verification are separate. Exact commands, from `project/`:

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

The follow-up `release-audit.json` checks tracked files, a fresh isolated public-mode build, and ignore rules without revealing configured values. Four configured secret comparisons found no match; no tracked private database, credentials or raw audio was found. All eight ignore probes passed, including `.pfx` after its exclusion was repaired. The private-database sample contained zero nontrivial source strings, so no transcript-leak conclusion follows from that comparison. Fresh public mode excludes the local experience, development showcase, owner HTTP client, microphone acquisition and server/SQLite code. Earlier stale build chunks were removed by the final builds before deployment. A local OAuth action in shared dock code is guarded in replay/public mode. A static PCM worklet is copied from `public/` but has no public microphone entrypoint. Environment-variable names in local setup instructions were reviewed as documentation, not leaked values. The latest `public-audit.json` scanned 85 current artifact files (2,390,229 bytes) with four configured-secret comparisons and no findings; the deployed manifest and asset check is recorded separately in [deployment evidence](../functional/deployment-2026-11-02.json).

```powershell
node --import tsx scripts/stress/audit-public.mts
node --import tsx scripts/stress/audit-release.mts
npx vitest run tests/reliability tests/twitch/eventsub.test.ts
```

## Outstanding scope

The full pure-reducer profile is complete below; the separate actual-engine full-load result remains pending. Actual short microphone capture/cleanup, browser suspension and real provider failure behavior remain outside this evidence. Actual cloud CAS and revocation checks have their own [cloud report](../cloud-storage.md). Existing adapter/domain/auth/publication tests cover many synthetic failure and isolation cases; their mere presence is not fresh execution evidence.

Initial inspection found that owner HTTP exposed paginated sessions and raw sources, while the dock's earlier-chapters control only revealed more of its existing snapshot. MAIN subsequently authorized the historical retrieval repair. The reliability/storage worker added `HistoryPersistence`, repository graph/page methods and eight storage tests: 71 lore roots beyond the hot 50-item limit, stable time/ID pagination, cursor advancement through rejected roots, scope isolation, raw-text omission, active revision/privacy/bans/chat-clear/term checks, EN/RU presentation and candidate closure, and explicit oversized-graph failure. Graph reads cap 512 nodes, 4,096 edges, 128 levels and 1 MB; per-page raw reads cap 50 roots. Source SQL omits the transcript column.

Generation retrieval additionally selects at most four exactly mentioned, verified lore roots and four owner-pinned chapters with safe published candidates. Input is bounded to 12,000 characters; each SQL candidate window is at most 32 rows before graph validation. Unicode normalization and word boundaries prevent a substring such as “brickwork” from guessing the “brick” topic. The runtime supplies only current safe evidence and remains responsible for selecting eligible current-language presentations and freezing dependency references. No raw transcript is retrieved by this path.

After the generation-selection checks were added, the storage-history and reliability suites passed 14 tests across three files. Subsequent runtime and owner integration connected historical projection and editing. The separate [visual observations](../visual/experience-review.md) record browsing 30 editable chapter rows through the real owner fixture. Storage tests alone do not establish historical UI navigation, language rendering or editing, and that small browser journey does not establish a full long-stream result.


## Actual-engine full profile — stopped pre-repair baseline

The pre-repair actual-engine profile was deliberately stopped at **2026-11-02 00:25:49 UTC** after its known freshness failure was reproduced, redirecting host capacity to repaired verification. It durably committed **194,200 chats through virtual second 9,289.95** over **5,972.851 wall seconds** (99.5 minutes). It did **not** complete the planned 28,800 virtual seconds / 577,200 chats. `engine-full-profile.stopped.json` is the explicit partial/failing record; no `engine-full-profile.json` success artifact was created.

The run exercised actual `StoryEngine.ingestBatch`, `ingest` and `executeStory` paths against file-backed SQLite. Its unchanged profile used 20 chats per virtual second, the complete 200/s burst during virtual seconds 7200–7259, and the final 60 seconds of each virtual hour without chat. Metadata and synthetic pre-reviewed speech arrived every five virtual minutes, with duplicate-delivery probes, ten-minute deletions, delayed/failing deterministic story jobs, and a bounded local publication sink. The recovered database contains the complete **12,000-chat burst**, 31 speech sources and 31 metadata sources.

Only the exact owned Node process was terminated after command identity verification. A normal read/write SQLite open and transaction allowed rollback-journal recovery before verification: `integrity_check` returned `ok`, foreign-key checks found no violations, 194,200 chat event receipts matched 194,200 chat source rows, all source IDs 0–194,199 were present, and no chat event remained unprocessed. The committed count was a multiple of the 20-event batch size. All 15 deleted chat sources had null text. These checks cover the recovered committed prefix; full-run pagination was not completed. The database and its remaining journal file were retained, with a post-check database footprint of 484,171,776 bytes.

The last progress sample recorded 31 duplicate probes and nine chapters; the final checkpoint also retained nine chapters, with its current recap referencing virtual second 9,000.999. Across forced-GC progress samples, maximum retained heap was 16,046,272 bytes, maximum RSS 189,218,816 bytes, and the hot source count stayed at 500. These observed bounds do not negate the freshness failure or establish a maximum-history plateau.

The 620-second harness calibration (`engine-full-calibration.json`) completed 12,400 distinct chats in 190.128 wall seconds with 3 duplicate probes, 1 deletion, 7 synthetic provider calls (5 failed/held, 2 done) and 2 chapters. SQLite quick-check, receipt/source counts and 12,406-row paginated retrieval passed. It retained at most 500 sources, one pending story job, zero false single-actor moments, and stayed within the packet cap.

The original launch command was:

```powershell
node --expose-gc --import tsx scripts/stress/engine-full-profile.mts 28800 docs/testing/reliability/engine-full-profile.json
```

This profile used accelerated timestamps and already-queued batches of at most 20. It is not an eight-hour wall-clock soak, socket queue/latency test, real provider-quality test or cloud-publication test. Chat stayed pending safety; supplied speech was synthetic pre-reviewed text, and metadata/story checks used deterministic local stubs. The sink acknowledged local outbox work without external publication. The normal file-backed repository durability configuration was unchanged. Actual burst processing remained about 35–38 events/s and took roughly 5.4 wall minutes; it does not demonstrate live 200/s capacity. The final sampled segment was 8.56 events/s under severe shared-host contention and a parallel repaired calibration. BelowNormal priority, the reducer's completion, repaired-calibration start, and host CPU/RAM observations are recorded in `engine-full-profile.conditions.json`; these are not isolated throughput measurements. Selected launch source hashes, later file hashes, hardware and the original progress log are preserved. No user data or credentials were used.

After this profile started, hydration was changed to retrieve blocked-lore controls through an indexed binary key range. This process retained the earlier `LIKE` query, which scans all controls in the scope, including accumulated event receipts; the partial result cannot establish the repaired query’s long-run performance. Bounded read-only comparisons are recorded in `engine-full-profile.conditions.json` and `engine-readonly-growth-probe.json`. Owner-edit and speech-retention repairs made after launch were also absent from this process. The profile did not dispatch owner edits.

An in-progress check found a **known product freshness failure**: at virtual second 7,247, all six retained chapters were still revision 1 and the current recap referenced speech from virtual second 3,000—a lag of roughly 71 virtual minutes. Generation continued, but chat displaced recent speech from the 500-source hot window after about 25 seconds, shorter than the intended 90-second evidence horizon. After the first hourly outage, retries aligned about 27 seconds after each minute; the synthetic proposer then repeatedly failed on memory-only packets. `engine-story-progress-probe.json` records the checkpoint and job-ticket timeline. Chapter/provider-done counts later advanced to seven around virtual second 7,845 and nine before stopping, so this was a prolonged freshness stall with intermittent recovery, not a permanently frozen engine. Passing numeric caps and durable chat counts cannot establish a complete reliability pass, continuous recap progress or maximum-history coverage. The metadata boundary was still present, and no owner locks were set. Repaired retention/safety-priority verification is separate from this stopped baseline.

## Full-core baseline — completed 28,800 virtual seconds

`virtual-full-core.json` completed the full pure-reducer profile on 2026-11-02: **577,200 chat messages** over eight virtual hours at 20 chat/s, including the complete 200 chat/s burst for 60 virtual seconds and the final 60 seconds of each hour without chat. The exact count matches `28,800 × 20 − 8 × 60 × 20 + 60 × (200 − 20)`. The harness counted 33,952 command-shaped inputs, applied 47 message deletions, and exercised 534 synthetic provider failure/hold outcomes. These are reducer events, not actual commands sent or provider requests. It retained 51 chapters and reported **no limit violations** and **zero false moments from the single actor**.

| Reducer limit/measurement | Observed maximum |
| --- | ---: |
| Retained sources | 500 |
| Reaction windows | 30 |
| Actors in an open window | 1 |
| Phrase records | 0 |
| Candidate records across chapters | 51 |
| Pending candidates per entity | 1 |
| Simultaneous pending generation | 1 |
| Generation evidence packet | 2,034 UTF-8 bytes |

The candidate total includes historical published candidates; it is not 51 simultaneous pending jobs. The one-actor workload checks resistance to repeated signals, not crowd diversity or the 100-actor limit under distinct actors. Ninety-seven forced-GC samples recorded a maximum retained heap of 14,718,528 bytes and maximum RSS of 116,482,048 bytes. From virtual second 1,800 to completion, retained heap grew from 13,707,608 to 14,706,592 bytes as chapter history grew from 3 to 51; final RSS was 116,178,944 bytes. This shows bounded hot windows within the completed profile, not a memory plateau at the maximum historical chapter count.

Observed wall time was 4,779.916 seconds (79.7 minutes). `virtual-full-core.conditions.json` records shared-host contention, the mid-run reduction to BelowNormal priority, and the later shutdown of an unused development server. The elapsed time is not isolated throughput evidence or a user-facing latency guarantee. `core` mode does not persist message ingress: the 331,776-byte database footprint and zero pagination rows are initialization artifacts, not storage-growth or durable-history evidence. This is accelerated pure-reducer evidence; it does not establish eight hours of wall-clock operation, StoryEngine throughput, socket behavior, microphone/OBS capture, real providers or cloud consistency.

No launch-time hash set was captured. The conditions file preserves the reducer Git blob reconstructed from the first post-launch clean status at `d00ddac`, explicitly labelled mid-run and completion source hashes, and the final result hash. Owner-edit/review recovery changed after launch; the running process was not restarted, and this harness dispatches neither owner-edit nor owner-review events. The separate actual-engine profile remains the source of durable runtime evidence.

## Speech retention and story freshness repair

The prolonged stall in the original actual-engine profile was reproduced in six focused regressions before changing the implementation. The repair reserves up to 64 recent non-chat sources within the existing 500-source cap and 90-second evidence horizon. Checkpoint recovery, authoritative SQLite recovery, evidence selection and pending-safety review agree on that selection. Safety review still caps each batch at 30 sources and 3500 bytes. A boundary revision also prevents an older result or hold from consuming a later metadata/topic boundary, including equal timestamps and legacy requests.

The focused suite passed 58 tests across five files. Its real SQLite scenario fails a delayed request at virtual 281.95 seconds, supplies fresh speech at 300 seconds, delivers 540 chats at 20/s, retries at 326.95 seconds, and publishes the fresh statement at 375 seconds. Checkpoint restart, invalid-checkpoint fallback and erasure after publication are included. Late safety results remain fenced by source revision, erasure and bans. Independent review reproduced a selection mismatch for equal timestamps; two additional regressions and a shared Unicode scalar ordering now keep ASCII and Unicode source selection, packet order and the first safety batch identical across fallback recovery.

The repaired full-profile harness now requires each supplied speech outside the first five minutes of an hourly provider outage to reach both a grounded public chapter and `current.now`, and then the local publication sink, within 240 virtual seconds. This is a bound for that deterministic workload, not a live latency promise. Samples and failure artifacts expose overdue source IDs and publication times; provider success counts alone cannot pass. The workload remains 577,200 chats over eight virtual hours.

`engine-repaired-calibration.json` completed 4,200 virtual seconds and 82,800 chats, including the first hourly outage and its recovery. All 12 eligible speech samples reached the required matching chapter, current statement and local sink; none were overdue or pending. Maximum observed source-to-snapshot time was 76.05 virtual seconds and supply-to-sink time was 80 seconds. It retained at most 500 sources, 13 chapters, two pending candidates per entity, one story job and a 2,294-byte packet; no single-actor moment or cap violation occurred. All six deletes and 14 duplicate probes passed. SQLite quick-check and exact chat counts passed; all 82,828 source rows remained available through 166 pages, including the oldest source.

Calibration wall time was 2,596.940 seconds (43.3 minutes) on the shared Windows host. The run began at BelowNormal priority, overlapped the aggregate suite and the old profile, and switched to Normal at 00:33:35 UTC. `engine-repaired-calibration.conditions.json` records those changes. Its times are not an isolated benchmark or socket-latency result. The full repaired run is separate and remains pending below.

The aggregate correctness suite and an isolated repeat exceeded the existing 60-second timeout for its 1,440-speech bounded-history test; the isolated execution took 76.46 seconds. A separate matched 600-speech comparison against `809eb56` produced identical final state hashes: old 15.516 s wall / 12.532 s CPU, repaired 15.783 s wall / 12.969 s CPU. This one shared-host sample does not establish the cause of the full-test timeout; the full old 1,440-input comparison was not run. The direct retention microprobe measured approximately 0.259 ms per over-cap call. `engine-retention-probe.json` preserves the scope. The correctness test timeout is now 120 seconds, with all inputs and assertions unchanged. Neither timeout is a product throughput target.


## Repaired actual-engine full profile

The repaired full profile was launched once at **2026-11-02 00:50:30 UTC**, from source commit `a9df89c`, with Normal process priority from the start. The prior baseline was already stopped. Launch hashes and shared-host conditions are preserved in `engine-repaired-full.conditions.json`; its selected source hashes matched the working files when monitoring was handed over. The run is still in progress, and no complete repaired full-load result is claimed yet.

The unchanged target is **577,200 distinct chats over 28,800 virtual seconds**, using a 20/s baseline, a complete 200/s burst for virtual seconds 7200–7259, and 60 quiet seconds per hour. Metadata, pre-reviewed synthetic speech, duplicate probes, deletions and deterministic provider outages remain in the workload. All **88 eligible speech obligations** must reach a matching grounded public chapter, matching current statement and the local sink within **240 virtual seconds**; speech supplied during the first 300 seconds of an hourly outage is excluded from that bound. Overdue obligations fail the run.

Progress is recorded in `engine-repaired-full.json.progress.jsonl`; the final artifact will be `engine-repaired-full.json` if the run completes. Final verification will cover exact durable counts, every eligible freshness obligation, retained state/job/packet bounds, source hashes and paginated source retrieval. This is accelerated actual-engine/file-backed SQLite evidence with local deterministic providers and a local sink. It does not establish live 200/s socket capacity, capture/OBS behavior, real provider quality or cloud consistency, and shared-host wall timing is not an isolated benchmark.
