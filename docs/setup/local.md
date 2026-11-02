# Run Previously on the streaming computer

The supported certificate setup path is Windows with Node.js 22.13 or newer and npm. A modern desktop browser supplies microphone permission and the AudioWorklet capture path. OBS is needed to put the recap scene on stream. FFmpeg and FFprobe must be on `PATH` for downloaded clip validation and prepared audio. Preparing oversized recording video also requires an FFmpeg build with `h264_nvenc` and a compatible NVIDIA GPU/driver; there is no software encoder fallback. The example replay needs none of these media tools.

New to broadcasting? Follow [Your first stream with Previously](first-stream.md) for one suggested route from a private OBS test to a reviewed stream replay.

## Install and try replay

Download or clone the [repository](https://github.com/DarinaX2005X/previously-codex-twitchcon-project), then open the directory containing `package.json` in PowerShell.

```powershell
npm ci
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
npm run setup:local
npm run build
npm run replay
```

Open [https://localhost:4317/replay](https://localhost:4317/replay). Choose **Play the recording** or **Jump to the raid**. The example is an authored game development stream with real gameplay clips, and it is isolated from Twitch. It needs no provider accounts. New arbitrary wording stays held unless the recording contains the exact checked result.

The certificate script creates an exportable localhost certificate in the Windows CurrentUser store, writes its PFX into `.data/tls`, and asks Windows to trust that certificate for the current user. It generates missing session, encryption, publication, and certificate secrets without replacing nonempty values. Answer the Windows certificate prompt when it appears. Do not disable certificate validation to work around a failed setup.

Normal startup uses the fixed origin `https://localhost:4317` and loopback binding. Keep this origin and the Twitch callback unchanged. The server's `/health` returns `{ "alive": true }`; `/ready` reports storage and process readiness. In keyless replay, `configuration: "incomplete"` is expected because live credentials are absent.

After certificate setup and a build, a separate smoke check can run without stopping an existing collector:

```powershell
npx tsx docs/setup/verify-keyless.mts
```

It reuses only the localhost certificate, creates a fresh temporary database, starts an ephemeral listener through the programmatic runtime API, and blocks external fetches. It checks HTTPS, readiness, replay manifest integrity, the first published chapter, and a raid plan. It does not change the configured production port or grant provider access.

## Connect the channel

Create an application in the [Twitch developer console](https://dev.twitch.tv/console/apps). [Twitch requires two-factor authentication](https://dev.twitch.tv/docs/authentication/register-app/) on the account that registers it. Choose client type **Confidential** so the app has a client secret; any category works. Register this exact OAuth redirect URL:

```text
https://localhost:4317/auth/twitch/callback
```

Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `TWITCH_CHANNEL_LOGIN` in the local `.env`. The login is the broadcaster's account name without `@` or a URL. See the [configuration reference](configuration.md) before enabling other services.

Stop the replay process with **Ctrl+C**, then start the built app:

```powershell
npm start
```

Open [channel setup](https://localhost:4317/setup), select **Connect Twitch**, and sign in with the configured broadcaster account. OAuth tokens are obtained through that flow and encrypted in SQLite; do not paste tokens into `.env`. Reconnect if the account, token, or required permissions change.

The current authorization requests `user:read:chat`, `user:write:chat`, `clips:edit`, `channel:manage:clips`, `channel:moderate`, and `moderation:read`. These cover chat, clip operations, and moderation state. The runtime uses the broadcaster identity; a separately configured bot account is not part of this connection flow. Optional VOD markers are off by default. To enable them, set `TWITCH_MARKERS_ENABLED=true`, restart, and reconnect Twitch to grant `channel:manage:broadcast`.

Start a real stream on Twitch and use **Check again** in setup until the active session is available. Connecting the account does not itself start a stream or turn on the microphone.

## Listen and add the OBS scene

1. Open [the dock](https://localhost:4317/dock) in a normal browser tab. Choose **Resume listening** when paused, or **Start microphone** when listening is enabled but the microphone is off. Grant access to the intended microphone and check its level. Keep this capture tab open; use another tab for setup or public pages.
2. Keep one microphone producer active. If another dock owns the capture lease, use **Take over listening** deliberately. Pause stops the microphone and queued local audio immediately, then confirms the server pause. If confirmation fails, **Retry pause** resends that control without reopening the microphone; already uploaded speech may still finish until the server confirms. Forget is the separate action for material already received.
3. In a separate setup tab, select **Copy OBS overlay URL**. Add that complete private URL as a **1920 × 1080 Browser Source**. Keep it private: its fragment grants access to the published overlay scene. **Rotate link** invalidates previously issued overlay access and requires updating OBS.
4. Use **Preview** in the dock for a local preview. Use **Show recap** to trigger the on-stream destination. If you enable narration or scene sounds, enable OBS audio control for that Browser Source and verify its mixer routing.
5. Optionally add `https://localhost:4317/dock` through OBS **Docks → Custom Browser Docks**. Use the regular browser tab for microphone capture when the embedded browser cannot grant access. Do not assume an OBS Browser Source can provide microphone permission.

The dock hotkey works while the dock has focus. It is not a system-wide hotkey. The microphone path captures the selected audio input; it does not record the desktop or reconstruct video from an arbitrary missed interval. Use OBS for your own screen recording.

An early raid can use an approved previous-stream clip. Setup samples the channel's recent clips and offers **Preview previous clip** and **Use previous clip**. Without an available permitted clip, the welcome still works without video. The clip is labelled as belonging to a previous stream.

## Enable new speech and story processing

Add `OPENAI_API_KEY` and explicitly set `OPENAI_PAID_CALLS_ENABLED=true` only when you intend to run paid requests. Restart after environment changes. A key alone does not enable requests. Keep the switch `false` for replay or account preparation. A rejected key (401), missing model access (403/404), or an account without credit (429 `insufficient_quota`) is printed once in the server terminal with the fix; the app itself keeps new material held.

The default persistent dispatch ceiling is $4.50. Reservations and usage survive restarts; an ambiguous request is not treated as free. Model identifiers and optional narration are described in [configuration](configuration.md). Account access, actual transcription quality, mixed-language behavior, and broadcast audio routing require a short test with the intended devices and account.

Before relying on a live setup, verify one short microphone segment, a second account's chat command, an incoming raid, a real permitted clip, and one owner edit or Forget. A Twitch CLI mock checks transport behavior but does not prove production raid delivery. The [backend evidence](../testing/live-engine.md) describes what authored integration tests establish.

## Clips, public sharing, and recording

**Save moment** creates a moment even with quiet chat. Video availability is separate from that saved marker. Automatic clip creation requires its own enabled setting and Twitch permission; Twitch may create the clip before Previously's privacy hold ends. A processing or unavailable clip is never presented as a ready video. Use the [Twitch clip manager](https://dashboard.twitch.tv/content/clips) to remove an external clip after Forget when necessary.

Clip download URLs are temporary. The local cache validates the authorized media before making it available to the overlay. A whole-stream VOD is not reconstructed from microphone input, and this app does not promise that every chapter has an available VOD jump or historical clip.

When `TWITCH_MARKERS_ENABLED=true`, newly saved eligible moments can request Twitch stream markers independently of automatic clip creation. [Twitch requires a live broadcast, enabled VOD storage, and the additional authorization scope](https://dev.twitch.tv/docs/api/reference/#create-stream-marker). Requests expire after 60 seconds so a delayed job cannot mark a different live moment. Only a returned marker ID and position confirm success; ambiguous attempts are not blindly retried. An unavailable marker leaves the moment's local timecode intact. The authenticated `GET /api/owner/twitch/markers?sessionId=...` endpoint reports per-moment marker state. Verify the marker path with the intended channel before relying on VOD navigation; fixture coverage does not establish real marker availability.

For public sharing, configure the [Vercel publication service](publication.md), then open the public link shown in setup. A locally saved edit is not a cloud acknowledgement. Keep the collector running during a live session so the public visibility lease can renew.

For a replay of your own material, select **Recordings** in the dock header, then **Arm next recording** before context is collected. The header keeps the armed or active status and **Stop recording** available after you close the sheet. After stopping, use **Review contents** to inspect the metadata, source wording, saved fields, and any selected cached media. **Approve reviewed contents** and **Create private export** keep it local. **Publish recording** uploads it separately; **Download offline ZIP** creates a private copy that cannot be recalled. **Withdraw recording** closes local access and reports any public withdrawal still awaiting acknowledgement.

Read [Replay and recordings](../replay/README.md#record-review-and-share-in-the-dock) for source checks, owner review, and deterministic replay requirements. A safe single-language session can export without a raid or an edit. An interrupted or incomplete recording cannot be exported. The bundled authored example is not copied into a channel's live history, and the recorder does not automatically import an OBS screen recording.

## Restart and troubleshoot

Use **Ctrl+C** for a normal shutdown and rebuild after code changes before running `npm start` again. [Recovery and troubleshooting](../troubleshooting.md) lists every known symptom with what to check, along with storage, backup and media cache behavior.
