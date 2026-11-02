# Previously submission film: idea, moves, beat sheet

Length 2:28 (148 s), 1920×1080, 60 fps, English, YouTube. Music grid 120 BPM: one beat 0.5 s, one bar 2 s, 74 bars. Key D minor, ending on D major.

## Idea

The film is itself a "Previously on" recap. Every passage is made of the objects the product makes from a stream (title cards with timecode tabs, clip frames, chat slips, the lore plate, the now card), and the vermilion rewind tile of the logo is the button that rewinds us into each passage.

## Signature moves

1. **The rewind press.** A vermilion plate squashes into the rewind tile (the P mark), the tile pops under a press with ripples in its own rounded outline, and the picture rewinds: footage scrubs backward with horizontal tape streaks, timecodes roll backward, past title cards whip across. Used four times: the hook (into the raid scene), the engine passage (back to 0:05), the Codex passage (rewinding the build), the ending (the tile docks as the logo). Twist on the last one: the press plays forward.
2. **The plate becomes the stage.** A highlight plate behind a word grows and becomes the next object: "stream" becomes the player, "miss?" becomes the rewind tile, "moon jump" becomes the lore plate, "fixed" becomes the commit ribbon. The plate colour changes the field (paper, vermilion, ink).
3. **Timecode tabs as the anchor.** Every card has a timecode tab cut into its top edge; done cards compress into small tabs on one timeline strip that lives at the bottom of the frame through the middle of the film and keeps the viewer oriented while worlds change above it.

Material: matte cards with a darker underside plane, light from the upper left, soft contact shadows. Type: Onest 800 display, tight tracking, tabular figures for every time and count. Colour: ink stage `#14171B`, paper `#F4EFE6`, vermilion `#FF5A36` for the present and the press, lime `#C8F560` only for chat energy. No purple, no glow, no Twitch logo or UI: the stream sits in a neutral rounded player of our own.

Sound world: tape and felt. Rewind chirps and tape stops, felt thumps under plates, paper flicks for cards, a shutter latch for clip frames, granular chatter for chat, ceramic taps for the lore plate, soft plucks and a warm electric piano in D minor. The raid scene keeps its own synthesized SFX from the product (`window.__renderSfx`), mixed under the score.

## Truth rules for this film

- All product footage is the real app (`/replay`, `/c/foxlight_dev`, the replay demo dock, the overlay lab with the Foxlight plan) replaying the example recording. Said once, plainly, at 0:24: the game footage is ours, the speech, chat and raid in it are written as an example, and streamers run it with their own Twitch app and OpenAI key (said again at the end).
- Numbers only from evidence. Codex numbers come from `tools/codex-facts.json` (mined from the Codex session transcript and its 27 worker sessions with `tools/mine-codex.py`), test counts from `docs/testing/functional/*.md`, load numbers from the submission journal.
- The visual redesign and this film were made with Claude agents. The Codex passage credits Codex only for what the transcript shows: research, architecture, the engine, the integration, tests and reproduced bugs.
- The owner wrote to Codex in Russian. Her quotes on screen are marked as translated.

## Beat sheet

Times are film seconds. "Scene t" is the raid scene's own clock in the overlay lab.

### 1. Hook: the raid and the rewind (0.0–6.0, bars 1–3), built in the first passage

| bar | time | on screen / action | out | sound |
| --- | --- | --- | --- | --- |
| 1 | 0.00–0.50 | Ink stage, warm light low left. "A raid" lands huge (230 px): "A" small, "raid" arrives as an outline and fills a beat later | camera rides left | filtered pluck stab, felt thump |
| 1 | 0.50–1.00 | "drops you into" lands word by word, paper colour | rides left | two soft thumps, pitch varied |
| 1 | 1.00–1.50 | "someone else's" in muted ink grey | rides left | thump |
| 1 | 1.50–2.00 | "stream" lands and a paper plate grows behind it, the word inverts to ink | plate keeps growing | plate slap, pluck motif note |
| 2 | 2.00–2.60 | Fill-through morph: the plate becomes the stream player (rounded frame), the footage opens inside it through the plate's shape; the other words whip out left with blur | player settles with overshoot | stretchy morph swipe |
| 2 | 2.60–4.00 | The player is alive: Foxlight footage, title bar "Foxlight Dev  Building a tiny cave platformer", a live timecode ticking 7:10, 7:11. "What" lands over the player's top left corner (outline then fill), "did I", then "miss?" on a vermilion plate with a spring | camera pushes slowly | thumps, pluck stabs, plate pop |
| 3 | 4.00–4.50 | The "miss?" plate squashes into a square, the word slides out, the P glyph scales in: it is the rewind tile | tile pops | rubbery morph, small tick |
| 3 | 4.50 | The tile is pressed: squash to 0.92, two outline ripples in its own shape | rewind starts | deep click with body + tape stop |
| 3 | 4.50–5.75 | REWIND: footage scrubs backward fast with tape streaks; the player timecode rolls 7:11 back to 0:05; the four chapter cards whip left to right with their tabs (5:20 Lanterns light the cave, 3:30 Spring gets a speed limit, 1:40 The moon jump, 0:05 Fox learns to jump) and real clip frames inside | tape slows down | reverse-tape chatter rising, one whoosh per card panned with travel, riser |
| 3 | 5.75–6.00 | Tape decelerates and lands; the tile shrinks into the timecode | hard landing on the downbeat | tape-stop wind-down, breath of silence |

### 2. The raid scene (6.0–18.0, bars 4–9), built in the first passage

| bar | time | on screen / action | out | sound |
| --- | --- | --- | --- | --- |
| 4 | 6.00–7.20 | Scene t 0: "Welcome, pixelmoth raiders" lands inside the player while the player zooms through until it fills the frame (the chrome passes beyond the edges) | full frame | drums and sub bass enter (first drop, filtered), scene SFX on top |
| 4–8 | 7.20–16.80 | The real raid scene at full frame: Previously on Foxlight Dev, chapter cards opening into clips, the chat burst counting to 45 messages in 10 seconds, the moon jump plate, Right now. A paper caption in the clear upper right changes in place: "This is what 37 raiders see", "made from the stream so far", "then it gets out of the way" | caption rolls out | groove under the scene, music ducked under its SFX |
| 9 | 16.80–18.00 | Scene t 10.8–12: the now card contracts into the P mark at lower left, "Type !previously in chat" | mark is caught | drum fill into bar 10 |

### 3. Brand (18.0–24.0, bars 10–12), built in the first passage

| bar | time | on screen / action | out | sound |
| --- | --- | --- | --- | --- |
| 10 | 17.30–19.50 | The P mark is caught (clone matched to its real position) and flies an arc to the centre with a trail of its stacked underside planes while the stream behind blurs and sinks into ink | tile docks left of centre | whoosh with Doppler glide, riser |
| 11 | 20.00 | Hit: the tile lands with a small camera punch; "Previously" letters settle in a wave from the tile's edge | wordmark holds | logo impact (sub, punch, shimmer), full groove opens |
| 11–12 | 20.50–24.00 | "Catch up with the stream" lands under it; "while it keeps going" follows and a vermilion stroke draws itself under "keeps going" and keeps running off the right edge | the stroke pulls the next scene in | pops per word group, motif in full |

### 4. Honest frame (24.0–30.0, bars 13–15)

The stroke from "keeps going" becomes the bottom edge of the player again. The player now shows the example recording from its start (`stream-full.mp4`). A paper plate folds open beside it: "The app you are about to see is real. It is replaying an example recording: the game footage is ours, and the speech, chat and raid in it are written as an example." The words light in reading order, then the plate folds into a small "Example recording" tab that stays on the player's title bar for the rest of the film. Sound: filter dip, paper fold, groove continues.

### 5. Listening (30.0–48.0, bars 16–24)

- 30–34: the player shrinks left; real speech lines from the example recording type as subtitle slips under it with a caret ("Today I am building a tiny cave platformer…"), chat slips trickle in from the right. Kinetic line above: "It listens to the stream" / "and reads chat".
- 34–40: slips are pulled together into a paper title card; its timecode tab "0:05" is cut in with a stamp; the title "Fox learns to jump" types in place. The card drops into a "held" tray and a ring counts 75 seconds (shown sped up, labelled "held for 75 seconds before anyone sees it"). At zero the card lifts out with a stamp and slides into the timeline strip at the bottom: the strip becomes the anchor.
- 40–48: second rewind press, forward this time: the strip scrubs to 1:40, the clip frame opens (shutter latch), clip-moon plays: the fox shoots through the ceiling. Sound: typing keys varied, chat blips, stamp, ring ticks rising in pitch, shutter, tape forward chirp.

### 6. The moon jump (48.0–62.0, bars 25–31)

- 48–53: chat bursts out of the clip frame's edge as lime-edged slips (the real 14 moment messages), a counter plate rolls to "45 messages in 10 seconds". Granular chatter swells, hats go to 16ths.
- 53–56: the slips collapse into one vermilion plate: "moon jump", stamped "since 2:05", with its one-line explanation underneath. Ceramic tap pair.
- 56–62: the plate shrinks into a tab on the strip; 3:30 "Spring gets a speed limit" and 5:20 "Lanterns light the cave" whip in as cards, each opening into its clip for a beat. The strip now holds four tabs and the lore tab. Kinetic line: "Chapters, clips, chat moments and the running joke". Sound: card flicks, shutter latches, music fill.

### 7. Three ways in for a late arrival (62.0–84.0, bars 32–42), highest energy

Persistent anchor: the now card "Making the lantern behind the waterfall reachable" stays centred while three worlds swap behind it on the beat.

- 62–69: a neutral chat panel (our own, no Twitch styling): a viewer types `!previously`, the answer arrives with the real `composeReply` text (last two chapter summaries plus the now statement).
- 69–76: the public recap page `/c/foxlight_dev` captured from the app: arrives tilted from below, flies upright, the camera travels down its chapters, one chapter is extracted and its clip opens.
- 76–84: the OBS raid scene in a small Browser Source frame, "Previously on" plate flashes, then the three planes line up side by side in depth showing they come from one story. Kinetic line changes word by word: "In chat" / "on a page" / "on a raid".

### 8. The streamer stays in charge (84.0–108.0, bars 43–54), the quiet contrast

Music drops to half time, drums out, felt keys and a pad. Real replay demo dock.

- 84–94: cursor presses "Apply correction" (button pops); chapter 3 "Spring gets a speed limit" swaps in place to "Moon jump becomes a cheat code". The three planes (chat answer, recap page, scene card) float in depth and the same wording ripples through each one. Line: "Correct a chapter once and every place shows the new wording"
- 94–100: "Pause listening" toggles; the speech slips stop at a dashed gap.
- 100–108: one beat of silence, then "Forget last 2 min" is pressed: a vermilion sweep crosses the timeline strip, the affected slips and their dependent card, clip and lore tab are pulled out of all three planes at once. Line: "Forget removes it from everything built on it" Sound: silence, then a deep press and a sweep.

### 9. Built in one Codex session (108.0–132.0, bars 55–66)

Energy rises with a 16th-note arpeggio. Kinetic data, rendered in the film's own style (no terminal screenshots), all from `tools/codex-facts.json`:

- 108–113: "Built in one Codex session" / a session clock rolls to 9 h 34 min (2026-11-01 18:57 to 2026-11-02 04:31 UTC).
- 113–118: the session card splits into 27 worker tags that fan out in depth (real names: twitch_research, storage_build, story_domain, twitch_engine, providers_engine, publication_engine, owner_service, replay_experience, release_audit and others); counter rolls to 4,798 tool calls.
- 118–124: two real findings as quote cards, each struck and stamped fixed: "A saturated chat queue dropped a deletion that had already arrived" and "After a provider outage, chat pushed out recent speech and the story stopped". Owner's question (translated from Russian): "Is a test this long really needed?" answered by the stamp "Ended early: 280,780 chats over 3.80 virtual hours".
- 124–132: 29 commits ribbon, "609 tests across 67 files passed", "1,000 chat messages at 20 per second, no gaps". The ribbon rewinds into the tile (third rewind, reversed).

### 10. Try it and the mark (132.0–148.0, bars 67–74)

- 132–138: "Run it on your own channel" / "with your Twitch app and OpenAI key"; "or open the example replay without an account" with the URL plate `previously-seven.vercel.app/replay`.
- 138–142: the four timeline tabs gather into the tile (bookend of the hook), rising figure.
- 142: logo hit on the resolved D major chord; wordmark settles, tagline under it, URL. Hold to 148 with a slow sheen across the tile and a tiny drift.

## Transition kinds used

Fill-through (plate to player), shape morph (plate to tile, tile to logo, slips to plate), rewind (signature), zoom-through (player to full frame), brand-object travel (P mark to centre), self-drawing stroke into the next scene, persistent anchor (now card, timeline strip), reverse extraction and planes split (the three outputs), beat cuts in the montage, type wall in the Codex passage. No fades as a main move.

## Energy curve

Hook max (0–6), groove under the scene (6–18), first full drop on the logo (20), working groove (24–62), peak montage (62–84), quiet contrast with one beat of silence (84–108), machine build (108–132), rising ending and resolved hit (132–148).
