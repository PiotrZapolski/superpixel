#!/bin/sh
# Renders the Superpixel explainer on the Hetzner box inside throwaway containers.
# Never run this on a laptop. Copy the project first (without node_modules / out):
#   rsync -a --delete --exclude node_modules --exclude out video/ hetzner-backup:/opt/superpixel-video/remotion/
# Then on the server, from /opt/superpixel-video/remotion:
#   sh render.sh install     # npm install into the mounted dir (node_modules cached there)
#   sh render.sh soundtrack  # public/soundtrack.mp3 from ../audio/music.mp3
#   sh render.sh typecheck | stills | frames 120 300 ... | video
#   sh export-web.sh         # web encodes + posters into /opt/superpixel-video/out/web
# Output lands in /opt/superpixel-video/out.
set -eu

MODE="${1:-video}"
APP=/opt/superpixel-video/remotion
OUT=/opt/superpixel-video/out
AUDIO=/opt/superpixel-video/audio
IMAGE=justrank-video-remotion:base
LIMITS="--cgroup-parent=ci.slice --cpus=6 --memory=8g"

mkdir -p "$OUT"

run() {
	docker run --rm $LIMITS -v "$APP":/app -v "$OUT":/out -w /app "$IMAGE" sh -c "$1"
}

case "$MODE" in
install)
	run "npm install --no-audit --no-fund"
	;;
soundtrack)
	# Music: skip the generated fade-in (level reached at ~1.45 s, the first kick lands at 1.60 s,
	# so scene cuts on multiples of 12 frames fall on the beat), 43 s, louder than a voice bed
	# since there is no voice, normalised to -14 LUFS, then a 2.4 s fade-out to silence.
	docker run --rm $LIMITS -v "$AUDIO":/a -v "$APP/public":/p linuxserver/ffmpeg:latest -loglevel error -y \
		-i /a/music.mp3 -af "atrim=start=1.6:end=44.6,asetpts=PTS-STARTPTS,volume=0.8,loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=out:st=40.6:d=2.4" \
		-ar 48000 -ac 2 -b:a 192k /p/soundtrack.mp3
	;;
typecheck)
	run "npx tsc --noEmit"
	;;
stills)
	# One still per scene, at 65 % of the scene, from src/timeline.json.
	run 'npx remotion bundle src/index.ts --out-dir=/tmp/bundle --log=error >/dev/null &&
		node -e "const t=require(\"./src/timeline.json\");for(const s of t.scenes){console.log(s.id+\" \"+Math.round(s.start+(s.end-s.start)*0.65))}" |
		while read id f; do npx remotion still /tmp/bundle Explainer /out/stills/still-$id.png --frame=$f --scale=0.5 --log=error; done'
	;;
frames)
	# Extra stills at chosen frames: sh render.sh frames 120 200 ...
	shift
	run "npx remotion bundle src/index.ts --out-dir=/tmp/bundle --log=error >/dev/null && for f in $*; do npx remotion still /tmp/bundle Explainer /out/stills/frame-\$f.png --frame=\$f --scale=0.5 --log=error; done"
	;;
sfxstem)
	# Effects only (no music), to check the SFX level against the soundtrack.
	run "npx remotion render src/index.ts Explainer /out/sfx-stem.wav --codec=wav --props='{\"soundtrack\":false}' --log=error"
	;;
video)
	run "npx remotion render src/index.ts Explainer /out/explainer-final.mp4 --codec=h264 --crf=18 --audio-codec=aac --audio-bitrate=192k --concurrency=6"
	;;
*)
	echo "usage: sh render.sh install|soundtrack|typecheck|stills|frames|sfxstem|video" >&2
	exit 1
	;;
esac
