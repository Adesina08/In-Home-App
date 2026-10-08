#!/bin/bash
# Record + edit inside a 3 GB memory cap, so a runaway browser or encoder is
# stopped on its own instead of starving the whole machine.
#   ./make-video.sh study-creation [--edit-only] [--music track.mp3]
HERE="$(cd "$(dirname "$0")" && pwd)"
exec systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 nice -n 10 node "$HERE/run.js" "$@"
