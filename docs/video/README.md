# Submission film source

The film is code: an HTML page renders every frame as a pure function of time, Playwright captures it frame by frame, FFmpeg encodes with `h264_nvenc`, and the soundtrack is synthesized in Python from the same event list the picture exports.

| Path | What it is |
| --- | --- |
| `BEATS.md` | Idea, signature moves and the beat sheet on the 120 BPM grid |
| `film/index.html`, `film/film.js`, `film/lib.js`, `film/content.js` | The picture. `window.renderAt(t)` sets every property for time `t`; `window.EVENTS` lists sound events |
| `audio/dsp.py` | Synthesis and effects toolkit (48 kHz, deterministic seeds) |
| `audio/music.py` | The original score: stems for drums, bass, keys, pad and lead, by section |
| `audio/sfx.py` | The sound design palette, one generator per action kind, varied per event id |
| `audio/mix.py` | Tape-rewind treatment of the score, SFX placement, the raid scene's own SFX, ducking, two-pass loudnorm |
| `tools/render.cjs` | Frame capture: stills, sheet frames or a 60 fps video |
| `tools/sheet.py`, `tools/strips.py` | Contact sheets and neighbour-frame strips for review |
| `tools/mine-codex.py`, `tools/codex-facts.json` | Real counts mined from the Codex session transcript for the Codex passage |

## Preview and render

```bash
npx vite --config docs/video/tools/vite.film.config.mjs   # capture server on 127.0.0.1:4330, no hot reload
# scrub in a browser: http://127.0.0.1:4330/docs/video/film/index.html?t=4.5
node docs/video/tools/capture-ui.cjs && node docs/video/tools/ui-rects.cjs   # refresh the real UI captures from https://localhost:4317
bash docs/video/render.sh ../review/video/final 0 138                      # events, score, mix, picture (6 browsers), mux
```

The master is `previously-submission.mp4` (1080p60, h264_nvenc, AAC 320 kb/s, faststart); `previously-submission-web.mp4` is the 1080p30 version for attachments.

The raid scene is embedded live from the overlay lab (`src/features/overlay/lab`, Foxlight plan) through an iframe and seeked with `window.__seek(ms)`, so the film picks up every change to the product's scene on the next render. Its sound comes from `window.__renderSfx()`.

Heavy intermediates (frames, stems, WAV, MP4) go to `../review/video/`, outside Git.
