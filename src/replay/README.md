# Isolated recorded replay

The browser worker and local `ReplayDriver` execute `src/core/reducer.ts`. Only input timing, provider outcomes and side-effect delivery change. No Twitch, OAuth, OpenAI or publication adapters are imported by the worker. `SimulationSink` records intent and cannot dispatch it. Each worker has a fresh scope; reset destroys its old state and creates another scope. Scope-independent provider lookup verifies the full canonical request as well as its key before remapping recorded references.

`fixtures/foxlight.ts` is the default authored example: a game development stream with speech, chat, a chat burst moment, lore, four clips of our own game and a raid. It contains no real streamer, chat participant or recorded model call. Its provider labels say `authored-no-model`. It is packaged on the server with its clips and served only through the existing manifest/revision gate, never imported by the public JavaScript bundle. `fixtures/authored-notes.ts` is the older one-chapter text example kept for tests.

The browser reads the latest manifest without cache, verifies the bundle SHA-256, and checks the manifest again before starting its worker. It polls every two seconds. Revocation or a changed revision terminates the worker and removes the page state; losing the six-second visibility lease does the same. `createLocalReplayHandler(dataDir)` uses a separate durable local export registry. Revoked exports remain revoked across restart. `buildAuthoredExport()` supplies signed-deployment asset bytes and manifest metadata; `bootstrapAuthoredReplay()` never replaces a channel's snapshots.

## Two-minute path

1. Open `/replay`, read the authored label, and select **Play recording**. Speech at 0:01 becomes a checked draft. The production 75-second hold ends at 1:16. Select 4× to observe the same hold faster, or **Jump to raid** to execute the prefix immediately.
2. The raid at 1:22 plays the production scene plan. Pause freezes virtual playback. Open the source disclosure to compare speech with the published claim.
3. Select **Apply correction**, then **Preview next recap**. Switch English/Русский to use recorded checked wording.
4. Open **demo dock** and type an unrelated edit. It is saved as held with “This recording has no safety check for this edit”. Delete, pause and forget affect only this sandbox. Restart restores the original recording in a new run.

`LocalReplayRecorder` is an opt-in private capture component for the real-stream stage. Its event/provider methods receive normalized domain values, reject credentials, and conservatively destroy the whole in-progress capture after privacy deletion. Export requires explicit owner/content/moderation review and visual review of every media asset. Screen media with visible secrets must be excluded entirely. Changed sanitized requests cannot reuse an old recorded outcome. The component is not yet wired to a real owner's capture/export control; the authored example does not establish real-stream delivery.

An offline copy can be run with `new ReplayDriver(validatedBundle, uniqueRunId)` and `advanceTo(milliseconds)`, including in the local Node process. A downloaded copy cannot be remotely revoked. Keep real raw captures in private `.data/exports`, outside product Git, and download any approved own-stream bundle through its current manifest gate. Public replay requires network revalidation.

Tests in `tests/replay` cover distinct scopes/final hashes, hold boundaries, provider misses, owner edits, language, privacy before raid, no live fetch, gate expiry, revoked old URLs and durable local revocation. They are functional evidence; they do not establish screen appearance, real media playback, model quality or human comprehension.
