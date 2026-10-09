#!/bin/sh
# Web exports of the final render, on the Hetzner box in throwaway containers.
# Run from /opt/superpixel-video/remotion after `sh render.sh video`:
#   sh export-web.sh
# Output: /opt/superpixel-video/out/web (copy into server/site/assets/video/).
set -eu

OUT=/opt/superpixel-video/out
WEB=$OUT/web
SRC=/out/explainer-final.mp4
# Poster: the clean end card (logo, tagline, superpixel.run).
POSTER_FRAME=1240
LIMITS="--cgroup-parent=ci.slice --cpus=6 --memory=8g"
# Remotion writes full-range BT.601 (yuvj420p); web players expect limited-range BT.709.
TOTV="in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709"
TAGS="-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709"

mkdir -p "$WEB"

ff() {
	docker run --rm $LIMITS -v "$OUT":/out -w /out/web linuxserver/ffmpeg:latest "$@"
}

ff -y -v error -i $SRC -vf scale=$TOTV,format=yuv420p $TAGS -c:v libx264 -profile:v high -pix_fmt yuv420p -preset slow -crf 23 \
	-c:a aac -b:a 128k -movflags +faststart superpixel-explainer-1080.mp4
# Upload master for YouTube (Chrome Web Store promo video): same colour fix, higher quality.
ff -y -v error -i $SRC -vf scale=$TOTV,format=yuv420p $TAGS -c:v libx264 -profile:v high -pix_fmt yuv420p -preset slow -crf 17 \
	-c:a aac -b:a 192k -movflags +faststart superpixel-explainer-youtube.mp4
ff -y -v error -i $SRC -vf scale=1280:720:flags=lanczos:$TOTV,format=yuv420p $TAGS -c:v libx264 -profile:v high -pix_fmt yuv420p -preset slow -crf 26 \
	-c:a aac -b:a 128k -movflags +faststart superpixel-explainer-720.mp4
ff -y -v error -i $SRC -vf scale=$TOTV,format=yuv420p $TAGS -c:v libvpx-vp9 -b:v 0 -crf 33 -row-mt 1 -deadline good -cpu-used 4 -pass 1 -passlogfile /out/web/.vp9 -an -f null /dev/null
ff -y -v error -i $SRC -vf scale=$TOTV,format=yuv420p $TAGS -c:v libvpx-vp9 -b:v 0 -crf 33 -row-mt 1 -deadline good -cpu-used 1 -pass 2 -passlogfile /out/web/.vp9 -c:a libopus -b:a 96k superpixel-explainer-1080.webm
rm -f "$WEB"/.vp9*

docker run --rm $LIMITS -v /opt/superpixel-video/remotion:/app -v "$OUT":/out -w /app justrank-video-remotion:base \
	npx remotion still src/index.ts Explainer /out/web/poster.png --frame=$POSTER_FRAME --log=error
ff -y -v error -i poster.png -q:v 3 superpixel-explainer-poster.jpg
ff -y -v error -i poster.png -vf scale=1280:720:flags=lanczos -q:v 3 superpixel-explainer-poster-720.jpg
rm -f "$WEB/poster.png"
ls -la "$WEB"
