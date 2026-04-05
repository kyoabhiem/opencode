#!/usr/bin/env bash
export OPENCODE_VERSION=" "
export OPENCODE_RELEASE=true
bun run packages/opencode/script/build.ts --single
