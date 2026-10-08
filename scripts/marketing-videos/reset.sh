#!/bin/bash
# Rebuild the demo database from scratch: base seed + fictional marketing data.
# Stops any demo server on :3100 first; start it again with ./serve.sh.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/demo-env.sh"
fuser -k 3100/tcp 2>/dev/null || true
sleep 1
rm -f "$LOCAL_DB_PATH"
cd "$HERE/../.."
node -e "require('dotenv').config(); if (process.env.MONGODB_URI || !process.env.LOCAL_DB_PATH.includes('/marketing-videos/.work/')) { console.error('Refusing: not the demo database.'); process.exit(1); } require('./lib/seed.js')" > /dev/null
cd "$HERE" && node voice.js && node enrich.js
node "$HERE/ai-summary.js" || echo "(continuing without an AI summary)"
[ -n "$SKIP_VIDEO_SUMMARY" ] || node "$HERE/video-summary.js" || echo "(continuing without a video summary)"
