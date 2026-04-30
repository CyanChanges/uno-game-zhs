#!/usr/bin/bash

set -eu

DIST_DIR="dist/"
CURRENT_DATE=$(date +%F)
TARGET_DIR="release/"

PLATFORM_FLAG=${1:-win}
case "$PLATFORM_FLAG" in
  ""|"win"|"linux"|"macos")
    PLATFORM="$PLATFORM_FLAG"
    ;;
  *)
    echo "unknown or unsupported platform: $PLATFORM_FLAG"
    exit 1
    ;;
esac

ARCH_FLAG=${2:-x64}
case "$ARCH_FLAG" in
  ""|"x64"|"ia32"|"arm64")
    ARCH="$ARCH_FLAG"
    ;;
  *)
    echo "unknown or unsupported arch: $ARCH_FLAG"
    exit 1
    ;;
esac


FILE_NAME="UNO-${CURRENT_DATE}_${PLATFORM}_${ARCH}.zip"
FULL_PATH="${TARGET_DIR}${FILE_NAME}"

if [ -f "$FULL_PATH" ]; then
    rm "$FULL_PATH"
fi

if [ -d "$DIST_DIR" ]; then
    rm -rf "$DIST_DIR"
fi
mkdir -p "$DIST_DIR"

echo "build for $PLATFORM..."

if [ "$PLATFORM" = "win" ]; then
    # Windows 7 support
    outfile="${DIST_DIR}uno-server.exe"
    pkg . --targets "node12-win-${ARCH}" --output "$outfile" --public

    # rcedit "$outfile" --set-version-string "LegalCopyright" "Copyright (C) 2026 miruku (lovemilk)"
else
    outfile="${DIST_DIR}uno-server"
    pkg . --targets "node12-${PLATFORM}-${ARCH}" --output "$outfile" --public
fi

mkdir -p "$TARGET_DIR"

zip "$FULL_PATH" -j "$outfile"

echo "released at \`$FULL_PATH\`"
