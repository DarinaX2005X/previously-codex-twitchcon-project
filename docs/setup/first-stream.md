# Your first stream with Previously

A 20–40 minute stream of your own development work or conversation is one useful validation route. Speak naturally about what happens, including uncertainty and changes of plan. No scripted outcome, joke, game, or face camera is needed. For account-free practice, use the [authored replay](../replay/README.md#the-included-example).

## Prepare your Twitch channel and OBS

Sign in to your own Twitch account, or follow [Twitch's account creation guide](https://help.twitch.tv/s/article/creating-an-account-with-twitch). Complete your Creator Dashboard's broadcast setup and choose an accurate title and category. In OBS, select Twitch under **Settings → Stream** and connect your channel. Keep stream keys and login screens out of the capture.

Run **Tools → Auto-Configuration Wizard** in OBS. Add your intended source with the **+** control in Sources, select your microphone, and watch its Audio Mixer meter while speaking. Make a short local recording and play it back before broadcasting, checking readable text and audible speech. These steps follow the [OBS Quick Start Guide](https://obsproject.com/kb/quick-start-guide).

Use **Window Capture** for only the editor or application you intend to show. Other windows covering it are excluded, but private tabs, filenames, notifications, and credentials inside that application can still appear. Inspect the actual preview. See [OBS Window Capture](https://obsproject.com/kb/window-capture-sources).

Set OBS's recording destination outside this repository and use **NVIDIA NVENC H.264** for footage intended for handoff. Previously's separate context recording does not record your desktop or automatically import the OBS file.

## Open the live app and arm its recording first

Complete [local setup](local.md#connect-the-channel) and [configuration](configuration.md) for the callback and broadcaster login. Stop an authored replay process normally, then run the live app from the project directory:

```powershell
npm run build
npm start
```

Connect the intended broadcaster in [setup](https://localhost:4317/setup). New speech and story processing needs your OpenAI key and `OPENAI_PAID_CALLS_ENABLED=true`; enable that switch only for your intended paid live session, then restart. Keep it `false` during account preparation or keyless replay.

Before starting the Twitch stream or collecting context, open the [dock](https://localhost:4317/dock), select **Recordings → Arm next recording**, and confirm **Recording armed for the next session**. Arming cannot recover an already active session's beginning. Keep the app running throughout capture.

Copy the private OBS overlay URL from setup. Add it above your captured window as a **Browser Source**, width **1920**, height **1080**. For scene sound or narration, enable OBS audio control and test the mixer routing. See [OBS Browser Source](https://obsproject.com/kb/browser-source). Keep the capability URL private.

## Start the stream and let real context accumulate

Start the private OBS recording, then **Start Streaming**. Confirm your Twitch channel is live and use **Check configuration** in a separate setup tab until its session appears. Return to the dock and confirm **Recording privately**. Choose **Resume listening** when paused, or **Start microphone** if listening is enabled but the microphone is off, then grant microphone access. Keep this browser dock tab open while capturing; open public links in another tab. OBS carries your broadcast voice; Previously captures speech for transcription. Avoid duplicating your microphone through the overlay.

Wait for an actual checked chapter and its published state. The default hold is 75 seconds after its supporting source ends, plus processing and checks. Inspect held text or provider errors before continuing.

From a second Twitch account, send `!previously` in the receiving channel's chat and inspect the reply. With public publication configured, open its recap link in another tab. **Save moment** on a genuine moment; if clip creation is enabled and available, inspect the official clip separately from its saved timecode. Use **Preview**, then **Show recap**, in the dock to inspect the scene in OBS.

## Send a real raid from the second channel

Use a second channel you control, or a willing sender. Affiliate or Partner status is not required. In the **sender's own channel chat**, enter `/raid YOUR_RECEIVING_LOGIN`, then follow Twitch's countdown and **Raid Now** control. `!raid` or a message in the receiving channel does not initiate it. Confirm Twitch reports the incoming raid and observe Previously's scene and sound. See [Twitch's raid guide](https://help.twitch.tv/s/article/how-to-use-raids?language=en_US).

If Twitch rejects it, inspect the restriction notice and recipient's incoming raid settings. Viewer thresholds, sender account age, and permitted groups can exclude a fresh test account. Changing minimum or maximum viewer limits also prevents offline senders from raiding. Resolve the specific mismatch with an eligible sender and the recipient's intended safety settings. See [Twitch's incoming raid settings](https://help.twitch.tv/s/article/how-to-use-raids?language=en_US).

## Correct or forget deliberately

Make a truthful correction to a published chapter, wait for its checks and any required cloud acknowledgement, and confirm the next recap's wording. A second recap language is optional and requires its own checked presentation.

Use harmless material for a separate, disposable Forget trial. **Forget invalidates the current private capture and its dependent exports**, so a clean export needs a new clean session afterward. Pause stops new capture; Forget removes accepted sources. Delete external Twitch clips separately through the [clip manager](https://dashboard.twitch.tv/content/clips) when necessary.

## Stop, review, and share separately

Choose **Pause listening** and wait for confirmation. Use **Retry pause** if unconfirmed; the microphone stays stopped, but uploaded speech may still finish. **Stop recording** for Previously's capture, then end the broadcast and separate OBS recording. Keep the collector running for final publication work.

Open **Recordings → Review contents**. Read every metadata, source, and text field. Select optional eligible cached media, watch or listen to the prepared bytes, and complete visual and audio checks. A safe single-language recording can export without a raid or correction when deterministic replay reaches a published chapter.

**Approve reviewed contents** and **Create private export** keep the package local. **Download offline ZIP** makes a private copy that cannot be remotely recalled. **Publish recording** uploads separately; keep the collector running until **Open published recording** appears for that export. Withdrawal also needs its own public acknowledgement. See [Replay and recordings](../replay/README.md#record-review-and-share-in-the-dock) for those boundaries.
