# Record, review and share a stream

Previously can keep a private recording of your own stream so you can replay it later, download it, or publish it as a replay on your viewer page. This page is the streamer's guide. The bundle format, owner API and offline helpers are in the [replay reference](replay/README.md).

## What a recording contains

The recorder saves normalized stream context and the exact checked model outcomes, so a replay can run the same story rules later without an API key. It does not record your desktop and does not attach raw microphone audio. Keep your OBS screen and audio recordings outside Git, and review what they show and say before you share them.

## Steps in the dock

1. Before the session collects context, open **Recordings** and choose **Arm next recording**. **Start private recording** is offered only when the server confirms the current session has no earlier context. The dock header keeps the armed or recording state and **Stop recording** visible after you close the sheet.
2. Let a checked story build up and let at least one chapter publish. When you are done, choose **Pause listening**, confirm the pause, then **Stop recording**. You can end the Twitch broadcast and your OBS recording; keep the collector running if public sync or sharing is enabled, so acknowledgements can arrive. Export needs a complete stopped recording, unchanged safe sources, completed checks for the recorded text and a deterministic replay that reaches a published chapter. A raid, a correction, a second language and media are optional.
3. Open **Review contents**. Read the metadata, every source excerpt and every saved text field, paging through longer lists. You can select ready media from this recording's validated cache and watch or listen to its prepared bytes. Confirm both the visual and the audio check, because text moderation cannot see a secret on screen. Arbitrary local paths and uploads cannot be attached.
4. Choose **Approve reviewed contents**, then **Create private export**. A media change keeps earlier checks only for content that is exactly unchanged and always needs a fresh approval for the new revision. An exported package cannot be edited in place.
5. **Download offline ZIP** gives you `manifest.json`, an assembled `bundle.json` and the selected media, after you acknowledge that the copy cannot be recalled. It is a data and media package, not a standalone HTML player. The programmatic [`replayOffline`](../src/server/replay/offline.ts) helper can run the ZIP or a JSON bundle without provider calls.
6. **Publish recording** shares the export through your [own viewer page](setup/publication.md). It uploads the reviewed assets separately from the private export. Wait for **Open published recording**; only that export's own acknowledgement enables its public link. **Retry publication** appears if confirmation fails. A private export and an offline download do not need public hosting.
7. **Withdraw recording** closes local replay and download access immediately and, if the recording was shared, queues its public withdrawal. Keep the collector running until it is acknowledged, and use **Retry withdrawal** if needed. **Remove recording** becomes available after any required withdrawal acknowledgement. The stream's chapters stay in place, because withdrawal affects the export and not its original sources.

## Limits

These capacity limits decide what can be recorded and exported. They are not a promise that a stream of a given length will fit.

| Recording item | Limit |
| --- | --- |
| Retained private recordings | 20 |
| Private capture | 32,000,000 bytes, 10,000 events, 10,000 provider outcomes and 100 media candidates |
| Selected media | Up to 12 assets, each at most 3,000,000 bytes and 120 seconds |
| Public package | Up to 100 assets and 32,000,000 declared bytes including selected media |
| Offline ZIP | 32,000,000 bytes including the assembled JSON, manifest, media and archive overhead |

Larger cached video is prepared with `h264_nvenc`, and audio can be prepared as MP3. A failed conversion stays unselected. Reaching a capture limit fails the capture instead of silently dropping context. A process restart marks an active capture as interrupted; it cannot resume or export. A public replay offers only the raid, correction and language controls that the recording actually contains.

## Privacy and recordings

Forget during a recorded session invalidates the private capture and every export built on it, so a clean export then needs a new clean session. Already downloaded ZIP files, copied footage and screenshots, Git copies and other people's recordings cannot be recalled by Previously.
