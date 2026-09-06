#!/usr/bin/env sh
set -eu

# Token management is intentionally allowed without the application runner.
# The normal container command must have a standalone server entry point;
# silently running the old SillyTavern plugin here would bypass remote auth.
if [ "${1:-}" = "node" ] && [ "${2:-}" = "/app/server/standalone.js" ]; then
    if [ ! -f /app/server/standalone.js ]; then
        echo "[anima-remote] refusing to start: /app/server/standalone.js is missing" >&2
        echo "[anima-remote] the current server/index.js is a SillyTavern plugin entry point, not a standalone authenticated server" >&2
        exit 78
    fi
fi

exec "$@"
