#!/bin/bash
# fly.sh [map] [quality] - serve the repo on localhost:8765 and open a WebGPU map in Brave with the
# flags Linux Brave needs for WebGPU on the iGPU (Vulkan). A separate profile, so the flags take
# effect even if your normal Brave is running; your controller mapping is kept in it.
#   tools/fly.sh            -> fly/sponza, quality med
#   tools/fly.sh sponza high
# FLY_DEBUG_PORT=9333 also opens Chrome DevTools Protocol on 127.0.0.1 (lets tools check, reload
# and focus tabs in this profile; any local process could then drive it, so it is off by default).
set -euo pipefail
cd "$(dirname "$0")/.."
MAP=${1:-sponza}; Q=${2:-med}; PORT=8765
PROFILE=${FLY_PROFILE:-$HOME/.cache/turtlemode-fly-profile}
BRAVE=${BRAVE:-$(command -v brave-browser || echo /opt/brave.com/brave/brave)}
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  sleep 0.5
fi
DEBUG=()
[ -n "${FLY_DEBUG_PORT:-}" ] && DEBUG=(--remote-debugging-address=127.0.0.1 "--remote-debugging-port=$FLY_DEBUG_PORT")
exec "$BRAVE" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check "${DEBUG[@]}" \
  --enable-unsafe-webgpu --enable-features=Vulkan --new-window "http://127.0.0.1:$PORT/fly/$MAP/index.html?q=$Q"
