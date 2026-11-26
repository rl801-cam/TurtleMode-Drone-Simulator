#!/bin/bash
# Fetch the Sponza atrium (Khronos glTF-Sample-Assets, Crytek/Frank Meinl, PBR textures by
# Alexandre Pestana) into assets/models/sponza/ for local use. Not committed: its licence
# (Crytek's donation "to the public for radiosity") doesn't clearly allow redistribution, so the
# map falls back to loading it from Khronos's GitHub when the local copy is missing.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=assets/models/sponza; mkdir -p "$OUT"
BASE=https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Sponza/glTF
curl -s -A "Mozilla/5.0 (asset-fetch)" "https://api.github.com/repos/KhronosGroup/glTF-Sample-Assets/contents/Models/Sponza/glTF" \
  | python3 -c "import json,sys;[print(e['name']) for e in json.load(sys.stdin)]" | while read -r f; do
  [ -s "$OUT/$f" ] || curl -sf -A "Mozilla/5.0 (asset-fetch)" -o "$OUT/$f" "$BASE/$f"
done
du -sh "$OUT"
# Optional, for speed: GPU-compressed textures (DXT1/DXT5 .dds with mips) next to the model.
#   python3 tools/assets/dds_encode.py assets/models/sponza/dds assets/models/sponza/*.{png,jpg} --linear <non-colour maps>
# (numpy; run where numpy is available). fly/sponza picks them up automatically.
