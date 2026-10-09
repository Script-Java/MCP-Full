#!/bin/sh
# Runs as root only long enough to make the (possibly root-owned, e.g. a Railway
# volume) data directory writable for the unprivileged `node` user, then drops
# privileges. If the container is already started as a non-root user, just exec.
set -e
D="${MCP_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$D/files" "$D/playwright-output" "$D/lead-runs"
  chown node:node "$D" "$D/files" "$D/playwright-output" 2>/dev/null || true
  # -R: lead-runs may already hold files created by root over `railway ssh`.
  chown -R node:node "$D/lead-runs" 2>/dev/null || true
  [ -f "$D/memory.jsonl" ] && chown node:node "$D/memory.jsonl" 2>/dev/null || true
  exec gosu node "$@"
fi
exec "$@"
