#!/bin/sh
# SSH Portal bridge launcher for macOS / Linux.
# Run it from your desktop session (or an XQuartz terminal on macOS) so $DISPLAY is set for ssh -Y.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required: https://nodejs.org/"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund || exit 1
exec node server.js "$@"
