# Replay and recordings

Replay makes the source-to-story behavior inspectable without a Twitch or OpenAI account. It runs the production reducer with virtual time, recorded provider outcomes, and a sink that records intended effects instead of sending chat or creating clips.

## The included example

The bundled [`foxlight`](../../fixtures/foxlight.ts) example is an 8-minute recording of a small game development stream: the channel `foxlight_dev` builds a cave platformer about a fox with a lantern. The speech, chat, raid and provider outcomes are authored for this example; the clips are real footage of that small game (`public/demo/foxlight`). There is no real streamer, chat participant or model response. Its provider version is labelled `authored-no-model`.

The bundle is built from its timeline by running the production reducer through `ReplayDriver` and recording an outcome for every request the reducer makes, in English and in Russian. It contains 7 speech passages, 68 chat messages (45 of them from 23 example chatters inside one 10-second window at 1:40), 3 topic boundaries, 3 owner-saved moments, 4 clip attachments, the lore term `moon jump` with its spoken origin at 2:05, and a raid from `pixelmoth` with 37 viewers at 7:10.

Run the [local keyless path](../setup/local.md#install-and-try-replay), then open `/replay`:

1. **Play the recording** follows the stream. The first chapter publishes at 1:54 after its 75-second hold; four chapters are public by the raid.
2. **Jump to the raid** executes the preceding events and advances to the raid scene. It does not replace the state with a finished screenshot or snapshot.
3. **Apply my wording** in **Change the recap** becomes available after the recording's last story update (6:17). It renames the third chapter with the exact checked owner wording included in the bundle. **Preview the next raid scene** shows that correction in the next scene.
4. English and Russian select separately checked recorded presentations at any point of the recording. The language control offers only the languages a recording holds outcomes for; a replay never asks a model, so a live channel's other recap languages are not available here. An arbitrary edit from **Open the streamer dock** stays held when the bundle has no matching safety outcome.
5. **Restart** creates a fresh run. Changes in one replay tab do not edit the broadcaster's live database or another visitor's run.

`/example` opens the real public recap page with the snapshot this recording publishes at the raid, says once that it is an example, and plays the example clips from the same gated recording. It lives outside `/c/<login>`, so a real channel named `foxlight_dev` keeps its own page. `scripts/export-foxlight-raid.mts` writes the exact raid plan and snapshot as JSON for scene and video work.

Speed settings change virtual time. A 4× run demonstrates the same timing rules sooner; it is not a measurement of live transcription or model latency. The older text-only [`authored-notes`](../../fixtures/authored-notes.ts) example remains for tests.

## What a replay contains

A versioned `CaptureBundle` includes initial channel/session/settings data, normalized domain events, exact recorded provider inputs and outcomes, media references, milestones, and assertions. Schema validation and a bundle hash bind those parts together. Provider lookup includes the operation, model/schema/prompt version, and canonical input. Runtime channel and run namespaces are remapped after lookup, so two isolated runs can use the same checked logical evidence.

Small exports use one JSON asset. Larger exports use a JSON index with ordered event and provider chunks, each no larger than 3,000,000 bytes. Every asset has a byte count and SHA-256 hash; the index also commits the hash of the reconstructed bundle. The loader checks all of them before starting replay. A package is limited to 100 assets and 32,000,000 declared bytes, including selected media; the assembled bundle permits at most 10,000 events and 10,000 provider outcomes. A single oversized record fails export rather than being truncated. These are capacity limits, not a promise that any stream duration will fit.

An unmatched request produces `fixture_missing`. Replay does not quietly call a live provider or invent a passing safety result. Source privacy, eligibility timing, owner corrections, scene selection, and invalidation still use the ordinary core rules.

The browser fetches the current manifest, verifies the bundle hash and identity, and revalidates before starting the worker. It polls every two seconds, including while downloading chunks. A changed manifest or revoked asset stops loading or playback and removes the in-memory story. After six seconds without successful revalidation, the visibility lease expires. Local replay serves the authored bundle from its separate private registry; the fixture is not embedded in the public JavaScript bundle.

Own-stream controls follow what was captured. **Jump to the raid** appears only with a recorded raid milestone. **Apply my wording** appears only when a checked correction is included. Language choices include only checked presentations available for the current wording; a recording with one available language shows its name without a switch. The bundled authored example contains all of those optional events, while a safe single-language recording can export without a raid or an edit.

## Capture your own material

An own-stream recording must come from an explicitly started private capture. The recorder captures checked text and normalized events. After stopping, the owner can select ready video or audio from that recording's validated local media cache and review it for export. Raw paths and arbitrary uploaded files are not accepted. Microphone ingestion alone does not record the desktop: record your screen separately in OBS when you need video evidence. An OBS recording is not automatically attached to a replay bundle.

### Record, review, and share in the dock

Select **Recordings** in the local owner dock header to open **Stream recordings**. An armed or active recording also has its status and **Stop recording** in the dock header. These controls are absent from the public build and the isolated demo dock.

1. Choose **Arm next recording** before the next stream session, or **Start private recording** only if the current session has not collected any context. Recording cannot recover earlier provider outcomes. Starting the server or microphone does not arm it.
2. Capture a complete session prefix and at least one checked story result. Let a chapter pass its publication hold before stopping. The export must reproduce a published chapter through deterministic replay, with unchanged safe sources and completed checks for the saved text. A raid, an owner correction, and a second output language are optional; capture them when they belong to the stream you want to share.
3. Choose **Stop recording**, then **Review contents**. Read the channel metadata, every source excerpt, and every saved text field, using **Next** to page through longer lists. The review shows any conditions that still block export.
4. Optionally choose **Select for review** on eligible cached media. Watch the prepared video or listen to the complete audio through the review player, then confirm both its visual and audio checks. An audio-only asset still requires confirmation that it has no visual content. Media changes preserve checks only for unchanged metadata, source versions, text hashes, and media hashes. A changed selection always needs fresh approval for the new capture revision before export.
5. Choose **Approve reviewed contents**, then **Create private export**. Approval binds the exact capture revision, source wording, output hashes, and selected media. Export remains private. Exported contents cannot be changed in place.
6. Choose **Download offline ZIP** for a private copy, acknowledging that it cannot be recalled, or **Publish recording** to upload the reviewed package to your configured public deployment. Keep the collector running while publication is pending. **Open published recording** appears only after that export's own acknowledgement.
7. To stop managed sharing, choose **Withdraw recording** and confirm. Local replay and download access close when the withdrawal is saved; the UI separately reports pending public withdrawal. Keep the collector running, and use **Retry withdrawal** if needed. **Remove recording** becomes available after the required withdrawal acknowledgement. Removing or withdrawing a recording leaves the stream's published chapters in place; use Forget for its underlying stream evidence.

A safety result must match the captured wording unchanged. Captures with unchecked or redacted inputs cannot reuse their original provider checks. A privacy change invalidates the capture and dependent exports rather than silently producing a partial recording; start a new clean recording. Participant identifiers are remapped for export, but this does not remove sensitive information visible in media or spoken in the reviewed text.

Selected media keeps its original source references and full capture interval. At most twelve assets can be selected. Each must fit the 3,000,000-byte asset limit and be no longer than 120 seconds. Larger cached media is prepared as a bounded copy: video requires FFmpeg's `h264_nvenc` encoder; audio can be prepared as MP3. A failed preparation leaves the item unselected. Review the actual prepared bytes through the private preview route before approving both their visual and audio content. No media is selected or published automatically.

The recorder accepts normalized domain values and rejects credential-shaped data. It records provider outcomes alongside their exact inputs so replay can reproduce the checked interpretation. Own-stream replay follows the recorded ticks rather than the authored example's fixed clock. A session privacy-epoch change erases the capture's stored text and invalidates its dependent exports and downloads.

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
| `GET /api/owner/recordings/:id/download` | Download a ZIP containing `manifest.json`, the assembled `bundle.json`, and selected media after current privacy and source checks |
| `DELETE /api/owner/recordings/:id` | Remove an unexported capture, or a revoked export's private capture once `publication.removalAllowed` is true |

Read each source and generated field before submitting its review hash. Do not generate approval by blindly copying the returned hash list. Approval also validates deterministic replay; blocked or changed captures cannot be exported. Arm before the stream session begins so the bundle includes the context needed to reproduce it.

A public replay link appears only after the cloud acknowledges that exact export operation. An unrelated newer publication acknowledgement is insufficient. Revoking a recording closes local export access immediately and queues withdrawal of that export; the original stream sources and chapters remain. A pending or failed withdrawal can be retried. For a queued or published export, private removal waits for the exact withdrawal acknowledgement. A staged export that was never queued can be removed after local revocation. An already downloaded copy cannot be recalled.

The current private recording files live in `DATA_DIR/exports/private-recordings`; reviewed assets live in `DATA_DIR/exports/reviewed-recordings`. Active capture checkpoints at five-second intervals and flushes when stopped. At most twenty private recordings are retained. Private captures are capped at 32,000,000 bytes, 10,000 events, 10,000 provider outcomes, and 100 media candidates; reaching a limit fails capture rather than silently discarding context. A process restart marks an active capture interrupted and does not resume it automatically. An interrupted recording cannot be exported. Start a new recording explicitly; restarting the collector is not a capture command.

## Offline copies and revocation

Public replay needs connectivity because it must keep checking the current manifest. The owner dock's **Download offline ZIP** supplies a reviewed package containing its manifest, an assembled bundle, and the selected media bytes. It does not contain a standalone HTML player. ZIP overhead and the assembled JSON count toward a separate 32,000,000-byte archive limit, so a package within the cloud limits can still be too large to download as one ZIP.

Use [`replayOffline(path, atMs?)`](../../src/server/replay/offline.ts) programmatically to validate and run either this ZIP or an ordinary `CaptureBundle` JSON file. ZIP loading validates paths, CRCs, manifest identity, byte counts, SHA-256 hashes, media membership, and the reconstructed bundle commitment before returning a driver. Its `resolveMedia(id)` supplies verified local bytes and a MIME type for a player integration. The helper has no separate npm command or offline browser UI.

`downloadCurrentReplay(manifestUrl, outputPath)` is a different programmatic helper: it fetches through the current public manifest gate and writes an assembled JSON bundle without overwriting an existing file. That JSON omits media bytes. It is useful for data-only replay, while the owner ZIP preserves selected media too.

Neither offline path makes network requests during replay. Once downloaded, a copy cannot be remotely revoked. Keep it private, and remove it yourself if a later Forget applies. The same limitation applies to copied screenshots, exported media, Git history, and someone else's recording.

## Verification

```powershell
npx vitest run tests/replay
npx tsx docs/setup/verify-keyless.mts
```

Replay tests cover distinct run scopes, exact provider lookup, hold boundaries, custom edits staying held, language changes, privacy before a raid, manifest expiry, and revoked URLs. Packaging tests round-trip a synthetic forty-minute timeline larger than 6 MB through event and provider chunks, check corruption and aggregate size rejection, and verify complete offline JSON. Archive tests validate ZIP media round trips and reject corruption, identity mismatch, and malformed entries. This synthetic timeline is capacity evidence, not an own-stream recording. The isolated setup check also loads the served bundle over verified HTTPS and executes a chapter and raid plan. These checks establish functional behavior of authored material; they do not establish actual Twitch delivery, microphone compatibility, or human comprehension of the scene.
