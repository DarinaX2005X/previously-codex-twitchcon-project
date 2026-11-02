<p align="center"><img src="public/brand/logo-readme.svg" width="660" alt="Previously, with its layered history mark" /></p>

# Catch up with the stream while it keeps going

Previously gives late Twitch viewers the context behind the current moment. It turns spoken context and chat evidence into a short, editable stream history, then uses the published story to welcome an incoming raid in OBS. The streamer controls listening, corrections, and what gets forgotten.

[Try the hosted example](https://previously-seven.vercel.app/replay) | [Run Previously for your channel](#connect-your-channel) | [Source repository](https://github.com/DarinaX2005X/previously-codex-twitchcon-project)

<p align="center"><a href="#try-without-accounts">Try without accounts</a> | <a href="#connect-your-channel">Connect your channel</a> | <a href="#listen-and-add-the-obs-scene">OBS and microphone</a> | <a href="#during-a-stream">During a stream</a> | <a href="#record-review-and-share">Recordings</a> | <a href="#configuration">Configuration</a> | <a href="#host-your-own-viewer-page-optional">Optional hosting</a> | <a href="#recover-and-troubleshoot">Recovery</a> | <a href="#how-it-works">Architecture</a></p>

## Arrive in the middle and understand what changed

<p align="center"><img src="docs/readme/desktop-replay.jpg" width="100%" alt="Desktop authored replay paused with published current context, a chapter, language controls, and its available correction" /></p>
<p><sub>Captured from the running product with illustrative authored text. No captured Twitch footage or actual model responses are shown.</sub></p>

A late arrival needs more than the latest chat reaction. Previously keeps source-backed context available while the streamer continues, with chapters, source times, permitted moments, and explanations of channel-specific phrases when the evidence supports them. A raid uses an already prepared scene instead of waiting for a new story request.

The included example follows a saved note whose preview is empty:

> “I am making notes survive a reload. The saved note is still in storage, but the preview is empty. I am checking the preview renderer.”

The chapter explains the investigation while it remains open. Across performances, conversations, games, and other stream topics, context follows the available evidence. Channel-specific phrases receive explanations only when their meaning is supported.

The owner can inspect sources, edit or pin chapters, save moments, and remove material. A correction immediately withdraws the previous public wording and waits for its own checks. The same accepted wording feeds the public page, bot, and next recap. English and Russian are separate checked recap presentations; recognition preserves the source language. The interface is English.

## Try without accounts

Open the [hosted example](https://previously-seven.vercel.app/replay) in your browser. No installation or account is needed. It is an authored, text-only recording with checked example outcomes:

1. Choose **Play recording**. The source starts at recorded time **0:01** and its first chapter publishes at **1:16**, after the 75-second source hold. **4×** advances recorded time faster.
2. Choose **Jump to raid** to replay the preceding events and show the welcome scene.
3. Choose **Apply correction**, then **Preview next recap**. English and Russian select the example's checked presentations.
4. Open the **demo dock** to edit your own wording. An edit without an exact recorded safety outcome stays held. **Restart** creates a fresh isolated run.

The hosted site demonstrates authored content. Processing your own channel requires a collector running on your streaming computer; it is not provided by opening the demo URL.

### Run the example locally

The supported local certificate setup uses **Windows, Node.js 22.13 or newer, and npm**. Clone or download the repository and open the directory containing `package.json` in PowerShell:

```powershell
npm ci
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
npm run setup:local
npm run build
npm run replay
```

The setup command generates missing local secrets and a localhost certificate without replacing nonempty settings. Confirm the **Previously localhost development** trust prompt for your Windows current user. The PFX is stored in `.data/tls`; keep it with its generated passphrase. Use [https://localhost:4317/replay](https://localhost:4317/replay).

The local example uses the same controls and needs no Twitch, OpenAI, or Vercel account, OBS, or media tools. It makes no live provider calls.

Normal startup binds loopback at `https://localhost:4317`. `/health` returns `{ "alive": true }`; `/ready` reports storage/process readiness. `configuration: "incomplete"` is expected in keyless mode. Stop with **Ctrl+C** before switching to the live process.

## Connect your channel

To run Previously for your own channel, install the local collector with the commands above and configure its Twitch connection. Register an application in the [Twitch developer console](https://dev.twitch.tv/console/apps), select the **Chat Bot** category, and use this exact redirect URL without an extra empty redirect field:

```text
https://localhost:4317/auth/twitch/callback
```

Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `TWITCH_CHANNEL_LOGIN` in your local `.env`. The login is the broadcaster's name without `@` or a URL. For new speech and story checks, also set your server-side `OPENAI_API_KEY` and explicitly choose `OPENAI_PAID_CALLS_ENABLED=true` when you intend to run paid requests. Leave it `false` during account preparation or replay. Restart after environment changes.

Run the built live app:

```powershell
npm start
```

Open [local setup](https://localhost:4317/setup), choose **Connect Twitch**, and authorize the configured broadcaster. Tokens are obtained through that flow and encrypted in SQLite; do not paste tokens into `.env`. Connection alone does not start a stream or microphone.

The flow requests `user:read:chat`, `user:write:chat`, `clips:edit`, `channel:manage:clips`, `channel:moderate`, and `moderation:read`. Chat replies use the broadcaster identity; there is no separate bot-account configuration. Optional VOD markers use `TWITCH_MARKERS_ENABLED=true` and require a restart plus reconnect to grant `channel:manage:broadcast`.

## Listen and add the OBS scene

Use a modern desktop browser with microphone permission and AudioWorklet support. OBS puts the scene on stream. **FFmpeg and FFprobe on `PATH`** are needed for clip validation and prepared audio. Converting oversized recording video also needs a working **`h264_nvenc` encoder and compatible NVIDIA GPU/driver**; there is no software encoder fallback. The text-only replay needs none of those media tools.

1. In a setup tab, choose **Copy OBS overlay URL**. Add the complete private URL to your existing OBS scene as a **1920 × 1080 Browser Source**. Its fragment grants overlay access. **Rotate link** invalidates old access and requires updating OBS. See [OBS Browser Source](https://obsproject.com/kb/browser-source) for URL and viewport properties.
2. Open [the dock](https://localhost:4317/dock) in a normal browser tab. In **Scene settings**, choose the scene position, protected areas, and length. For sound/narration, enable OBS audio control for the Browser Source and check its mixer routing. Avoid duplicating your microphone through the overlay.
3. Once your Twitch stream is live, use **Check configuration** in the separate setup tab until the session appears. In the dock, choose **Resume listening** when paused, or **Start microphone** when listening is enabled but the microphone is off. Grant access to the intended device. Keep this producing dock tab open; open setup/public links in other tabs.

You can add the dock through **OBS Docks → Custom Browser Docks**, but use the normal browser capture tab if the embedded browser cannot grant microphone access. An OBS Browser Source is not the microphone producer. If another tab owns the capture lease, **Take over listening** deliberately stops that producer and listens here.

Scene settings offer 10, 12, or 15 seconds for the full recap. An early welcome without enough supported context lasts 5 seconds. Optional **Context for an early welcome** and an approved **previous-stream clip** help before chapters exist; setup provides **Preview previous clip** and **Use previous clip**. That footage is labelled as belonging to a previous stream. A welcome still works without video. One scene plays while one welcome waits; later arrivals merge into that bounded queue.

## During a stream

Let Previously gather context while you stream. Chapters become available after their checks and publication hold; the default hold is 75 seconds from the end of supporting material, with processing time in addition. Inspect the source behind a chapter, edit its wording, or pin it for the next recap. Use **Preview** for a local view and **Show recap** to play on the connected OBS source. The configured shortcut works while the dock has focus.

Viewers can send `!previously` in your chat for current context and, when your viewer page is configured, its link. `!lore TERM` returns a checked channel-specific explanation when one is available. Commands have cooldowns and ignore the broadcaster bot's own replies.

Use **Save moment** on a genuine moment. Automatic clip creation is off until **Allow automatic Twitch clips** is selected in scene settings. A moment can retain only a timecode when Twitch clips are unavailable. Inspect a ready official clip separately from the saved marker. Optional Twitch stream markers require a live broadcast, enabled VOD storage, and their additional scope; requests expire after 60 seconds rather than marking a later point. An unavailable marker preserves the timecode. See [Twitch Create Stream Marker](https://dev.twitch.tv/docs/api/reference/#create-stream-marker).

Enable **Show a recap when a raid arrives** in scene settings to welcome incoming viewers automatically. The scene uses already published context, so a raid does not wait for a fresh model request. Your Twitch incoming-raid settings still apply; see [Twitch's raid guide](https://help.twitch.tv/s/article/how-to-use-raids?language=en_US).

## Record, review, and share

The recorder saves private normalized context and exact checked provider outcomes for replay. It does not record the desktop or automatically attach raw microphone audio. Keep separate OBS screen/audio recordings outside Git and review their visible content and sound before sharing.

<p align="center"><img src="docs/readme/desktop-recording-review.jpg" width="100%" alt="Desktop private review showing authored fixture metadata, source and owner-statement excerpts, and unchecked review controls" /></p>
<p><sub>Captured from the local owner review with illustrative authored fixture content. This is not evidence of a recorded Twitch broadcast.</sub></p>

1. Before the session collects context, open **Recordings → Arm next recording**. **Start private recording** is available only when the server confirms the current session has no earlier context. The header keeps armed/recording state and **Stop recording** accessible after you close the sheet.
2. Capture a checked story and let a chapter publish. When finished, **Pause listening**, confirm the pause, then **Stop recording**. You can end the Twitch broadcast and separate OBS recording; if public sync or sharing is enabled, keep the collector running for acknowledgements. Export needs a complete stopped prefix, unchanged safe sources, completed recorded text checks, and deterministic replay that reaches a published chapter. A raid, correction, second language, or media asset is optional.
3. Open **Review contents**. Review the metadata, every source excerpt, and all saved text fields, paging through longer lists. Select optional ready media from this recording's validated cache and watch/listen to its actual prepared bytes. Confirm both visual and audio checks; text moderation cannot inspect a secret on screen. Arbitrary local paths or uploads cannot be attached.
4. Choose **Approve reviewed contents**, then **Create private export**. Changes to media preserve checks only for exact unchanged content, and always require fresh approval for the new revision. An exported package cannot be edited in place.
5. **Download offline ZIP** provides `manifest.json`, an assembled `bundle.json`, and selected media after acknowledgement that the copy cannot be remotely recalled. It is a data/media package, not a standalone HTML player. The programmatic [`replayOffline`](src/server/replay/offline.ts) helper supports ZIP and JSON without provider calls.
6. Optionally choose **Publish recording** to share it through your [own viewer page](#host-your-own-viewer-page-optional). This uploads the reviewed assets separately from private export. Wait for **Open published recording**; only that export's exact acknowledgement enables its public link. **Retry publication** is available when confirmation fails. Private export and offline download do not require public hosting.
7. **Withdraw recording** closes managed local replay/download access immediately and, if it was shared, queues public withdrawal. Keep the collector running until acknowledged; use **Retry withdrawal** if needed. **Remove recording** is enabled after any required public withdrawal acknowledgement. The stream's chapters remain in place because withdrawal affects the export, not its original sources.

These capacity limits determine what can be recorded/exported; they are not stream-duration guarantees:

| Recording item | Limit |
| --- | --- |
| Retained private recordings | 20 |
| Private capture | 32,000,000 bytes; 10,000 events; 10,000 provider outcomes; 100 media candidates |
| Selected media | Up to 12 assets, each at most 3,000,000 bytes and 120 seconds |
| Public package | Up to 100 assets and 32,000,000 declared bytes including selected media |
| Offline ZIP | 32,000,000 bytes including assembled JSON, manifest, media and archive overhead |

Larger cached video is prepared with `h264_nvenc`; audio may be prepared as MP3. A failed conversion stays unselected. Reaching a capture limit fails the capture instead of silently discarding context. A process restart marks an active capture interrupted; it cannot resume or export. Public replay only offers raid/correction/language controls present in that recording. Deep bundle and owner API contracts are in the [replay reference](docs/replay/README.md).

## Correct the story and control privacy

**Edit** withdraws the old published chapter wording immediately, holds the owner statement for checks, and protects it from later automatic generation. A safe correction does not begin another full source hold. **Pin** changes selection priority without bypassing safety or privacy. **Delete** removes the chapter while retaining its captured sources.

**Pause listening** immediately stops the microphone, incomplete samples, and queued local audio, then confirms the server pause of new speech/chat collection. Connection/deletion/control events still run. If confirmation fails, **Retry pause** keeps the device stopped while retrying; already uploaded speech may still finish until confirmation. **Forget last 2 min** is the separate action for accepted source material and all dependent chapters, lore, media, queued playback and exports. Pins do not protect forgotten material.

Forget also invalidates the private capture and dependent exports; a new recording needs a clean session. Late provider results and old revisions cannot restore erased sources. If you share a viewer page, a cloud removal made offline remains pending until its retraction is acknowledged. Already downloaded ZIPs, copied footage/screenshots, Git copies and other people's recordings cannot be recalled.

Twitch can create a clip before Previously's publication hold ends. Forget hides that clip from Previously and supplies manual-cleanup links, but deleting it on Twitch is an owner action through the [clip manager](https://dashboard.twitch.tv/content/clips). A saved moment, a ready local video and an external clip are distinct states. No whole-stream video is reconstructed from microphone input.

## Configuration

The server reads project `.env`; process environment wins. Restart after changes. The safe [`.env.example`](.env.example) contains the effective variable names. Keep credentials server-side and out of Git, public assets, screenshots, and browser-prefixed variables such as `VITE_` or `NEXT_PUBLIC_`.

Local HTTPS and persistence settings are generated or defaulted by setup:

| Variable | Required/default and purpose |
| --- | --- |
| `PORT` | Fixed `4317`; other normal values are rejected |
| `HOST` | Default `127.0.0.1`; only that or `localhost` is accepted |
| `LOCAL_ORIGIN` | Fixed `https://localhost:4317` for links, cookies and origin checks |
| `DATA_DIR` | Default `.data`, relative to project; private SQLite, audio, media and exports |
| `LOCAL_TLS_PFX` | Default `.data/tls/localhost.pfx`, created by setup |
| `LOCAL_TLS_PASSPHRASE` | Generated, at least 32 bytes; required with matching PFX for HTTPS |
| `SESSION_SECRET` | Generated, at least 32 bytes; required for owner session/control protection |
| `TOKEN_ENCRYPTION_KEY` | Generated base64 32-byte key; preserve it to decrypt saved OAuth credentials |

Service configuration determines which live/public paths are available:

| Variable | Required/default and purpose |
| --- | --- |
| `TWITCH_CLIENT_ID` | Required for live integration; from your Twitch application |
| `TWITCH_CLIENT_SECRET` | Required for live integration; application's server-only secret |
| `TWITCH_CHANNEL_LOGIN` | Required broadcaster login for live integration and public deployment |
| `TWITCH_REDIRECT_URI` | Fixed `https://localhost:4317/auth/twitch/callback` |
| `TWITCH_MARKERS_ENABLED` | Optional `false` by default; `true` enables marker attempts and needs restart/reconnect for extra scope |
| `OPENAI_API_KEY` | Required for new provider work; absent/disabled providers leave new work held, not replaced with invented output |
| `OPENAI_PAID_CALLS_ENABLED` | Default `false`; must explicitly be `true` for paid dispatch; replay never uses live providers |
| `RECAP_PUBLIC_ORIGIN` | HTTPS Vercel origin without trailing slash; required for public sync, omitted for isolated local replay |
| `PUBLISH_SHARED_SECRET` | Generated locally, at least 32 bytes; must match cloud for signed publication |
| `BLOB_READ_WRITE_TOKEN` | Required in Vercel server environment; normal local publisher does not need it |

Initial story settings apply only to a fresh channel; an existing channel keeps its saved choices:

| Variable | Default and accepted values |
| --- | --- |
| `RECAP_LANGUAGE` | `en`; `en` or `ru`, independent of source recognition language |
| `PUBLICATION_DELAY_SECONDS` | `75`; integer from 60 to 90 seconds, with safety/dependency checks still required |

Change persisted language and scene settings through the dock. Models, budget, narration, alternate provider URLs, and separate bot identity have no environment overrides.

Provider adapters currently use `gpt-transcribe` for recognition, `gpt-6-luna` for structured story and contextual checks, `omni-moderation-latest` for moderation, and optional `gpt-realtime-2.1-mini` narration. Confirm that your API account can access those models. Narration is off by default and is enabled through scene settings.

The product has a fixed **$4.50 persistent dispatch ceiling**. Each paid attempt reserves budget before dispatch; restarts do not reset reservations or usage, and an ambiguous timeout can retain its allowance. Preserve the database rather than deleting it to reset this limit, because it also holds authorization, private history and privacy fences.

## Host your own viewer page (optional)

Set this up if you want a public recap page or shareable recordings for your channel. The hosted URL at the top is an authored demo. Your stream still needs its own local collector; Vercel serves its permitted published content and does not run the microphone or EventSub connection.

1. Import this repository into Vercel with the directory containing `package.json` as project root. [`vercel.json`](vercel.json) sets `npm run build:public`, output `dist-public`, and API routing. Use a Node runtime compatible with Node 22.
2. Create/connect a **private Vercel Blob store**. Add these server environment variables to the deployment:

| Cloud variable | Value |
| --- | --- |
| `TWITCH_CHANNEL_LOGIN` | Broadcaster login this deployment may serve |
| `PUBLISH_SHARED_SECRET` | Same generated secret as the local collector, at least 32 bytes |
| `BLOB_READ_WRITE_TOKEN` | Token for the private store, kept server-side |

3. Redeploy after environment changes. Locally set `RECAP_PUBLIC_ORIGIN` to the deployment's HTTPS origin without a trailing slash and use the matching `PUBLISH_SHARED_SECRET`; restart the collector.
4. Open the public channel address shown in setup, `/c/<channel-login>`. The first signed publication binds that login to its numeric Twitch identity.

The collector sends permitted snapshots and privacy retractions automatically. Viewers receive gated content rather than direct Blob URLs, private transcripts, microphone uploads or OAuth tokens. Signed operations and conditional writes prevent older revisions replacing the current page. Keep the collector running while the live page needs heartbeat renewal and while an edit, shared recording, or withdrawal awaits acknowledgement.

Live snapshots have a 30-second server lease; stale live content is hidden when validation expires. A finalized episode can remain readable after the collector stops. Public replay polls its current manifest every two seconds and expires after six seconds without successful validation, so shared replay needs connectivity. Publishing a recording from the dock gives it a separate public link; deploying the page alone does not upload a recording.

A cloud snapshot is bounded at 1,000,000 bytes. The current channel head retains at most 100 episode pointers and 10 export manifests. The [publication reference](docs/setup/publication.md) covers the signed API and administrative maintenance.
## Recover and troubleshoot

SQLite migrations run at startup. `DATA_DIR/previously.sqlite` retains sessions, evidence, history, settings, encrypted authorization, durable work, privacy fences, publication sequences, and budget records. Private captures live in `DATA_DIR/exports/private-recordings`; reviewed assets live in `DATA_DIR/exports/reviewed-recordings`. None belongs in a public/static directory. Back up the stopped database with its matching encryption configuration. A backup predating Forget can contain erased material and needs privacy reconciliation before reuse.

Use **Ctrl+C** for normal shutdown. Rebuild after code changes before `npm start`. `npm run dev` watches the server and can recover a genuinely stale process lock; it still serves the last built client. `npm run dev:ui` uses port 4318 for UI development and does not replace the HTTPS owner server.

| Symptom | Recovery |
| --- | --- |
| Certificate warning | Run `npm run setup:local`, handle the current-user trust prompt, and use exact `https://localhost:4317`. Keep the matching PFX/passphrase; do not disable certificate checks. |
| Port/database already in use | Reuse the collector or stop it normally. Do not start a second process against the same database; stale-lock recovery is for a dead process only. |
| Microphone denied/missing | Check browser and Windows microphone permissions, select a device, and use **Resume listening** or **Retry microphone**. A normal browser tab is the OBS fallback; **Continue with chat only** is available for denied/missing input. |
| Unconfirmed server pause | Use **Retry pause**. The device stays stopped; already uploaded speech may still finish until confirmation. Forget removes accepted material separately. |
| No active session/Twitch reconnect | Start a real Twitch broadcast, check configuration, and reconnect the configured broadcaster with the exact callback/scopes. Signing in alone is not a stream. |
| New wording held/provider unavailable | Check paid mode, account model access and safety status. Existing safe context remains unless an edit/privacy action withdrew it. Authored replay only accepts recorded checked outcomes. |
| Clip or marker unavailable | Check permissions/live/VOD requirements, FFmpeg/FFprobe for local clip validation, and the official clip link. A saved timecode remains useful without ready video. |
| OBS source/layout/audio unavailable | Recheck the private URL and 1920×1080 size, protected regions and caption length. Preview stays local; enable source audio routing explicitly for sound/narration. |
| Public story disappears or edit stays pending | Restore collector/cloud connectivity and matching origin/secret/private store. Live leases intentionally expire. A local save is not a cloud acknowledgement. |
| Recording cannot start/export | Arm before context; open **Review contents** for missing checks. Interrupted, capacity-failed, changed-source or incomplete captures need a new clean recording. |
| Media preparation/ZIP size fails | Check `h264_nvenc` availability and 120-second media bound. Select fewer optional assets before export; an existing export cannot be edited. ZIP overhead also counts toward its size cap. |
| Withdrawal pending | Keep the collector running and use **Retry withdrawal** if shown. Wait until removal is allowed; do not delete files needed to complete the retraction. |
| Disk full | Stop new capture, free unrelated space, and restart. Preserve the database, encryption key, publication state and privacy tombstones. Cache cleanup must not bypass protected playback or revocation. |

The media cache defaults to 512 MB or 12 files; a download is bounded at 80 MB. Eligible older files are evicted, active playback is protected, and privacy revocation wins. Storage failure rejects a change rather than claiming it was saved.

## How it works

```mermaid
flowchart TD
  Mic["Microphone<br/>Browser audio"] --> Local
  Twitch["Twitch<br/>Chat and stream events"] --> Local
  Dock["Owner dock<br/>Pause, edit, Forget"] --> Local
  Local["Local HTTPS collector<br/>Story core and SQLite"]
  Local <-->|Private model requests| OpenAI["OpenAI<br/>Speech, story, safety"]
  Local --> Gate["Publication checks<br/>Delay, sources, privacy"]
  Local --> Capture["Private recording<br/>Review and export"]
  Gate --> OBS["OBS<br/>Prepared recap scene"]
  Gate --> Cloud["Vercel and private Blob<br/>Signed, gated publication"]
  Capture -->|Separate publish action| Cloud
  Cloud --> Viewer["Public viewers<br/>Recap or isolated replay"]
```

The diagram separates local evidence, provider processing and viewer publication. OpenAI transcribes speech, proposes structured claims/lore, and checks grounding, privacy and moderation. Deterministic code validates contracts, source revisions, language, privacy epochs and eligibility before committing a published projection. A model response cannot publish directly. The bounded hot context retains up to 500 sources, including protected recent non-chat evidence; older provenance and paginated history remain in SQLite.

Replay runs the same core in an isolated worker with exact recorded provider outcomes and simulated effects, so it cannot send Twitch chat or create clips. An unmatched request stays held. Live publication and asset reads check current revisions; a guessed old URL cannot bypass a revoked manifest. A cutoff on the public reader excludes any item with a dependency after the selected time, and local last-viewed state can be cleared. Finalized episodes remain separate from the next stream.

The implementation uses these technologies for distinct roles:

| Technology | Role |
| --- | --- |
| TypeScript, React, Vite | Dock, setup, public reader, replay worker and OBS renderer |
| Node.js, Express, native SQLite | Local HTTPS, encrypted tokens, evidence graph, durable work, budget and publication fences |
| Twitch EventSub and Helix | Stream/chat/moderation events, raid triggers, chat replies, authorized clips and optional markers |
| OpenAI adapters | Transcription, structured proposals, grounding/privacy/moderation, optional narration |
| Vercel Functions and private Blob | Signed writes, current snapshots, revocable manifests and gated reads |

Codex was used to implement the domain model, adapters, interfaces and integration tests, and investigate failures across those boundaries. VibeMachina supplied planning, design and review guidance; it is not a runtime dependency. [Onest](public/fonts/OFL-Onest.txt) is included under the SIL Open Font License. The [brand assets](public/brand/) share an outlined SVG source; the [media handoff](docs/media/README.md) identifies reusable assets and capture boundaries.

## Verification and limits

Run the repository checks and isolated keyless startup probe:

```powershell
npm run check
npx tsx docs/setup/verify-keyless.mts
```

`npm run check` typechecks, runs tests, and builds local and public clients. The keyless probe uses temporary SQLite and an ephemeral listener with the generated localhost certificate. It checks HTTPS, readiness, authored replay integrity and chapter/raid behavior with external fetches blocked, and can run alongside the collector.

The example and many adapter tests use authored inputs. They verify functional behavior rather than an actual Twitch broadcast. Real authorization/events, microphone and OBS compatibility, model output quality, clip alignment, and broadcast sound still require verification with the intended setup. No viewer-retention or measured comprehension result is claimed.

For deeper contracts and exact evidence, use the [architecture](docs/architecture/README.md), [replay/API reference](docs/replay/README.md), [provider notes](src/server/providers/README.md), [functional preflight](docs/testing/functional/release-preflight.md), [cloud checks](docs/testing/cloud-storage.md), [visual observations](docs/testing/visual/experience-review.md), [reliability report](docs/testing/reliability/README.md), and [requirements reconciliation](docs/testing/final/requirements.md).

