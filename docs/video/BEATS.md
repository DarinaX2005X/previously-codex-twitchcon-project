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

### 4. Honest frame (24.0–30.0, bars 13–15)

On the vermilion field, ink type at 112 px: "What you see next is the real app" ("real app" on an ink plate), "replaying an example recording" (an ink line draws under "example recording"). A paper note opens and its words light in reading order: "We made the game for this example. The speech, chat and raid in it are written as an example too." The field then contracts into a rounded window that becomes the stream player, and the note folds into the "Example recording" tag on the player's title bar, where it stays. Sound: field drop, thumps, draw, paper flick, morph.

### 5. Listening (30.0–45.5, bars 16–22)

One headline slot above the player swaps phrases in place while the demo below never stops: "It listens to what the streamer says" / "and reads the chat" / "then writes a short chapter" / "and waits 75 seconds before showing it" / "Then the stream goes on". The real transcript types under the player (0:05 tab), three real early chat messages pop in on the right. Speech and chat fly into a paper title card that types "Fox learns to jump" with its 0:05 tab; a vermilion ring counts the 75 second hold down (labelled "counted faster here"); "Published" stamps; the card drops into the timeline strip at the bottom. The rewind tile appears at the end of the strip and is pressed, mirrored, as fast forward: the clock rolls to 1:40, the moon jump clip plays, the transcript types "Okay, let me try the spring." Sound: key presses varied, chat pops, whoosh, plate, rising ticks, stamp, deep click and a forward tape squeal.

### 6. The moon jump (45.5–56.0, bars 23–28)

"Chat reacts to the moon jump": the 14 real messages burst from the player as lime-edged slips while a lime counter rolls to 45 messages in 10 seconds. The slips collapse into the vermilion "moon jump" plate with its 2:05 origin tab and one-line explanation ("and the running joke keeps its origin"), which docks on the strip. "Every chapter points to its sources": the 3:30 and 5:20 cards whip in, open into their clips for a beat and file into the strip. Sound: granular chatter, whoosh, ceramic taps, card flicks, shutters, ticks.

### 7. Three ways in (56.0–80.0, bars 29–40), highest energy

The strip gathers into the real "Right now" card from the public page ("A viewer arrives at 7:10"), which parks lower left as the anchor while worlds swap behind it:
- "and types !previously in chat": the real chat answer (the product's `composeReply` output as rendered on the landing) arrives tilted, the camera pushes in and a vermilion ring draws around the answer.
- "or opens the recap page": the real `/c/foxlight_dev` page rises from below in perspective and the camera travels down its chapters; the moon jump chapter is extracted and its clip plays inside it.
- "A raid gets the same story on stream": the real raid scene again (live from the overlay lab, take 6) at near full frame with its own sound.
- "One published story feeds all three": chat, page and scene stand side by side in depth with the now card in front.

### 8. The streamer stays in charge (80.0–102.0, bars 41–51), the quiet contrast

Half time, drums out, felt keys and pad. The real streamer dock rises in from below. "Correct a chapter once": the dock steps back, the real "Change the recap" panel arrives at reading size, the camera pushes onto the two cards, the cursor presses "Apply my wording" and the panel shows the product's own confirmation. "and every place uses it": the dock comes forward, zoomed on the 3:30 card, and a vermilion sweep swaps it to "Moon jump becomes a cheat code". "Pause listening any time": the real button is lifted out of the dock, pressed, its label turns to "Resume listening" and a dashed gap draws. "Or forget the last two minutes": one beat of silence, the Forget button is lifted out and pressed, the real dialog "Forget 5:19 to 7:19?" opens, "Forget 2 minutes" is pressed, and a sweep swaps the dock to its real state after Forget, zoomed on its notice ("and what was made from them goes too").

### 9. Built in one Codex session (102.0–126.0, bars 52–63)

Kinetic data from `tools/codex-facts.json`: "Built in one Codex session" with the clock rolling from 18:57 to 04:31 UTC and a "9 h 34 min" plate; "27 parallel workers" with the real worker names fanning out in depth and a counter rolling to 4,798 tool calls; "It reproduced bugs before fixing them" with two paper cards stamped fixed (the full chat queue that dropped an arrived deletion; the provider outage after which chat pushed out recent speech); "and changed course when the owner asked" with her question, translated from Russian, "Is a test this long really needed?" and the lime answer "Codex ended the run early and recorded it as partial: 280,780 chats over 3.80 virtual hours"; "Tested on the way": 29 commits from the Codex session, 609 tests across 67 files when the session ended (656 pass today), 1,000 chat messages at 20 per second with no gaps. The numbers collapse into the centre on a tape stop.

### 10. Try it and the mark (125.7–138.0, bars 64–69)

"Run it on your own channel" / "with your Twitch app and OpenAI key" / "or try the example replay without an account" with the URL plate `previously-seven.vercel.app/replay`. The four chapter timecode tabs gather into the tile (bookend of the hook) on a riser; at 134.0 the logo hits on the resolved D major chord, the wordmark wipes out of the tile, tagline and URL settle, and the frame holds to 138 with a slow push and a sheen across the tile. Draft 3 staging: the mark is large (3.8×), the four chapter timecodes spiral into the tile on the hit, the tagline is at 80 px and the URL sits on a paper plate, over the stream playing blurred behind.

## Transition kinds used

Fill-through (plate to player), shape morph (plate to tile, tile to logo, slips to plate), rewind (signature), zoom-through (player to full frame), brand-object travel (P mark to centre), self-drawing stroke into the next scene, persistent anchor (now card, timeline strip), reverse extraction and planes split (the three outputs), beat cuts in the montage, type wall in the Codex passage. No fades as a main move.

## Energy curve

Hook max (0–6), groove under the scene (6–18), first full drop on the logo (20), working groove (24–62), peak montage (62–84), quiet contrast with one beat of silence (84–108), machine build (108–132), rising ending and resolved hit (132–148).
