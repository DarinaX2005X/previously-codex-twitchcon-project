# Publication integration

`LocalPublisher` dispatches one persisted outbox item per `tick()`. The runtime supplies the repository, scope, public HTTPS origin, HMAC secret, `buildOperation(lease)`, and `validate(lease, operation)`. Validate must check the current privacy revision, session epoch, input revisions, publication eligibility, and owner revision through the storage fence. It runs before freezing, before HTTP, and before accepting an ACK. The scheduler should tick frequently and enqueue a heartbeat every 10 seconds while live. An immutable frozen wire body and its SHA-256 are persisted by `freezePublication`; a retry never rebuilds that body or changes its sequence. A cancelled or failed stale body needs a new domain-triggered publication of current safe state, never resequencing.

`heartbeatOperation` builds a snapshot operation with an empty snapshot array and a 30-second lease. It does not change source `asOf` or `publishedAt`. `onAck` receives the real CAS ACK and operation, so runtime can set final snapshot readiness only for the matching finalized revision. Local success remains pending until this callback; disconnected edits must say “Saved locally · Public update pending”.

Wire types and strict schemas are in `src/cloud/contracts.ts`. Common fields: `channelId`, `channelLogin`, persisted `publishSeq`, channel-wide `privacyRevision`. Operations:

- `snapshot`: `snapshots`, `activeSessionId`, `liveLeaseUntil`. Empty snapshots renew the lease. Nonempty snapshots must be strict shared PublicSnapshot DTOs built exclusively from safe published state.
- `retract`: `sessionIds`, `exportIds`, `snapshots`. Removes every affected episode/export and installs any safe replacement snapshots in one head CAS. A greater privacy revision must arrive through this operation first. Session retraction also revokes manifests whose primary sourceSessionId matches.
- `export_manifest`: `manifest`. Assets must already exist under this exact publication sequence. The local export registry remains responsible for recording every source dependency, including secondary sessions, and supplying affected export IDs on privacy invalidation.

HMAC canonical form is six LF-separated fields: uppercase method, exact pathname, epoch-millisecond timestamp, channel ID, decimal sequence, SHA-256 of exact request bytes. Signature headers are `x-publish-timestamp`, `x-publish-channel`, `x-publish-seq`, `x-publish-signature`. Timestamp skew is at most 60 seconds. Use exported `signedHeaders`, not a separate canonicalization implementation.

Cloud server environment: `TWITCH_CHANNEL_LOGIN`, `PUBLISH_SHARED_SECRET` (at least 32 characters), `BLOB_READ_WRITE_TOKEN` for a **private** Blob store. Local publisher needs only the first two plus `RECAP_PUBLIC_ORIGIN`; Blob credentials do not belong in the local publisher or browser bundle. The first signed upload binds configured login to channel ID in an immutable identity record. Use a distinct authorized login for isolated tests.

Endpoints:

- `POST /api/publish`: JSON operation; ACK `{publishSeq,headEtag,publicRevision,lastSyncedAt}`.
- `POST /api/publish/export-assets`: signed bytes containing UTF-8 JSON UploadSchema metadata, one LF, then raw asset bytes. `encodeAssetUpload` constructs it. Each asset is at most 3,000,000 bytes. No raw live clip upload route exists.
- `POST /api/publish/maintenance`: signed `{channelId,publishSeq,paths}` (at most 100 paths). Only unreferenced immutable objects with a sequence below the current head can be removed. Identity, head, current snapshots/manifests/assets, future uploads, and arbitrary paths are protected. Current head can never acquire an old-sequence object through a later operation.
- `GET /api/public/channels/:login?untilMs=...`, `GET /api/public/sessions/:id?untilMs=...`: current pointer only. Expired live lease returns 503 with `live_recap_unavailable`; finalized episodes remain readable.
- `GET /api/public/replays/:id?revision=...`: gated current manifest and 6-second visibility lease. Old revisions and revoked IDs return 410.
- `GET /api/public/replays/:id/assets/:assetId?revision=...`: current manifest gate on every request, including Range. Only one bounded explicit `bytes=start-end` range is supported; malformed/multiple/out-of-bounds ranges return 416.

All reads use Blob `useCache:false`; HTTP responses use no-store at browser and CDN layers. Private Blob URLs are never returned. Snapshot IDs/hashes are not public lookup routes. Caps: snapshot 1,000,000 bytes; head 128,000 bytes; 100 episode pointers; 10 manifests. Capacity exhaustion is explicit and never silently drops active content.

`PublicPoller` is a browser-only primitive for visible 2-second polling, focus revalidation, bounded failure backoff, and live/replay 6-second visibility expiry. On unavailability callers must remove story UI and stop replay worker/video/audio, revoke object URLs, and erase source memory. A public Twitch “Watch live” link can remain. Finalized text may opt out of the local heartbeat lease; replay manifests must continue revocation polling.

Tests: `npx vitest run tests/publication`. `tests/publication/live-store-smoke.ts` exports opt-in `runBlobSmoke({store,channelLogin,channelId})`; it does not read environment or execute itself. An authorized orchestrator supplies `new VercelBlobStore(token)` and isolated identity. In-memory tests are not evidence of account provisioning, deployed latency, or actual private-store enforcement.
