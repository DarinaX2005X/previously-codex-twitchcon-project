# Replay and recordings

Replay makes the source-to-story behavior inspectable without a Twitch or OpenAI account. It runs the production reducer with virtual time, recorded provider outcomes, and a sink that records intended effects instead of sending chat or creating clips.

## The included example

The bundled [`authored-notes`](../../fixtures/authored-notes.ts) example is a 100-second text scenario about a saved note with an empty preview. It has no real streamer, chat participants, video, microphone recording, or model responses. Its provider version is labelled `authored-no-model`.

Run the [local keyless path](../setup/local.md#install-and-try-replay), then open `/replay`:

1. **Play recording** introduces the source at recorded time 0:01. The first published context appears at 1:16 after its 75-second hold.
2. **Jump to raid** executes the preceding events and advances to the raid scene. It does not replace the state with a finished screenshot or snapshot.
3. **Apply correction** uses the exact checked owner wording included in the bundle. **Preview next recap** displays that correction in the next plan.
4. English and Russian select separately checked recorded presentations. An arbitrary edit from the demo dock stays held when the bundle has no matching safety outcome.
5. **Restart** creates a fresh run. Changes in one replay tab do not edit the broadcaster's live database or another visitor's run.

Speed settings change virtual time. A 4× run demonstrates the same timing rules sooner; it is not a measurement of live transcription or model latency. The example's video-free scene is intentional, and it must not be presented as recorded Twitch footage.

## What a replay contains

A versioned `CaptureBundle` includes initial channel/session/settings data, normalized domain events, exact recorded provider inputs and outcomes, media references, milestones, and assertions. Schema validation and a bundle hash bind those parts together. Provider lookup includes the operation, model/schema/prompt version, and canonical input. Runtime channel and run namespaces are remapped after lookup, so two isolated runs can use the same checked logical evidence.

Small exports use one JSON asset. Larger exports use a JSON index with ordered event and provider chunks, each no larger than 3,000,000 bytes. Every asset has a byte count and SHA-256 hash; the index also commits the hash of the reconstructed bundle. The loader checks all of them before starting replay. A package is limited to 100 assets and 32,000,000 declared bytes, including selected media; the assembled bundle permits at most 10,000 events and 10,000 provider outcomes. A single oversized record fails export rather than being truncated. These are capacity limits, not a promise that any stream duration will fit.

An unmatched request produces `fixture_missing`. Replay does not quietly call a live provider or invent a passing safety result. Source privacy, eligibility timing, owner corrections, scene selection, and invalidation still use the ordinary core rules.

The browser fetches the current manifest, verifies the bundle hash and identity, and revalidates before starting the worker. It polls every two seconds, including while downloading chunks. A changed manifest or revoked asset stops loading or playback and removes the in-memory story. After six seconds without successful revalidation, the visibility lease expires. Local replay serves the authored bundle from its separate private registry; the fixture is not embedded in the public JavaScript bundle.

## Capture your own material

An own-stream recording must come from an explicitly started private capture. The recorder captures checked text and normalized events. After stopping, the owner can select ready video or audio from that recording's validated local media cache and review it for export. Raw paths and arbitrary uploaded files are not accepted. Microphone ingestion alone does not record the desktop: record your screen separately in OBS when you need video evidence. An OBS recording is not automatically attached to a replay bundle.

Selected media keeps its original source references and full capture interval. At most twelve assets can be selected. Each must fit the 3,000,000-byte asset limit and be no longer than 120 seconds. Larger cached media is prepared as a bounded copy: video requires FFmpeg's `h264_nvenc` encoder; audio can be prepared as MP3. A failed preparation leaves the item unselected. Review the actual prepared bytes through the private preview route before approving both their visual and audio content. No media is selected or published automatically.

The recorder accepts normalized domain values and rejects credential-shaped data. It records provider outcomes alongside their exact inputs so replay can reproduce the checked interpretation. Own-stream replay follows the recorded ticks rather than the authored example's fixed clock. A privacy deletion erases affected captured text and invalidates dependent exports and downloads.

Export review must cover source text, generated wording, and stream metadata. If safety sanitization changes a provider input or its supporting source, export is blocked because the original recorded outcome cannot validate the changed material. A matching review receipt belongs to the reviewed capture revision; a stale receipt is not an approval for new content. Any separately shared screen recording needs its own visual and audio review.

Private captures and prepared exports stay under `DATA_DIR`, outside Git and public/static directories. An approved local export is a preparation step, not an automatic public upload. Publication requires bounded assets followed by a signed manifest through the [public publication service](../setup/publication.md). The manifest records whether its origin is `authored` or `own-stream`; those labels are not interchangeable.

### Owner recording API

The [recording router](../../src/server/replay/recording-router.ts) uses the local owner session and the same Origin, CSRF, and idempotency protection as the dock. These are authenticated local API operations, not public recording links.

| Operation | Request and result |
| --- | --- |
| `GET /api/owner/recordings` | List private recording state, export identifiers, and publication state (`staged`, `queued`, `published`, `revoked`, or `error`) |
| `POST /api/owner/recordings/start` | `{}` arms the next session. `{ "sessionId": "..." }` starts only when that session has no earlier context. |
| `POST /api/owner/recordings/:id/stop` | `{}` stops capture so its contents can be reviewed |
| `POST /api/owner/recordings/:id/media` | `{ "mediaId": "..." }` selects and prepares eligible cached media after capture stops |
| `GET /api/owner/recordings/:id/media/:mediaId` | Preview the selected private media bytes for review |
| `DELETE /api/owner/recordings/:id/media/:mediaId` | Remove the selection before export |
| `GET /api/owner/recordings/:id/review` | Read source excerpts, output fields, hashes, the capture revision and digest, and any reasons export is blocked |
| `POST /api/owner/recordings/:id/review` | Submit the exact reviewed revision/digest, source ID/revision/text-hash entries, output hashes, selected media ID/hash entries with `visualReviewed: true` and `audioReviewed: true`, and `metadataReviewed: true`; receive a bound `receiptId` |
| `POST /api/owner/recordings/:id/export` | `{ "reviewReceiptId": "..." }` prepares a private export with its original source lineage; it does not upload |
| `POST /api/owner/recordings/:id/publish` | `{}` explicitly queues the staged export for signed cloud publication |
| `POST /api/owner/recordings/:id/revoke` | `{}` closes managed export access locally and queues public withdrawal when needed |
| `GET /api/owner/recordings/:id/download` | Download the current reviewed bundle after its privacy and source checks |
| `DELETE /api/owner/recordings/:id` | Remove an unexported capture, or a revoked export's private capture once `publication.removalAllowed` is true |

Read each source and generated field before submitting its review hash. Do not generate approval by blindly copying the returned hash list. Approval also validates deterministic replay; blocked or changed captures cannot be exported. Arm before the stream session begins so the bundle includes the context needed to reproduce it.

A public replay link appears only after the cloud acknowledges that exact export operation. An unrelated newer publication acknowledgement is insufficient. Revoking a recording closes local export access immediately and queues withdrawal of that export; the original stream sources and chapters remain. A pending or failed withdrawal can be retried. For a queued or published export, private removal waits for the exact withdrawal acknowledgement. A staged export that was never queued can be removed after local revocation. An already downloaded copy cannot be recalled.

The current private recording files live in `DATA_DIR/exports/private-recordings`; reviewed assets live in `DATA_DIR/exports/reviewed-recordings`. Active capture checkpoints at five-second intervals and flushes when stopped. Private captures are capped at 32,000,000 bytes, 10,000 events, 10,000 provider outcomes, and 100 media candidates; reaching a limit fails capture rather than silently discarding context. A process restart marks an active capture interrupted and does not resume it automatically. An interrupted recording cannot be exported. Start a new recording explicitly; restarting the collector is not a capture command.

## Offline copies and revocation

Public replay needs connectivity because it must keep checking the current manifest. An explicitly downloaded bundle can instead be validated and run locally through [`replayOffline`](../../src/server/replay/offline.ts) or `ReplayDriver`. The offline helper is a programmatic API, not a separate npm command. The authenticated recording download route supplies reviewed owner exports.

`downloadCurrentReplay(manifestUrl, outputPath)` fetches through the manifest gate and writes a new file without overwriting an existing one. Both this helper and the owner download route assemble chunks into one ordinary `CaptureBundle` JSON file, so offline replay does not require the index or separate event/provider files. Selected media bytes are not embedded in that JSON download. Once downloaded, that copy cannot be remotely revoked. Keep it private, and remove it yourself if a later Forget applies. The same limitation applies to copied screenshots, exported media, Git history, and someone else's recording.

## Verification

```powershell
npx vitest run tests/replay
npx tsx docs/setup/verify-keyless.mts
```

Replay tests cover distinct run scopes, exact provider lookup, hold boundaries, custom edits staying held, language changes, privacy before a raid, manifest expiry, and revoked URLs. Packaging tests round-trip a synthetic forty-minute timeline larger than 6 MB through event and provider chunks, check corruption and aggregate size rejection, and verify complete offline JSON. This synthetic timeline is capacity evidence, not an own-stream recording. The isolated setup check also loads the served bundle over verified HTTPS and executes a chapter and raid plan. These checks establish functional behavior of authored material; they do not establish actual Twitch delivery, microphone compatibility, or human comprehension of the scene.
