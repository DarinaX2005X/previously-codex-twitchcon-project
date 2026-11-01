# Bounded chat batching and intake measurement

The transport consumes up to 20 adjacent chat notifications already present at the FIFO head. There is no collection timer or intentional waiting period. Non-chat controls form a batch boundary; a queued durable privacy drain runs before the next ordinary batch. Delete-before-message tombstones keep an older queued chat from reappearing when privacy work takes that earlier turn.

The ordinary queue still accepts at most 100 notifications, counting an active batch whose commit has not completed. It removes that FIFO prefix and marks transport receipts done only after the runtime/engine commit succeeds. A failed batch retains the entire prefix for retry after a fresh welcome and ban synchronization. The drain also waits during an ordinary connection gap: it does not consume the backlog while quote readiness is false. The cap regression verifies 99 retained items after the blocked first item finishes, followed by all 100 accepted items draining after a recovery welcome. Runtime filtering still applies own-echo, actor bans, delete/clear cutoffs, paused capture, connection readiness and late-message rules. Command outbox work is created after the batch commits; its business keys remain durable and deduplicated.

`StoryEngine.ingestBatch` supplies the existing single-transaction, per-event receipt boundary. Synchronous groups of transport/runtime control receipts share transactions through the optional `ControlStore.transaction`; this does not change SQLite durability. Existing authored engines without `ingestBatch` keep the single-event path.

The three actual-stack regressions in `tests/integration/acceptance-chat-batch.test.ts` pass:

1. One blocked chat followed by 45 queued chats drains in groups of 1, 20, 20 and 5. A deletion received during the block is applied before the matching queued message, and a later raid remains outside the chat batches.
2. Failure on the second domain transition rolls back every source and emits no committed callback or command. The same FIFO head retries after reconnect; all three messages commit once and duplicate delivery sends no second command.
3. Failure writing transport completion receipts after the engine committed leaves the source durable. After adapter/SQLite reopen, redelivered events use the runtime receipts, do not regenerate domain work, and complete transport receipts.

Ordinary messages received into memory but not yet committed can still be lost on process crash, as before; that is an explicit connection gap. This change adds no raw-chat disk inbox and makes no pre-commit crash-replay claim. Privacy controls retain their separate durable paged inbox.

## Paced intake measurement

Run from `project`:

```powershell
node --import tsx scripts/verify/chat-intake-benchmark.mts 20 1000
```

On 2026-11-02, Node 22.13 on the local Windows workspace, the script sent 1,000 authored chat notifications at a planned 20/second through the actual EventSub, Twitch runtime, story engine and temporary file-backed SQLite repository. The first 500 messages warmed the retained history; the last 500 formed the measured set. The socket and Helix responses are deterministic fixtures. There is no real Twitch connection or provider work. The production receipt writes and domain transaction path are included.

| Metric | Observed |
| --- | ---: |
| Committed / received | 1,000 / 1,000 |
| Connection gaps | 0 |
| Measured throughput after warmup | 20.01 events/second |
| Receive → durable commit, p50 / p95 / maximum | 37.27 / 49.84 / 126.64 ms |
| Planned arrival → commit, p50 / p95 / maximum | 42.01 / 67.49 / 169.37 ms |
| Planned → actual receive scheduling drift, p50 / p95 / maximum | 4.55 / 25.08 / 104.98 ms |
| Engine batch call, p50 / p95 / maximum | 21.95 / 25.98 / 109.42 ms |
| Observed batch sizes | 977 × 1, 10 × 2, 1 × 3 |
| Total elapsed | 49.99 seconds |
| Paid requests / paid spend | 0 / 0 |

Receive-to-commit includes intake normalization, safety eligibility filters, receipt transaction stages before the engine, and the domain commit. Its endpoint is the engine's after-commit callback; later command/transport completion bookkeeping is exercised by the producer/consumer loop but is outside that individual latency timestamp. Planned-to-commit also includes event-loop scheduling drift. These measurements establish this local 50-second paced workload, not an eight-hour soak, maximum capacity, live Twitch network latency or a user-facing SLA.

## 200/second burst through actual loopback WebSocket

```powershell
node --expose-gc --import tsx scripts/verify/chat-websocket-burst.mts
```

The [raw measurement](chat-websocket-burst.json) uses an independent producer thread so consumer-side SQLite work cannot lower the intended offer rate. Windows timer turns can be longer than five milliseconds; the producer emits every elapsed five-millisecond slot on each turn and reports its drift. The final run offered 12,000 messages in **60,004 ms**. Producer drift was 9 ms median, 104 ms p95, 405 ms maximum. Thus this is a measured 200/second average burst with reported scheduling jitter, not a claim of perfectly uniform arrivals.

The producer used an actual loopback WebSocket server with authored EventSub welcome/keepalive/chat/delete messages and reconnect sessions. Helix, account validation and providers remained fixtures. This is separate from the official CLI test; CLI 1.1.24 cannot produce the required chat event types.

| Burst result | Observed |
| --- | ---: |
| Producer offers / offers while a server peer was open | 12,000 / 7,140 |
| Frames reaching the application receiver | 813 |
| Unique committed chat sources | 801 |
| Received frames not committed / explicit gaps | 12 / 12 |
| Maximum ordinary FIFO / remaining after drain | 100 / 0 |
| Duplicate source commits | 0 |
| Privacy controls requested / actually received / applied | 8 / 2 / 2 |
| Received privacy targets withdrawn | 2 / 2 |
| Retained in-memory sources after drain | 500 |
| Receive → commit p50 / p95 / maximum | 4,647 / 19,842 / 22,602 ms |
| Offered → commit p50 / p95 / maximum | 8,416 / 25,042 / 27,596 ms |
| Batch sizes | 1 × 1, 40 × 20 |
| GC heap after reaching 500 retained sources | 19.75–20.24 MB |
| RSS at end | 164.97 MB |

The intended overload exceeded service capacity under substantial concurrent work. Other project checks, the long synthetic profile and unrelated user workloads were active; an expensive unused development server was identified separately by MAIN. These are shared-machine measurements, not an isolated capacity benchmark. RSS grew during the short run; the bounded post-warm heap observations do not prove an eight-hour memory plateau.

The queue cap and explicit connection gaps handled overload; this was **not** a lossless burst. Frames written while a server peer was open can still be discarded after the client closes and before an application callback runs. Six requested privacy controls did not reach the client during those hard gaps; only the two actually received controls are covered by durable-inbox guarantees. No missed-gap event is claimed recovered. The 12 received but uncommitted chat frames match the 12 reported gaps; accepted FIFO content drained after re-synchronization, with no duplicate source commits. Command outbox dedupe remains covered by the separate rollback/reconnect test rather than a chat-send claim from this burst.

An earlier same-process producer exposed and prompted the gap-drain repair, but consumer blocking distorted its offer rate. An initial worker producer was also stopped before acceptance because one-message-per-timer scheduling could silently reduce the requested rate. Neither run is used as the final 200/second evidence. The long eight-hour virtual profiles are separate work and are not inferred from this one-minute burst.
