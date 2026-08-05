#!/usr/bin/env sh
set -eu

# Force Ultralytics offline-first: disable cloud settings sync (sync) and Hugging Face
# auto-fetch (huggingface) — once the installed version defines the key. The settings
# schema is strict (extra or missing keys trigger a full reset back to defaults), so
# only keys present in this version's defaults are touched. Assignment persists to the
# settings.json under the yolo-weights volume immediately.
uv run --no-sync python - <<'PY'
from ultralytics import settings

for key in ("huggingface", "hub", "sync"):
    if key in settings.defaults:
        settings[key] = False
PY

exec "$@"
