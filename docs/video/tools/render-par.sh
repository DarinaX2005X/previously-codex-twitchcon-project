#!/usr/bin/env bash
# Parallel picture render: splits [FROM, TO) into N whole-second chunks, renders each in its own browser, concatenates.
# bash render-par.sh OUT.mp4 FROM TO [N]
set -euo pipefail
OUT="$1"; FROM="$2"; TO="$3"; N="${4:-4}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="${OUT%.mp4}.parts"; mkdir -p "$TMP"
LEN=$(( TO - FROM )); STEP=$(( (LEN + N - 1) / N ))
pids=(); : > "$TMP/list.txt"
for ((i=0; i<N; i++)); do
  A=$(( FROM + i * STEP )); B=$(( A + STEP )); (( B > TO )) && B=$TO; (( A >= TO )) && break
  node "$HERE/render.cjs" --out "$TMP" --from "$A" --to "$B" --fps 60 --settle 80 --video "$TMP/part$i.mp4" > "$TMP/part$i.log" 2>&1 &
  pids+=($!); echo "file 'part$i.mp4'" >> "$TMP/list.txt"
done
for p in "${pids[@]}"; do wait "$p"; done
ffmpeg -y -v error -f concat -safe 0 -i "$TMP/list.txt" -c copy "$OUT"
echo "picture $OUT"
