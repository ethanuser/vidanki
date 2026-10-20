#!/bin/zsh
# Double-click to start VidAnki and open it in your browser.
cd "$(dirname "$0")"
if ! curl -s -o /dev/null localhost:8770/api/state; then
  python3 server.py "$@" &
  sleep 1
fi
open http://localhost:8770
wait
