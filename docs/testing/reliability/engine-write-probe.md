# Bounded engine persistence probe — 2026-11-01 23:34 UTC

The measured growth was chiefly repeated candidate persistence work, not transaction commit time. This diagnosis does **not** replace the ongoing full-profile result.

Evidence: `engine-write-probe.json`. Reproduction script: `C:/Users/user/Desktop/previouslu/research/verification/engine-write-probe.mts`. The original diagnostic phase changed no product files; the subsequent authorized implementation is described below. The active full-profile database was opened read-only for a small indexed working-set snapshot; no active process was instrumented, restarted, or changed.

Two separate temporary databases contained the checkpoint and referenced synthetic records from the inactive calibration and later running profile. Archival events, mutation receipts, and unrelated history were omitted. Each ran the current actual `StoryEngine.ingestBatch` implementation for 20 warmup chats and 100 measured chats in batches of 20, with SQLite DELETE journal, synchronous FULL (2), and secure_delete enabled. Total ingestion: 240 synthetic chats. No providers or network.

| Measurement | Calibration checkpoint | Later checkpoint |
|---|---:|---:|
| Checkpoint size | 177,254 bytes | 236,687 bytes |
| Candidates / total candidate refs | 2 / 6 | 6 / 40 |
| Instrumented processing capacity | 46.36 events/s | 36.04 events/s |
| Total elapsed per event | 21.57 ms | 27.75 ms |
| Candidate method, including nested SQL | 1.80 ms/event | 7.29 ms/event |
| Full-state clones (205 calls/100 events) | 7.05 ms/event | 9.48 ms/event |
| Checkpoint SQL write | 1.52 ms/event | 1.54 ms/event |
| Outer COMMIT (5 calls/100 events) | 0.48 ms/event | 0.44 ms/event |
| Source active-ref SELECT calls /100 events | 1,300 | 8,100 |
| Entity fallback active-ref SELECT calls /100 events | 400 | 3,400 |
| Dependency UPSERT calls /100 events | 700 | 4,100 |

Timing groups overlap: candidate SQL is included in the candidate method; clones are included in the reducer/persistence methods. Do not add all rows together. Shared machine, warmed caches, BelowNormal priority, instrumentation overhead, and sequential early/later measurements limit exact comparisons. These databases intentionally cannot measure archival-table growth costs or attribute an exact fraction of the untouched full run's slowdown. Process CPU usage was 2.50 CPU seconds over 2.16 wall seconds early and 3.02 CPU seconds over 2.78 wall seconds later, including runtime helper threads.

Concrete mechanism: `src/server/storage/domain.ts:239` calls `candidate()` for every retained candidate on every event. That method rechecks each reference at line 155, writes the candidate, then `edges()` rechecks those same references and UPSERTs every edge, followed by a public-pointer UPSERT for published candidates. The later checkpoint has six candidates with reference counts 1, 5, 7, 9, 9, 9. Therefore 40 references produce 80 active-ref probes per chat, plus the new chat event's own reference. Missing source IDs require an additional entity lookup. Candidate work increased 5.49 ms/event while overall elapsed increased 6.18 ms/event in this comparison; this supports the candidate path as a substantial cause of working-set growth cost, not an isolated quantitative attribution.

The later trace spent 0.447 ms/event on candidate UPSERTs, 0.227 on pointer UPSERTs, and 1.674 on all dependency UPSERTs (including new event edges). This roughly 2.35 ms/event is an upper bound on the observed SQL time removable by suppressing all those writes; legitimate new-edge writes must remain, and equality checks add cost. No counterfactual optimized implementation was measured.

The diagnostic recommendation was to retain every session/owner/privacy/immutable-content and active-reference fence, but suppress candidate, dependency, and public-pointer writes only after proving their persisted values already match. Source/entity versions cannot change through another connection during the enclosing IMMEDIATE transaction; any reuse must also respect writes within the same transaction.

The reducer and persistence adapter each clone the whole state; hydration adds one clone per batch. This explains 205 full-state clones for 100 events. Clone growth is another measured cost, but removing those copies would change ownership/mutation guarantees and is a broader change than skipping proven-equal writes. Keeping durable commit settings intact is supported by the small observed COMMIT contribution.

No visual behavior was changed or inspected. This is functional/performance evidence only, not user approval or a long-run capacity guarantee.

## Authorized implementation and same-snapshot comparison

`src/server/storage/domain.ts` now retains all candidate schema, session, owner, privacy, immutable-content, activity/version, publication eligibility, dependency capacity, and self-edge checks. It compares the stored candidate body/status/safe fields, actual stored dependency revisions, and actual public pointer before omitting matching writes. Missing edges and pointers are repaired even when the candidate body is unchanged.

Successful reference checks are reused only within the contiguous candidate persistence loop, after source/entity writes have completed. That loop only mutates candidates, dependencies and pointers. Its set is created afresh for each transition; it never spans a later source/entity mutation or another transition. No cache persists on the repository or engine.

The JSON `comparison` records a second bounded probe: 480 synthetic chats total across four separate temporary databases, 20 warmup plus 100 measured events per configuration. Each early/later snapshot was captured once, then seeded identically for baseline and optimized modes. The baseline restores the original candidate method in the probe process only; the rest of the current implementation is identical (including an unused set allocation in baseline). The baseline method is included in the reproduction script. No ongoing process was modified.

| Same-snapshot measurement | Early baseline → optimized | Later baseline → optimized |
|---|---:|---:|
| Measured processing capacity | 55.19 → 57.44 events/s | 38.01 → 43.08 events/s |
| Relative capacity change | +4.1% | +13.3% |
| Candidate method elapsed | 1.53 → 0.87 ms/event | 7.05 → 3.06 ms/event |
| Source active-ref SELECTs /100 events | 1,300 → 600 | 8,114 → 1,614 |
| Entity active-ref SELECTs /100 events | 400 → 200 | 3,408 → 408 |
| Dependency UPSERTs /100 events | 700 → 100 | 4,107 → 107 |
| Candidate UPSERTs /100 events | 200 → 0 | 600 → 0 |
| Public-pointer UPSERTs /100 events | 100 → 0 | 600 → 0 |

Final checkpoint SHA-256 values were identical within both baseline/optimized pairs. All four probe databases passed SQLite quick_check with no foreign-key violations. The later snapshot was at virtual second 6624.95, with six candidates and the same 1/5/7/9/9/9 reference distribution. There were seven additional legitimate dependency insertions in each later mode as the reducer advanced; they were preserved.

The timings remain short, warmed, instrumented measurements on a shared host, run baseline then optimized. They show the intended work reduction and directional effect, not an isolated capacity guarantee or a replacement for the older still-running full profile. Its already-loaded code remains unchanged.

Validation: TypeScript check passed. Four focused suites passed, 42 tests total: storage domain, engine hydration, domain epoch/lore, and storage publisher. Added regressions reject an unchanged candidate after its source revision, source status, entity owner revision, or entity status changes, checking transaction rollback. Another regression persists pending→published across reopening and repairs missing dependency/public-pointer rows for an unchanged published candidate.
