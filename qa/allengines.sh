#!/usr/bin/env bash
# Run the FULL feature harness in the given engines, each against a fresh DB.
set -o pipefail
# Derived from this script's location so the harness follows the repo it ships with.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DC="docker compose -f $ROOT/deploy/docker-compose.qa.yml"
cd "$ROOT/deploy" || exit 1
ENGINES="${*:-chromium firefox webkit}"

# The QA stack (compose project `model-qa`) mounts ./qa-data at container paths and
# serves the web app on 8088 — unlike the dev stack, where paths are host=container
# and the app is on 8080. run.mjs defaults to the dev stack, so point it at QA here.
export QA_URL=http://localhost:8088
export QA_ADMIN_PASSWORD='AdminPass123!'
export QA_SOURCE_PATH=/data/source-datasets
export QA_MODEL_PATH=/data/models
export QA_TD_PATH=/data/training-datasets
export QA_BUILD_SOURCES=vehicles

for eng in $ENGINES; do
  echo "############################## $eng ##############################"
  $DC down -v >/dev/null 2>&1
  $DC up -d >/dev/null 2>&1
  for i in $(seq 1 40); do st=$(docker inspect -f '{{.State.Health.Status}}' model-qa-backend-1 2>/dev/null); [ "$st" = "healthy" ] && break; sleep 2; done
  $DC exec -T postgres psql -U migration_role -d model_trainer -c "UPDATE app.system_settings SET value='true'::jsonb WHERE setting_key IN ('model_download_allow_http','model_download_allow_private');" >/dev/null 2>&1
  QA_ENGINE=$eng node "$ROOT/qa/run.mjs" > "/tmp/qa_$eng.log" 2>&1
  passes=$(grep -ac '^  ✓' "/tmp/qa_$eng.log"); fails=$(grep -ac '^  ✗' "/tmp/qa_$eng.log")
  echo "RESULT $eng: passes=$passes fails=$fails"
  grep -aE '^  ✗' "/tmp/qa_$eng.log" | sed 's/^/    FAIL:/'
done
echo "############################## DONE ##############################"
for eng in $ENGINES; do
  echo "$eng: passes=$(grep -ac '^  ✓' /tmp/qa_$eng.log) fails=$(grep -ac '^  ✗' /tmp/qa_$eng.log)"
done
