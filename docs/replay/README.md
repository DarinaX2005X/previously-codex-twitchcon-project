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

An unmatched request produces `fixture_missing`. Replay does not quietly call a live provider or invent a passing safety result. Source privacy, eligibility timing, owner corrections, scene selection, and invalidation still use the ordinary core rules.

The browser fetches the current manifest, verifies the bundle hash and identity, and revalidates before starting the worker. It polls again every two seconds. A changed or unavailable manifest stops playback and removes the in-memory story. After six seconds without successful revalidation, the visibility lease expires. Local replay serves the authored bundle from its separate private registry; the fixture is not embedded in the public JavaScript bundle.

## Capture your own material

An own-stream recording must come from an explicitly started private capture. The current recorder exports checked text and normalized events. It excludes screen images, video, audio bytes, and raw file paths. Microphone ingestion alone does not record the desktop: record your screen separately in OBS when you need video evidence. An OBS recording is not automatically attached to a replay bundle.

The recorder accepts normalized domain values and rejects credential-shaped data. It records provider outcomes alongside their exact inputs so replay can reproduce the checked interpretation. Own-stream replay follows the recorded ticks rather than the authored example's fixed clock. A privacy deletion erases affected captured text and invalidates dependent exports and downloads.

Export review must cover source text, generated wording, and stream metadata. If safety sanitization changes a provider input or its supporting source, export is blocked because the original recorded outcome cannot validate the changed material. A matching review receipt belongs to the reviewed capture revision; a stale receipt is not an approval for new content. Any separately shared screen recording needs its own visual and audio review.

Private captures and prepared exports stay under `DATA_DIR`, outside Git and public/static directories. An approved local export is a preparation step, not an automatic public upload. Publication requires bounded assets followed by a signed manifest through the [public publication service](../setup/publication.md). The manifest records whether its origin is `authored` or `own-stream`; those labels are not interchangeable.

### Owner recording API

The [recording router](../../src/server/replay/recording-router.ts) uses the local owner session and the same Origin, CSRF, and idempotency protection as the dock. These are authenticated local API operations, not public recording links.

| Operation | Request and result |
| --- | --- |
| `GET /api/owner/recordings` | List private recording state and export identifiers |
| `POST /api/owner/recordings/start` | `{}` arms the next session. `{ "sessionId": "..." }` starts only when that session has no earlier context. |
| `POST /api/owner/recordings/:id/stop` | `{}` stops capture so its contents can be reviewed |
| `GET /api/owner/recordings/:id/review` | Read source excerpts, output fields, hashes, the capture revision and digest, and any reasons export is blocked |
| `POST /api/owner/recordings/:id/review` | Submit the exact reviewed revision/digest, source ID/revision/text-hash entries, output hashes, and `metadataReviewed: true`; receive a bound `receiptId` |
| `POST /api/owner/recordings/:id/export` | `{ "reviewReceiptId": "..." }` prepares a private export with its original source lineage; it does not upload |
| `POST /api/owner/recordings/:id/publish` | `{}` explicitly queues the staged export for signed cloud publication |
| `GET /api/owner/recordings/:id/download` | Download the current reviewed bundle after its privacy and source checks |
| `DELETE /api/owner/recordings/:id` | Remove an unexported private capture |

Read each source and generated field before submitting its review hash. Do not generate approval by blindly copying the returned hash list. Approval also validates deterministic replay; blocked or changed captures cannot be exported. Arm before the stream session begins so the bundle includes the context needed to reproduce it.

The current private recording files live in `DATA_DIR/exports/private-recordings`; reviewed assets live in `DATA_DIR/exports/reviewed-recordings`. A process restart marks an active capture interrupted and does not resume it automatically. An interrupted recording cannot be exported. Start a new recording explicitly; restarting the collector is not a capture command.

## Offline copies and revocation

Public replay needs connectivity because it must keep checking the current manifest. An explicitly downloaded bundle can instead be validated and run locally through [`replayOffline`](../../src/server/replay/offline.ts) or `ReplayDriver`. The offline helper is a programmatic API, not a separate npm command. The authenticated recording download route supplies reviewed owner exports.

`downloadCurrentReplay(manifestUrl, outputPath)` fetches through the manifest gate and writes a new file without overwriting an existing one. Once downloaded, that copy cannot be remotely revoked. Keep it private, and remove it yourself if a later Forget applies. The same limitation applies to copied screenshots, exported media, Git history, and someone else's recording.

## Verification

```powershell
npx vitest run tests/replay
npx tsx docs/setup/verify-keyless.mts
```

Replay tests cover distinct run scopes, exact provider lookup, hold boundaries, custom edits staying held, language changes, privacy before a raid, manifest expiry, and revoked URLs. The isolated setup check also loads the served bundle over verified HTTPS and executes a chapter and raid plan. These checks establish functional behavior of authored material; they do not establish actual Twitch delivery, microphone compatibility, or human comprehension of the scene.
