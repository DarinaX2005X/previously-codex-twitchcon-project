# Run Previously on the streaming computer

The supported certificate setup path is Windows with Node.js 22.13 or newer and npm. A modern desktop browser supplies microphone permission and the AudioWorklet capture path. OBS is needed to put the recap scene on stream. FFmpeg and FFprobe must be on `PATH` for downloaded clip validation and prepared audio; the authored text-only replay does not need them.

## Install and try replay

Download or clone the [repository](https://github.com/DarinaX2005X/previously-codex-twitchcon-project), then open the directory containing `package.json` in PowerShell.

```powershell
npm ci
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
npm run setup:local
npm run build
npm run replay
```

Open [https://localhost:4317/replay](https://localhost:4317/replay). Choose **Play recording** or **Jump to raid**. The example is authored, text-only, and isolated from Twitch. It needs no provider accounts. New arbitrary wording stays held unless the recording contains the exact checked result.

The certificate script creates an exportable localhost certificate in the Windows CurrentUser store, writes its PFX into `.data/tls`, and asks Windows to trust that certificate for the current user. It generates missing session, encryption, publication, and certificate secrets without replacing nonempty values. Answer the Windows certificate prompt when it appears. Do not disable certificate validation to work around a failed setup.

Normal startup uses the fixed origin `https://localhost:4317` and loopback binding. Keep this origin and the Twitch callback unchanged. The server's `/health` returns `{ "alive": true }`; `/ready` reports storage and process readiness. In keyless replay, `configuration: "incomplete"` is expected because live credentials are absent.

After certificate setup and a build, a separate smoke check can run without stopping an existing collector:

```powershell
npx tsx docs/setup/verify-keyless.mts
```

It reuses only the localhost certificate, creates a fresh temporary database, starts an ephemeral listener through the programmatic runtime API, and blocks external fetches. It checks HTTPS, readiness, replay manifest integrity, the first published chapter, and a raid plan. It does not change the configured production port or grant provider access.

## Connect the channel

Create an application in the [Twitch developer console](https://dev.twitch.tv/console/apps). Register this exact OAuth redirect URL:

```text
https://localhost:4317/auth/twitch/callback
```

Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `TWITCH_CHANNEL_LOGIN` in the local `.env`. The login is the broadcaster's account name without `@` or a URL. See the [configuration reference](configuration.md) before enabling other services.

Stop the replay process with **Ctrl+C**, then start the built app:

```powershell
npm start
```

Open [channel setup](https://localhost:4317/setup), select **Connect Twitch**, and sign in with the configured broadcaster account. OAuth tokens are obtained through that flow and encrypted in SQLite; do not paste tokens into `.env`. Reconnect if the account, token, or required permissions change.

The current authorization requests `user:read:chat`, `user:write:chat`, `clips:edit`, `channel:manage:clips`, `channel:moderate`, and `moderation:read`. These cover chat, clip operations, and moderation state. The runtime uses the broadcaster identity; a separately configured bot account is not part of this connection flow. The optional marker adapter uses `channel:manage:broadcast` only when enabled by its caller.

Start a real stream on Twitch and use **Check configuration** until the active session is available. Connecting the account does not itself start a stream or turn on the microphone.

## Listen and add the OBS scene

1. Open [the dock](https://localhost:4317/dock) in a normal browser tab. Choose **Start listening** and select the intended microphone in the browser permission dialog. Check the level before speaking private material.
2. Keep one microphone producer active. If another dock owns the capture lease, use **Take over microphone** deliberately. Pause stops the track and pending local uploads; Forget is the separate action for material already received.
3. In setup, select **Copy OBS overlay URL**. Add that complete private URL as a **1920 × 1080 Browser Source**. Keep it private: its fragment grants access to the published overlay scene. **Rotate link** invalidates previously issued overlay access and requires updating OBS.
4. Use **Preview recap** locally. Use **Show recap** in the dock to trigger the on-stream destination. If you enable narration or scene sounds, enable OBS audio control for that Browser Source and verify its mixer routing.
5. Optionally add `https://localhost:4317/dock` through OBS **Docks → Custom Browser Docks**. Use the regular browser tab for microphone capture when the embedded browser cannot grant access. Do not assume an OBS Browser Source can provide microphone permission.

The dock hotkey works while the dock has focus. It is not a system-wide hotkey. The microphone path captures the selected audio input; it does not record the desktop or reconstruct video from an arbitrary missed interval. Use OBS for your own screen recording.

An early raid can use an approved previous-stream clip. Setup samples the channel's recent clips and offers **Preview previous clip** and **Use previous clip**. Without an available permitted clip, the welcome still works without video. The clip is labelled as belonging to a previous stream.

## Enable new speech and story processing

Add `OPENAI_API_KEY` and explicitly set `OPENAI_PAID_CALLS_ENABLED=true` only when you intend to run paid requests. Restart after environment changes. A key alone does not enable requests. Keep the switch `false` for replay or account preparation.

The default persistent dispatch ceiling is $4.50. Reservations and usage survive restarts; an ambiguous request is not treated as free. Model identifiers and optional narration are described in [configuration](configuration.md). Account access, actual transcription quality, mixed-language behavior, and broadcast audio routing require a short test with the intended devices and account.

Before relying on a live setup, verify one short microphone segment, a second account's chat command, an incoming raid, a real permitted clip, and one owner edit or Forget. A Twitch CLI mock checks transport behavior but does not prove production raid delivery. The [backend evidence](../testing/live-engine.md) describes what authored integration tests establish.

## Clips, public sharing, and recording

**Save moment** creates a moment even with quiet chat. Video availability is separate from that saved marker. Automatic clip creation requires its own enabled setting and Twitch permission; Twitch may create the clip before Previously's privacy hold ends. A processing or unavailable clip is never presented as a ready video. Use the [Twitch clip manager](https://dashboard.twitch.tv/content/clips) to remove an external clip after Forget when necessary.

Clip download URLs are temporary. The local cache validates the authorized media before making it available to the overlay. A whole-stream VOD is not reconstructed from microphone input, and this app does not promise that every chapter has an available VOD jump or historical clip.

For public sharing, configure the [Vercel publication service](publication.md), then open the public link shown in setup. A locally saved edit is not a cloud acknowledgement. Keep the collector running during a live session so the public visibility lease can renew.

Read [Replay and recordings](../replay/README.md) before capturing or exporting your own material. A recording must be explicitly started and reviewed; the bundled authored example is not copied into a channel's live history.

## Restart and troubleshoot

Use **Ctrl+C** for a normal shutdown. Rebuild after code changes before running `npm start` again. During development, `npm run dev` watches the server and enables stale-lock recovery only when the recorded process is no longer running. It still serves the last built client. `npm run dev:ui` serves the UI development build on port 4318; it is not a replacement for the local HTTPS owner server.

| Symptom | What to check |
| --- | --- |
| Certificate warning or setup failure | Run `npm run setup:local` again, inspect the localhost certificate prompt, and keep the existing PFX passphrase. Use the exact `https://localhost:4317` origin. |
| Port or instance already in use | Reuse the existing collector or stop that process normally. Do not start another process against the same database. After a crash, `npm run dev` can recover a genuinely stale lock. |
| Microphone denied or missing | Check browser site permissions and Windows microphone access. Choose the correct device in a normal browser tab, or select **Continue with chat only**. |
| No active session | Start the Twitch stream and check configuration. Signing in alone does not create a live session. |
| Twitch reconnect required | Reconnect the configured broadcaster through setup. Check that the registered callback matches exactly and required scopes are granted. |
| New text stays held | Check the safety/provider status and paid-call setting. Unavailable or ambiguous checks do not publish. In authored replay, only stored checked wording can pass. |
| Clip pending or unavailable | Check Twitch clip permissions, FFmpeg/FFprobe availability, and the official clip link. A saved moment does not guarantee a playable clip. |
| Public recap unavailable after disconnect | Restore the local collector and cloud connection. Live content is deliberately hidden when its lease expires. |
| Public edit still pending | Keep the local process running and check public origin, matching publication secret, and private-store availability. Do not mistake local save for cloud sync. |
| Storage full | Stop new capture, free unrelated disk space, and restart. Keep the SQLite database, encryption key, and privacy tombstones. Do not delete protected media or the database as a routine cache reset. |

The media cache evicts eligible old files within its configured bounds, while active playback remains protected. Privacy revocation overrides that protection. Already downloaded media and copies made outside Previously cannot be remotely erased.
