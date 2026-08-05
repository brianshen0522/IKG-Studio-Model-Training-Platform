#!/bin/sh
# Wrapper around `docker compose up` that:
#   1. Auto-detects a usable NVIDIA GPU on the host and applies the
#      docker-compose.gpu.yml overlay for you — no need to remember `-f`. Override
#      with DEPLOY_FORCE_CPU=1 ./up.sh ... to force CPU on a GPU host. If TRAINING_DEVICE
#      isn't set in .env, it's set to 0 automatically when a GPU is used.
#   2. Expands DATA_ROOT (one or more comma-separated host paths, e.g.
#      `DATA_ROOT=/srv/a,/srv/b,/srv/c` in .env) into a generated compose overlay,
#      since a static `volumes:` list can't turn one variable into N bind mounts. Each
#      path is mounted at the same absolute path in every service that needs it
#      (backend read-only, workers read-write) — see apps/api/src/common/roots.ts for
#      how the API reads DATA_ROOT back out.
#
# Usage: same as `docker compose`, e.g.:
#   ./up.sh up -d --build
#   ./up.sh logs -f backend
#   DEPLOY_FORCE_CPU=1 ./up.sh up -d --build
set -eu
cd "$(dirname "$0")"

DATA_ROOT=$(grep -E '^DATA_ROOT=' .env 2>/dev/null | tail -1 | cut -d= -f2-)

if [ -z "${DATA_ROOT:-}" ]; then
  echo "up.sh: DATA_ROOT is not set in deploy/.env" >&2
  exit 1
fi

GPU_ARGS=""
if [ "${DEPLOY_FORCE_CPU:-0}" != "1" ] \
  && command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1 \
  && docker info 2>/dev/null | grep -qi nvidia; then
  echo "up.sh: NVIDIA GPU detected — applying docker-compose.gpu.yml" >&2
  GPU_ARGS="-f docker-compose.gpu.yml"
  if ! grep -qE '^TRAINING_DEVICE=' .env 2>/dev/null; then
    export TRAINING_DEVICE=0
  fi
fi

OVERLAY=docker-compose.data-roots.yml
{
  echo "services:"
  for svc in backend training-worker dataset-worker; do
    echo "  $svc:"
    echo "    volumes:"
    OLD_IFS=$IFS
    IFS=','
    for root in $DATA_ROOT; do
      IFS=$OLD_IFS
      root=$(echo "$root" | xargs)
      [ -z "$root" ] && continue
      if [ "$svc" = backend ]; then
        echo "      - ${root}:${root}:ro"
      else
        echo "      - ${root}:${root}"
      fi
      IFS=','
    done
    IFS=$OLD_IFS
  done
} > "$OVERLAY"

docker compose -f docker-compose.yml $GPU_ARGS -f "$OVERLAY" "$@"
STATUS=$?

# After a successful `up`, confirm what training-worker actually got — GPU detection above
# only checks the host; the container could still end up CPU-only (e.g. driver/toolkit
# mismatch, or torch built for the wrong CUDA version).
if [ "$STATUS" -eq 0 ] && [ "${1:-}" = "up" ]; then
  echo "up.sh: checking training-worker GPU support (first torch import can take a while)…" >&2
  # Spinner so the wait doesn't look like a hang.
  docker compose -f docker-compose.yml $GPU_ARGS -f "$OVERLAY" exec -T training-worker \
    uv run python -c "import torch; print(torch.cuda.is_available())" 2>/dev/null > /tmp/up-cuda-check &
  CHECK_PID=$!
  i=0
  while kill -0 "$CHECK_PID" 2>/dev/null; do
    i=$((i + 1))
    case $((i % 4)) in
      0) c='|' ;;
      1) c='/' ;;
      2) c='-' ;;
      3) c='\\' ;;
    esac
    printf '\rup.sh: checking GPU support… %s' "$c" >&2
    sleep 0.1
  done
  cuda=$(cat /tmp/up-cuda-check 2>/dev/null)
  rm -f /tmp/up-cuda-check
  printf '\r' >&2
  if [ -n "$GPU_ARGS" ]; then
    if [ "$cuda" = "True" ]; then
      echo "up.sh: training-worker is using CUDA (torch.cuda.is_available() = True)" >&2
    else
      echo "up.sh: WARNING — GPU overlay applied but torch.cuda.is_available() = $cuda (falling back to CPU behavior)" >&2
    fi
  else
    echo "up.sh: training-worker is using CPU (torch.cuda.is_available() = $cuda)" >&2
  fi
fi

exit "$STATUS"
