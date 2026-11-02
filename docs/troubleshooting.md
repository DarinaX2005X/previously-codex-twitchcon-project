# Recovery and troubleshooting

This page collects what to check when the local collector, Twitch, OpenAI, OBS or the public page does not behave as expected. Setup steps are in [local setup](setup/local.md), every environment variable is in [configuration](setup/configuration.md), and recording limits are in [recordings](recordings.md).

## Stopping, restarting and rebuilding

Use **Ctrl+C** for a normal shutdown. Rebuild after code changes before running `npm start` again. During development, `npm run dev` watches the server and can recover a process lock only when the recorded process is no longer running. It still serves the last built client. `npm run dev:ui` serves the UI development build on port 4318; it does not replace the local HTTPS owner server.

SQLite migrations run at startup. `/health` returns `{ "alive": true }` and `/ready` reports storage and process readiness. In keyless replay, `configuration: "incomplete"` is expected because live credentials are absent.

## What is stored and how to back it up

`DATA_DIR/previously.sqlite` keeps sessions, evidence, history, settings, encrypted authorization, durable work, privacy fences, publication sequences and budget records. Private captures live in `DATA_DIR/exports/private-recordings` and reviewed assets in `DATA_DIR/exports/reviewed-recordings`. None of these belongs in a public or static directory.

Back up the database together with its matching `TOKEN_ENCRYPTION_KEY` while the process is stopped. Treat the backup as private stream material. A backup made before a Forget action can still contain the material you meant to remove, so reconcile it with the current privacy state before you reuse, publish or export anything from it.

## Symptoms and what to do

| Symptom | What to check and do |
| --- | --- |
| Certificate warning or setup failure | Run `npm run setup:local` again, answer the current-user certificate prompt and use the exact origin `https://localhost:4317`. Keep the matching PFX and passphrase. Do not disable certificate checks. |
| Port or database already in use | Reuse the running collector or stop it normally. Do not start a second process against the same database. After a crash, `npm run dev` can recover a lock whose process is gone. |
| The terminal prints an `[previously] OpenAI ...` line | 401 means the key was rejected. 403 or 404 means the project cannot use one of the models (`gpt-transcribe`, `gpt-6-luna`, `omni-moderation-latest`, and `gpt-realtime-2.1-mini` for narration). 429 `insufficient_quota` means the project has no credit. Fix the key or project and restart. The dock shows the same problem with a recovery step. |
| New wording stays held | Check `OPENAI_PAID_CALLS_ENABLED=true`, model access, credit and the safety status in the dock. Existing safe context stays public unless an edit or a privacy action withdrew it. In replay, only wording with a recorded checked outcome can pass. |
| The $4.50 ceiling is reached | New material stays held and the terminal prints one line. The ceiling is stored in the database and survives restarts. Do not delete the database to reset it, because it also holds authorization, private history and privacy fences. |
| Microphone denied or missing | Check browser site permissions and Windows microphone access, choose the device in a normal browser tab and use **Resume listening** or **Retry microphone**. **Continue with chat only** is available when no input works. The OBS custom dock may not be able to grant microphone access; use a normal browser tab. |
| Microphone stopped but the server pause is unconfirmed | Choose **Retry pause**. The device stays stopped while the app retries, and a failed retry does not reopen capture. Speech that was already uploaded may still finish until the server confirms. Use Forget separately for material already accepted. |
| No active session | Start the Twitch broadcast and use **Check again** in setup. Signing in alone does not create a session. |
| Twitch reconnect required or wrong account | Reconnect through setup as the broadcaster named in `TWITCH_CHANNEL_LOGIN`. Check that the registered callback matches exactly and that the requested scopes were granted. |
| `!previously` answers without a link | `RECAP_PUBLIC_ORIGIN` is empty. Replies still carry the published recap text. Set it to your Vercel deployment to append the public page link. |
| A raid is refused or never arrives | The receiving channel must be live. Viewer thresholds, account age and permitted groups in the receiver's incoming raid settings can block a new test account; having the sender go live briefly is the simplest route. The Twitch CLI cannot send a production raid into the live EventSub session. |
| Clip pending or unavailable | Check Twitch clip permissions, FFmpeg and FFprobe on `PATH`, and the official clip link. A saved moment keeps its timecode without a playable clip. |
| Marker unavailable | Markers need `TWITCH_MARKERS_ENABLED=true`, a reconnect for `channel:manage:broadcast`, a live broadcast and VOD storage. Requests expire after 60 seconds. The saved moment keeps its local timecode. |
| OBS scene, layout or sound missing | Recheck the private overlay URL, the 1920 × 1080 Browser Source size, protected areas and scene length. **Preview** stays local. Enable OBS audio control for the Browser Source and check mixer routing for scene sound or narration. |
| Public recap disappears after a disconnect | Restore the local collector and the cloud connection. Live content is hidden on purpose when its 30-second lease expires. |
| A public edit stays pending | Keep the collector running and check `RECAP_PUBLIC_ORIGIN`, the matching `PUBLISH_SHARED_SECRET` and the private Blob store. A local save is not a cloud acknowledgement. |
| A recording cannot start or export | Arm the recording before the session collects context. Open **Review contents** for missing checks or events. An interrupted, capacity-failed, changed-source or incomplete capture needs a new clean recording; copying review hashes cannot repair it. |
| Selected recording media cannot prepare | Check FFmpeg, FFprobe, the 120-second duration bound and `h264_nvenc` for video that needs conversion. The asset stays unselected on failure. A text-only export can leave out optional media. |
| Offline ZIP too large | The ZIP has its own 32,000,000-byte bound, including metadata and archive overhead. Select fewer optional media before creating the export; an existing export cannot be edited in place. |
| Withdrawal still pending | Keep the collector running and use **Retry withdrawal** if it is shown. Remove the private capture only after the dock allows it; do not delete files to skip the pending acknowledgement. |
| Disk full | Stop new capture, free unrelated space and restart. Keep the SQLite database, the encryption key, publication state and privacy tombstones. Do not delete protected media or the database as a cache reset. |

## Media cache

The media cache holds up to 512 MB or 12 files, and a single download is bounded at 80 MB. Eligible older files are evicted first, active playback is protected, and a privacy revocation always wins over that protection. A storage failure rejects the change instead of reporting it as saved. Media that was already downloaded or copied outside Previously cannot be erased remotely.
