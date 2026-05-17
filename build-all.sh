#!/usr/bin/bash

set -e

./build.sh win
./build.sh linux
./build.sh linux arm64
