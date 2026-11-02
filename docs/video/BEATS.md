# Previously submission film: idea, moves, beat sheet

Length 2:18 (138 s), 1920×1080, 60 fps, English, YouTube. Music grid 120 BPM: one beat 0.5 s, one bar 2 s, 69 bars. Key D minor, ending on D major.

## Idea

The film is itself a "Previously on" recap. Every passage is made of the objects the product makes from a stream (title cards with timecode tabs, clip frames, chat slips, the lore plate, the now card), and the vermilion rewind tile of the logo is the button that rewinds us into each passage.

## Signature moves

1. **The rewind press.** A vermilion plate squashes into the rewind tile (the P mark), the tile pops under a press with ripples in its own rounded outline, and the picture rewinds: footage scrubs backward with horizontal tape streaks, timecodes roll backward, past title cards whip across. Used four times: the hook (into the raid scene), the engine passage (back to 0:05), the Codex passage (rewinding the build), the ending (the tile docks as the logo). Twist on the last one: the press plays forward.
2. **The plate becomes the stage.** A highlight plate behind a word grows and becomes the next object: "stream" becomes the player, "miss?" becomes the rewind tile, "moon jump" becomes the lore plate, "fixed" becomes the commit ribbon. The plate colour changes the field (paper, vermilion, ink).
3. **Timecode tabs as the anchor.** Every card has a timecode tab cut into its top edge; done cards compress into small tabs on one timeline strip that lives at the bottom of the frame through the middle of the film and keeps the viewer oriented while worlds change above it.

Material: matte cards with a darker underside plane, light from the upper left, soft contact shadows. Type: Onest 800 display, tight tracking, tabular figures for every time and count. Colour: ink stage `#14171B`, paper `#F4EFE6`, vermilion `#FF5A36` for the present and the press, lime `#C8F560` only for chat energy. No purple, no glow, no Twitch logo or UI: the stream sits in a neutral rounded player of our own.

Sound world: tape and felt. Rewind chirps and tape stops, felt thumps under plates, paper flicks for cards, a shutter latch for clip frames, granular chatter for chat, ceramic taps for the lore plate, soft plucks and a warm electric piano in D minor. The raid scene keeps its own synthesized SFX from the product (`window.__renderSfx`), mixed under the score.

## Truth rules for this film

- All product footage is the real app (`/replay`, `/example`, the replay demo dock, the overlay lab with the Foxlight plan) replaying the example recording. Said once, plainly, at 0:24: the game footage is ours, the speech, chat and raid in it are written as an example, and streamers run it with their own Twitch app and OpenAI key (said again at the end).
- Numbers only from evidence. Codex numbers come from `tools/codex-facts.json` (mined from the Codex session transcript and its 27 worker sessions with `tools/mine-codex.py`), test counts from `docs/testing/functional/*.md`, load numbers from the submission journal.
- The visual redesign and this film were made with Claude agents. The Codex passage credits Codex only for what the transcript shows: research, architecture, the engine, the integration, tests and reproduced bugs.
- The owner wrote to Codex in Russian. Her quotes on screen are marked as translated.

## Beat sheet

Times are film seconds. "Scene t" is the raid scene's own clock in the overlay lab.

### 1. Hook: the raid and the rewind (0.0–6.0, bars 1–3), built in the first passage

| bar | time | on screen / action | out | sound |
| --- | --- | --- | --- | --- |
| 1 | 0.00–0.50 | Ink stage, warm light low left. "A raid" lands huge (230 px): "A" small, "raid" arrives as an outline and fills a beat later | camera rides left | filtered pluck stab, felt thump |
| 1 | 0.50–1.00 | "drops" falls into the line from above with a spring, "you" lands in vermilion, "into" in paper; the camera rides the line continuously | rides left | three soft thumps, pitch varied, pluck stabs in D minor |
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

### 3. Brand (17.3–24.0, bars 9–12), built

| bar | time | on screen / action | out | sound |
| --- | --- | --- | --- | --- |
| 9–10 | 17.30–20.00 | The P mark is caught (clone matched to its real position in the scene) and flies past the camera in depth, growing to twice its final size with a trail of echo copies, accelerating into the hit; the stream behind blurs and keeps playing at low opacity | lands in the wordmark | long whoosh panned with the travel, riser |
| 11 | 20.00 | Hit: the tile lands with a camera punch; "Previously" letters wave out of the tile | the mark lifts away | logo impact, full groove opens |
| 11–12 | 20.55–22.90 | The mark rises and shrinks to the top; the tagline lands at 128 px in word groups: "Catch up" / "with the stream", then "while it" rises, "keeps going" pops in on a vermilion plate | the plate grows | thumps per group, plate pop |
| 12 | 22.95–24.00 | Fill-through: the "keeps going" plate grows until vermilion fills the frame | the next passage lives on it | riser into a plate slap |

### Drafts 6 to 8

- Transitions designed as moves: the 0:05 chapter card's clip lands on the same chapter's clip in the live recap page, which opens around it (59–60 s); the page recedes in depth behind the typed `!previously` (63–65 s); a cursor clicks the link in the bot's answer and the page opens out of it (67–68.5 s); the corrected chapter rides with the camera from the confirmation and lands on its card in the recap (89–91 s); a dark circle closes into the Codex passage (101.3–102 s).
- Words land on a small spring with a contact squash on emphasis; held pages and the chat panel drift slightly in 3D.
- Owner's edits: no personal quote from the owner; the long load run is shown as a fact (280,780 chat messages in 3.80 virtual hours); after the Codex numbers, "and polished in Claude Code" with the work products (Slides, README, Visuals, Landing, Video) leaving a code panel in 2.5D. Claude Code did the visual pass, this film and the README and gallery.
- The raid scene is the 44 s TV-style montage (take 8). The film shows an excerpt on the scene's own hard cuts (`SCENE_SEGS` in `film.js`: welcome and lockup, Fox learns to jump, The moon jump with the chat tags, Spring gets a speed limit, Right now, the P mark) and a shorter one inside the recap page's window at 74.5–79 s; the scene's sound is cut on the same segments (`--scene-segs` in `audio/mix.py`).

### Draft 5: the real app, live

The owner rejected UI shown as cropped screenshots inside window frames. From draft 5 the film embeds the running product pages live (`/example`, `/replay`, `/setup`) as iframes at real resolution and moves the camera through them; `tools/ui-live.cjs` puts the replay into each state with the real controls at the film time it is shown (Apply my wording at 87.2 s, the dock at 93.45 s, Pause listening at 94.9 s, Forget last 2 min at 97.8 s, Forget 2 minutes at 99.2 s), so the corrections, the paused state, the Forget dialog and its result are the product's own screens. The one component shown as an image is the whole chat panel with the bot's answer (the landing demo animates in real time and cannot be held still). The hook's first line plays slower (time remap in `film.js`) with lighter blur and a camera that leads each word and centres "stream". The Codex passage drops the rings; the workers fly through real 3D depth; counts roll on odometer digits.

### Rework after the owner's review (draft 4)

The owner judged draft 3 dense, dark, abrupt and full of small piles. Every reference sheet was studied again (notes in `review/video/REFERENCE-NOTES.md`). From 24 s on the film now follows these rules: one focal object per moment while the context dims; calm centred captions at 84 px that hold at least 1.5 s; a light paper field with soft vermilion and teal light (dark only for the hook and the Codex passage); field changes only through a shrink, zoom-through or growing circle; chat is always the real chat column with one lit row, never a pile.

### 4. Honest frame (24.0–30.0)

Vermilion field: "What you see next is the real app" / "replaying an example recording" at 100 px, and a paper note whose words light in reading order: "We made the game for this example. The speech, chat and raid in it are written as an example too." The vermilion field shrinks into the "Example recording" tag on the player's title bar, revealing the light field.

### 5. Listening and the first chapter (30.0–45.5)

Caption above an uninterrupted demo (Helio): "It listens to the streamer" (the real transcript types as a subtitle), "and reads the chat" (the player steps aside, the chat column slides in, newest row lit), "then writes a short chapter" (context blurs, the 0:05 card forms centred and types its title), "and waits 75 seconds before showing it" (the card's edge pulls out into a bar that empties, counted faster here, contracts into a dot, the dot into a check: Published, LangEase chain). The card drops into the timeline strip at the bottom.

### 6. The moon jump (45.5–60.0)

"Then the fox tries the spring" (clip-moon, transcript "Okay, let me try the spring."), "and chat reacts" (all 45 real messages scroll through the chat column with the newest lit, a lime counter rolls to 45), "Chat named it the moon jump" (the lit MOON JUMP row is lifted out of the chat and grows into the moon jump plate with its origin tab, Teamble extraction), "Every chapter keeps its sources" (the 0:05 card rises, turns edge-on and becomes the four chapters, LangEase ensemble, then they file into the strip).

### 7. Three ways in (60.0–82.0)

"A viewer arrives at 7:10" (the real Right now card at reading size), "and types !previously in chat" (a capsule grows with the typed command, iBanPay; then the real chat answer, the camera travels down it and a ring draws around the reply), "or opens the recap page" (the real page rises from below in perspective, the camera travels down it, the moon jump chapter is lifted out and its clip plays), "A raid gets it on stream" (the page shrinks into a rounded window that becomes the stage of the real raid scene, Helio morphing window), "One story feeds all three" (chat, page and scene stand in a row, linked by vermilion lines to the now card).

### 8. The streamer stays in charge (82.0–102.0), the quiet contrast

The real dock rises from below in perspective and straightens. "Correct a chapter once": the real Change the recap panel, camera pushes onto the cards, Apply my wording is pressed, the camera moves to the product's confirmation. "and every place uses the new wording": the dock card zooms and is swept to "Moon jump becomes a cheat code". "Pause listening at any time": the real button is lifted out, pressed, turns to Resume listening. "or forget the last two minutes": a beat of silence, the Forget button is lifted out and pressed, the real dialog opens, "Forget 2 minutes" is pressed, the dock is swept to its real state after Forget. Zoom through the dark dock into the Codex passage.

### 9. Built in one Codex session (102.0–126.0)

Dark field with a soft vermilion glow, one fact at a time: "Built in one Codex session"; the session length rolls to 9 h 34 min inside rings (18:57 to 04:31 UTC); "27 parallel workers" with the real worker names on a horizontal wheel, centre lit (NeuralSeek); 4,798 tool calls; two large bug cards stamped fixed; the owner's question, translated from Russian, with the lime answer; tests roll from 609 (when the session ended) to 656 (today, across 73 files). A light circle grows from the number.

### 10. Try it and the mark (126.0–138.0)

"Run it on your own channel" over the real setup page arriving in perspective, "with your Twitch app and OpenAI key" as the camera moves through its steps, "or try the example replay" over the real replay page with the URL plate. The four timecodes spiral into the tile on the hit at 134 s, the wordmark wipes out, tagline and URL pill; light hold to 138 s.

## Transition kinds used

Fill-through (plate to player), shape morph (plate to tile, tile to logo, slips to plate), rewind (signature), zoom-through (player to full frame), brand-object travel (P mark to centre), self-drawing stroke into the next scene, persistent anchor (now card, timeline strip), reverse extraction and planes split (the three outputs), beat cuts in the montage, type wall in the Codex passage. No fades as a main move.

## Energy curve

Hook max (0–6), groove under the scene (6–18), first full drop on the logo (20), working groove (24–62), peak montage (62–84), quiet contrast with one beat of silence (84–108), machine build (108–132), rising ending and resolved hit (132–148).
