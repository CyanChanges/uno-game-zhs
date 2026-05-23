#!/usr/bin/bash

set -euo pipefail

./build.sh win
./build.sh linux arm64
./build.sh linux
