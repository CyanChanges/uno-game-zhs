#!/usr/bin/bash

set -eu

BIN_DIR="bin/"
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

PKG="npx pkg"

if [ -f "$FULL_PATH" ]; then
    rm "$FULL_PATH"
fi

# Build TypeScript first
echo "Building TypeScript..."
npm run build

mkdir -p "$BIN_DIR"

echo "build for $PLATFORM $ARCH..."

if [ "$PLATFORM" = "win" ]; then
    outfile="${BIN_DIR}windows/uno-server.exe"
    outdir=$(dirname "$outfile")
    rm -rf "$outdir"
    mkdir -p "$outdir"

    $PKG . --targets "node12-win-${ARCH}" --output "$outfile" --public

    scripts/write_copyright "$outfile"
else
    outfile="${BIN_DIR}linux/uno-server"
    outdir=$(dirname "$outfile")
    rm -rf "$outdir"
    mkdir -p "$outdir"

    # Fallback to npx pkg for non-Windows platforms if they are still Node.js based
    $PKG . --targets "node12-${PLATFORM}-${ARCH}" --output "$outfile" --public
fi

mkdir -p "$TARGET_DIR"

zip "$FULL_PATH" -j "$outfile"

echo "released at \`$FULL_PATH\`"
