#!/usr/bin/env node
import { ensureBinDir, build } from "./build-exe.js";
import { $ } from "zx";
$.verbose = true; // Turn verbosity back on for direct CLI execution

await ensureBinDir();
await build("node12", "win", "x64");
await build("node12", "linux", "arm64");
await build("node12", "linux", "x64");
