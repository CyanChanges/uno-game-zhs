#!/usr/bin/bash

cleanup() {
    kill "$(jobs -p)" 2>/dev/null
    exit
}

trap cleanup INT TERM

ARCH=$(uname -m)
BINARY_SUFFIX=""
CADDY_BIN=""

case "${ARCH}" in
    x86_64)
        BINARY_SUFFIX="amd64"
    ;;
    aarch64)
        BINARY_SUFFIX="arm64"
    ;;
    # loongarch64)
    #     BINARY_SUFFIX
    #     CADDY_BIN="caddy_linux_loong64"
    # ;;
    *)
        echo "unsupported architecture: ${ARCH}"
        exit 127
    ;;
esac

CADDY_BIN="caddy_linux_$BINARY_SUFFIX"

./$CADDY_BIN run . &
./uno-server &

wait
