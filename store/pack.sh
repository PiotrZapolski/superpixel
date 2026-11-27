#!/bin/sh
# Build the Chrome Web Store upload package: only the files the extension loads.
#   sh store/pack.sh [output-dir]     default output: store/dist/superpixel-<version>.zip
# No server/, tests/, video/, store/ or docs/ in the zip. Needs only python3 (version from manifest.json, zip via zipfile).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-"$ROOT/store/dist"}
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/manifest.json")
ZIP="$OUT/superpixel-$VERSION.zip"

mkdir -p "$OUT"
[ ! -e "$ZIP" ] || { echo "already exists: $ZIP" >&2; exit 1; }
cd "$ROOT"
python3 -m zipfile -c "$ZIP" manifest.json blank.html LICENSE \
  adapters background content detect icons lib offscreen report sidepanel
echo "$ZIP"
