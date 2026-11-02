#!/usr/bin/env bash
# Re-render the film with sound. Needs the capture server (no hot reload) on 127.0.0.1:4330:
#   npx vite --config docs/video/tools/vite.film.config.mjs
# Usage: bash docs/video/render.sh [OUT_DIR] [FROM] [TO]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../../../review/video}"
FROM="${2:-0}"; TO="${3:-138}"
mkdir -p "$OUT"
cd "$HERE/tools"
# 1. picture events and the raid scene's own synthesized SFX
node render.cjs --out "$OUT" --events "$OUT/events.json" --scene-sfx "$OUT/scene-sfx.wav"
# 2. score stems, then the mix (two-pass loudnorm to -14 LUFS, -1 dBTP)
cd "$HERE/audio"
python music.py "$OUT/music" --events "$OUT/events.json" --dur "$TO"
python mix.py --stems "$OUT/music" --events "$OUT/events.json" --scene-sfx "$OUT/scene-sfx.wav" --scene-at 6.0 --scene-at2 71.75 --scene-from2 1.2 --scene-dur2 5.5 --from "$FROM" --to "$TO" --out "$OUT/mix.wav"
# 3. picture at 60 fps through h264_nvenc
cd "$HERE/tools"
bash render-par.sh "$OUT/picture.mp4" "$FROM" "$TO" 4
# 4. mux
ffmpeg -y -v error -i "$OUT/picture.mp4" -i "$OUT/mix.wav" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -movflags +faststart "$HERE/previously-submission.mp4"
ffmpeg -y -v error -i "$OUT/picture.mp4" -i "$OUT/mix.wav" -map 0:v -map 1:a -vf fps=30 -c:v h264_nvenc -preset p7 -tune hq -multipass fullres -rc vbr -b:v 1.75M -maxrate 4M -bufsize 6M -pix_fmt yuv420p -c:a aac -b:a 320k -movflags +faststart "$HERE/previously-submission-web.mp4"
echo "done: $HERE/previously-submission.mp4"
