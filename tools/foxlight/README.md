# Foxlight

A tiny original cave platformer used as the example recording's gameplay footage. A fox carries a lantern through a cave, bounces on a spring pad and lights the cave by collecting floating lanterns. Everything is drawn in code on a 1280x720 canvas; there are no image or sound assets.

Open `index.html` in a browser to play: arrows or A/D to run, Space or W to jump, B toggles the moon jump bug.

Query flags:

- `?bug=moon` removes the spring speed cap, so the spring launches the fox through the ceiling and off the top of the screen
- `?script=run|moon|fixed|lanterns|stream` replays a fixed input timeline (no keyboard needed)
- `?res=1080` renders at 1920x1080
- `?manual=1` stops the real time loop; `window.__step(ms)` advances the game and draws one frame

## Recording the clips

From `project/`:

```
node tools/foxlight/record.mjs --sheet
```

This renders every frame through Playwright (from `review/pw`), pipes the PNG frames to FFmpeg with `h264_nvenc` and writes `public/demo/foxlight/clip-run.mp4`, `clip-moon.mp4`, `clip-fixed.mp4`, `clip-lanterns.mp4` (1280x720), `stream-full.mp4` (1920x1080) and a poster JPG for each. `--sheet` also writes 4 fps contact sheets to `review/footage/`. Pass clip names to record only some of them, for example `node tools/foxlight/record.mjs moon fixed`.
