#!/usr/bin/bash

set -e

./build.sh win
./build.sh linux arm64
./build.sh linux
