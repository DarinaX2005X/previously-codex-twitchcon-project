# Architecture

Previously keeps private stream evidence on the streaming computer. The local owner controls that evidence; public pages and OBS consume explicit published projections. The same pure domain code runs in live mode and recorded replay.

## Boundaries

| Boundary | Implementation | Responsibility |
| --- | --- | --- |
| Contracts | [Shared schemas](../../src/shared/contracts/index.ts) | Validate sources, chapters, settings, snapshots, and recap plans |
| Domain | [Core](../../src/core/) | Reduce events, maintain evidence relationships, hold candidates, apply privacy, and compile scenes |
| Local coordinator | [Story engine](../../src/server/runtime/engine.ts) | Serialize transitions, load authoritative state, dispatch workers, and emit identifier-only updates |
| Persistence | [Storage](../../src/server/storage/) | SQLite transactions, revisions, privacy epochs, jobs, outbox, token encryption, and budget reservations |
| Input and providers | [Capture](../../src/features/capture/), [Twitch](../../src/server/twitch/), [providers](../../src/server/providers/) | Normalize input and return checked proposals without deciding publication |
| Publication | [Local publisher](../../src/server/publication/), [cloud service](../../src/cloud/) | Sign immutable operations, advance the current head, and gate reads |
| Replay | [Replay driver](../../src/replay/driver.ts) | Run the core with virtual time, exact recorded provider outcomes, and a simulation sink |

Node serves the application at `https://localhost:4317`, bound to loopback. Vercel hosts the public client and read/publish functions. It does not receive owner cookies, microphone uploads, token-vault contents, or the private evidence graph.

## Evidence becomes a candidate before it becomes public

Browser capture sends standalone mono PCM WAV chunks through a signed capture lease. The server validates the sequence, hash, timestamps, capture epoch, and privacy epoch before accepting transcription work. Raw audio is temporary; transcription retains source timing and language.

EventSub supplies stream, chat, raid, deletion, and moderation events. Normalization attaches the configured channel, run, and stream session. Duplicate external event IDs do not create another side effect. Stream title and category also require checking before public use.

The reducer builds a bounded evidence packet. The story provider proposes claims with explicit support references; a separate review checks grounding. Chat reports do not become streamer-confirmed outcomes, repeated phrases do not establish lore origins, and missing context can produce a hold. Model output cannot write a public snapshot directly.

A candidate records the versions it used, its owner-edit revision, language, privacy epoch, safety results, and eligibility time. The eligibility time includes the end of every supporting or exposed source interval. Storage checks those versions again when committing the transition. New drafts do not continually restart an older candidate's hold.

The public projection contains current context, chapters, lore, moments, source labels, and timing. Private transcripts, full chat, held drafts, provider inputs, and credentials are excluded. A public time cutoff excludes an entire item if any dependency is later than that cutoff.

## Owner changes and privacy

Owner routes require a scoped session, same-origin checks, CSRF protection, bounded inputs, and an idempotency key. Revision-bearing edits also require a base revision. Reusing a key for a different request conflicts; stale edits do not overwrite newer wording.

Editing immediately removes the old public wording and records a held owner statement. A durable `owner.review` job stores identifiers and versions rather than a copy of the text. The worker reloads current evidence, checks the lease and revisions before and after inspection, and commits only a still-current result. Transient safety failures receive at most three attempts; exhausted checks leave an explicit held result. Safe corrections can publish without another full delay. Alternate-language failure leaves the reviewed original intact.

Forget traverses both supporting and exposed-to relationships. It invalidates affected chapters, lore, media, playbacks, generated caches, exports, and work in flight. Pins do not exempt content. Persistent tombstones prevent late input or provider replies from restoring it. Term blocks apply across the channel's sessions; unblocking does not restore erased explanations.

SQLite is authoritative. A transaction commits accepted events, sources, derived records, privacy state, the checkpoint, and queued work together. Recovery can reconstruct from surviving records when privacy invalidation removes a checkpoint. Idempotency result references are resolved against current state so a retry cannot return forgotten text from an old response cache.

## Public synchronization and scene playback

The outbox carries signed publication operations with a channel-wide sequence and privacy revision. Retries reuse the exact frozen body. The cloud service uses conditional writes on the current channel head; conflicting or stale operations cannot replace a newer head. A local mutation is pending until its matching cloud acknowledgement arrives.

Live snapshots depend on a 30-second server lease renewed by the collector. Public clients poll while visible and remove stale live content when their visibility lease expires. Finalized episode text can remain available after the local process stops. Replay manifests still require revalidation because an export can be revoked.

A raid consumes a prepared plan, not a fresh model request. The plan selects published story beats and permitted media. OBS acknowledges preparation before its scheduled start. One scene can be active and one welcome queued; additional arrivals merge into that queue. Late starts, cancellation, privacy changes, and stale acknowledgements cannot restart a completed scene.

The normal scene duration is selectable as 10, 12, or 15 seconds. A welcome without enough supported context lasts 5 seconds. Prior-session clips are separately approved and labelled; they never establish the current stream's goal. Narration is optional, prepared from published text, and invalidated with its dependencies.

## Resource limits and failure behavior

The limits below are implementation bounds, not measured live capacity claims.

| Resource | Bound or behavior |
| --- | --- |
| Recent raw evidence in a checkpoint | 500 sources, with necessary older provenance retained separately |
| Owner source page | At most 100 records per request |
| Session page | At most 50 records per request |
| Transcription | Two active jobs and three queued chunks |
| Story generation | One active generation per session |
| Owner review | One worker lane with bounded retries |
| Reconnect updates | 1,000 identifier-only update records |
| Private media cache | 512 MB or 12 files by default; a single download is capped at 80 MB |
| Replay upload asset | At most 3,000,000 bytes |
| Recording package | At most 100 assets and 32,000,000 declared bytes, including selected media; larger JSON is split into hashed event/provider chunks |
| Assembled recording | At most 32,000,000 bytes, 10,000 events, and 10,000 provider outcomes |
| Cloud snapshot | At most 1,000,000 bytes |
| Cloud head | At most 100 episode pointers and 10 export manifests |

Unavailable providers leave new material held while existing safe context remains usable, except when an owner edit or privacy action has withdrawn it. An uncertain chat send or clip-creation outcome is not blindly retried. Local storage errors reject the change rather than claiming it was saved. Media preparation can fail independently of a saved moment, and the official clip link can remain useful when local playback is unavailable.

The [integration evidence](../testing/live-engine.md) and [cloud evidence](../testing/cloud-storage.md) distinguish authored tests from real storage and deployed transport checks. See [local setup](../setup/local.md) for the remaining real-stream checks that affect operation.
