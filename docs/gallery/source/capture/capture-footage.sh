#!/bin/sh
# Pulls full-resolution gameplay frames from the Foxlight example footage.
cd "$(dirname "$0")/../assets/game" || exit 1
V=../../../../../public/demo/foxlight/stream-full.mp4
ffmpeg -v error -y -ss 12.5 -i "$V" -frames:v 1 -q:v 2 game-jump.jpg
ffmpeg -v error -y -ss 36.0 -i "$V" -frames:v 1 -q:v 2 game-waterfall.jpg
