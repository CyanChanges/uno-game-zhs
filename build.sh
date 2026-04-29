#!/usr/bin/bash

set -eu

DIST_DIR="dist/"
CURRENT_DATE=$(date +%F)
TARGET_DIR="release/"

PLATFORM="${1:-windows}"

FILE_NAME="UNO-${CURRENT_DATE}_${PLATFORM}.zip"
FULL_PATH="${TARGET_DIR}${FILE_NAME}"

if [ -f "$FULL_PATH" ]; then
    rm "$FULL_PATH"
fi

if [ -d "$DIST_DIR" ]; then
    rm -rf "$DIST_DIR"
fi
mkdir -p "$DIST_DIR"

echo "build for $PLATFORM..."

cp index.html client.js style.css Caddyfile "$DIST_DIR"

if [ "$PLATFORM" = "windows" ]; then
    # Windows 7 support
    pkg server.js --targets node14-win-x64 --output "$DIST_DIR/uno-server.exe"

    cp binary/*.exe "$DIST_DIR" 2>/dev/null || echo "no \`.exe\` file found"
    cp binary/*.bat "$DIST_DIR" 2>/dev/null || echo "no \`.bat\` file found"
else
    pkg server.js --targets node20-linux-x64 --output "$DIST_DIR/uno-server"

    find binary/ -maxdepth 1 -type f ! -name "*.exe" ! -name "*.bat" -exec cp {} "$DIST_DIR" \;
fi

mkdir -p "$TARGET_DIR"

zip -r "$FULL_PATH" "$DIST_DIR"*

echo "released at \`$FULL_PATH\`"
