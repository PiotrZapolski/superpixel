#!/bin/sh
# Render the Chrome Web Store graphics on the Hetzner box (nothing heavy runs locally).
#   sh store/render.sh [target ...]     e.g. sh store/render.sh screenshot-3-ads
# Steps: rsync the needed repo files to $REMOTE_DIR, render in a throwaway Playwright container
# (store/render.mjs), flatten to 24-bit RGB PNG (no alpha) with ffmpeg, copy back to store/out/,
# then copy to ~/Downloads/superpixel-store/ under the Chrome Web Store form field names.
set -eu

HOST=${HOST:-hetzner-backup}
REMOTE_DIR=${REMOTE_DIR:-/opt/superpixel-store}
PW_IMAGE=mcr.microsoft.com/playwright:v1.48.2-jammy
FF_IMAGE=linuxserver/ffmpeg:latest
ROOT=$(cd "$(dirname "$0")/.." && pwd)

ssh "$HOST" "mkdir -p $REMOTE_DIR/repo $REMOTE_DIR/deps"
(cd "$ROOT" && rsync -a --delete --relative icons sidepanel store/src store/render.mjs "$HOST:$REMOTE_DIR/repo/")

ssh "$HOST" "set -e
cd $REMOTE_DIR
rm -rf repo/store/out && mkdir -p repo/store/out/raw
docker run --rm --cpus=4 --ipc=host -v $REMOTE_DIR/deps:/deps -v $REMOTE_DIR/repo:/repo -w /repo $PW_IMAGE sh -c '
  [ -d /deps/node_modules/playwright-core ] || npm i -s --prefix /deps playwright-core@1.48.2 >/dev/null
  node store/render.mjs $*'
for f in repo/store/out/raw/*.png; do
  n=\$(basename \$f)
  docker run --rm --cpus=4 -v $REMOTE_DIR/repo/store/out:/o $FF_IMAGE -loglevel error -y -i /o/raw/\$n -pix_fmt rgb24 /o/\$n
done
rm -rf repo/store/out/raw"

mkdir -p "$ROOT/store/out"
rsync -a "$HOST:$REMOTE_DIR/repo/store/out/" "$ROOT/store/out/"
cp "$ROOT/icons/icon128.png" "$ROOT/store/icon-128.png"
file "$ROOT/store/icon-128.png" "$ROOT"/store/out/*.png

# Chrome Web Store form field names (Polish UI).
DL="$HOME/Downloads/superpixel-store"
mkdir -p "$DL"
cp "$ROOT/store/icon-128.png" "$DL/ikona-sklepu-128x128.png"
for i in 1 2 3 4; do
	src=$(ls "$ROOT"/store/out/screenshot-$i-*.png 2>/dev/null | head -1)
	[ -n "$src" ] && cp "$src" "$DL/zrzut-ekranu-$i-1280x800.png"
done
[ -f "$ROOT/store/out/promo-small.png" ] && cp "$ROOT/store/out/promo-small.png" "$DL/maly-obraz-promocji-440x280.png"
[ -f "$ROOT/store/out/promo-marquee.png" ] && cp "$ROOT/store/out/promo-marquee.png" "$DL/transparent-promocyjny-1400x560.png"
echo "copied to $DL"
