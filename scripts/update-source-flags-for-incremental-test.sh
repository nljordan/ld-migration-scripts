#!/usr/bin/env bash
# Update a subset of verify flags on the SOURCE project to trigger env version bumps.
# Run this BEFORE the incremental migration test so incremental has changes to detect.
#
# Usage:
#   LD_PROJECT_KEY=nljordan-ld-migration-scripts-source \
#   LD_DOMAIN=ld-stg.launchdarkly.com \
#   ./scripts/update-source-flags-for-incremental-test.sh
#
# Optional: --config to read API key from config/api_keys.json
# Requires: curl, jq

set -e

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

USE_CONFIG=false
for arg in "$@"; do
  [ "$arg" = "--config" ] && USE_CONFIG=true
done

if [ "$USE_CONFIG" = true ]; then
  CONFIG_PATH="$(dirname "$0")/../config/api_keys.json"
  if [ -f "$CONFIG_PATH" ]; then
    API_KEY=$(jq -r '.source_account_api_key // .destination_account_api_key // empty' "$CONFIG_PATH")
    [ -n "$API_KEY" ] && [ "$API_KEY" != "null" ] && export LD_API_KEY="$API_KEY" && echo "Using API key from $CONFIG_PATH"
  fi
fi

API_KEY="${LD_API_KEY:-$LD_E2E_API_KEY}"
PROJECT="${LD_PROJECT_KEY:-$LD_E2E_SOURCE_PROJECT}"
DOMAIN="${LD_DOMAIN:-app.launchdarkly.com}"
BASE_URL="https://${DOMAIN}/api/v2"
API_DELAY_MS="${API_DELAY_MS:-400}"

if [ -z "$API_KEY" ]; then
  echo "Error: LD_API_KEY or LD_E2E_API_KEY must be set (or use --config)"
  exit 1
fi
if [ -z "$PROJECT" ]; then
  echo "Error: LD_PROJECT_KEY or LD_E2E_SOURCE_PROJECT must be set"
  exit 1
fi

curl_req() {
  local method=$1 url=$2 data=$3
  if [ -n "$data" ]; then
    curl -s -w "\n%{http_code}" -X "$method" "$url" -H "Authorization: ${API_KEY}" -H "Content-Type: application/json" -d "$data"
  else
    curl -s -w "\n%{http_code}" -X "$method" "$url" -H "Authorization: ${API_KEY}"
  fi
}

patch_flag() {
  local flag_key=$1 patch_json=$2
  echo "Patching $flag_key..."
  local out
  out=$(curl_req PATCH "${BASE_URL}/flags/${PROJECT}/${flag_key}" "$patch_json")
  local status body
  status=$(echo "$out" | tail -1)
  body=$(echo "$out" | sed '$d')
  echo "  HTTP $status"
  [ "$status" != "200" ] && echo "  Response: $body" | head -c 200
  sleep "$(echo "scale=2; $API_DELAY_MS/1000" | bc)" 2>/dev/null || sleep 0.4
  return 0
}

echo "=== Updating source flags for incremental test ==="
echo "Project: $PROJECT"
echo "Domain: $DOMAIN"
echo ""

# 1. verify-boolean-simple [production]: add rule clause (use jq for valid JSON)
echo "[1/7] verify-boolean-simple (production rules)"
RULES='[
  {"clauses":[{"attribute":"key","op":"in","values":["verify-user-1"],"contextKind":"user"}],"variation":0},
  {"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-included"],"contextKind":"user"}],"variation":0},
  {"clauses":[{"attribute":"key","op":"in","values":["multi-1"],"contextKind":"user"},{"attribute":"email","op":"endsWith","values":[".test@example.com"],"contextKind":"user"}],"variation":0},
  {"clauses":[{"attribute":"key","op":"in","values":["incremental-test-user"],"contextKind":"user"}],"variation":0}
]'
patch_flag "verify-boolean-simple" "$(jq -n -c --argjson rules "$RULES" '[{"op":"replace","path":"/environments/production/rules","value":$rules}]')"
echo ""

# 2. verify-string-three [production]: add rule to trigger env version bump
echo "[2/7] verify-string-three (production rules)"
patch_flag "verify-string-three" '[{"op":"replace","path":"/environments/production/rules","value":[{"clauses":[{"attribute":"key","op":"in","values":["str-user"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-included"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-multi-rules"],"contextKind":"user"}],"variation":1},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-contexts"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"key","op":"in","values":["incremental-str-user"],"contextKind":"user"}],"variation":0}]}]'
echo ""

# 3. verify-targets-single [production]: add target (use production - uat may not exist in project)
echo "[3/7] verify-targets-single (production targets)"
get_var_ids() {
  local resp
  resp=$(curl -s -X GET "${BASE_URL}/flags/${PROJECT}/verify-targets-single?env=*" -H "Authorization: ${API_KEY}")
  V0=$(echo "$resp" | jq -r '.variations[0]._id // empty')
  V1=$(echo "$resp" | jq -r '.variations[1]._id // empty')
}
get_var_ids
if [ -n "$V0" ] && [ -n "$V1" ]; then
  patch_json=$(jq -n -c \
    --arg v0 "$V0" --arg v1 "$V1" \
    '[{"op":"replace","path":"/environments/production/targets","value":[{"values":["verify-target-user-1"],"variationId":$v0},{"values":["incremental-target-user"],"variationId":$v1}]}]')
  patch_flag "verify-targets-single" "$patch_json"
else
  echo "  Warning: Could not get variation IDs, skipping targets update"
fi
echo ""

# 4. verify-multi-var-rules [test]: change fallthrough rollout
echo "[4/7] verify-multi-var-rules (test fallthrough)"
patch_flag "verify-multi-var-rules" '[{"op":"replace","path":"/environments/test/fallthrough","value":{"rollout":{"variations":[{"variation":0,"weight":40000},{"variation":1,"weight":30000},{"variation":2,"weight":30000}],"contextKind":"user"}}}]'
echo ""

# 5. verify-rule-value-replace: create flag + single-clause versionName rule (tests replace: 26.3.30 -> 1.0.0)
echo "[5/7] verify-rule-value-replace (create + versionName rule)"
CREATE_BODY='{"key":"verify-rule-value-replace","name":"Verify Rule Value Replace","description":"Single-clause versionName rule - tests ruleValueReplacements value replace (26.3.30 -> 1.0.0)","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["verify"]}'
echo "Creating flag verify-rule-value-replace..."
CREATE_OUT=$(curl_req POST "${BASE_URL}/flags/${PROJECT}" "$CREATE_BODY")
CREATE_STATUS=$(echo "$CREATE_OUT" | tail -1)
echo "  HTTP $CREATE_STATUS"
sleep "$(echo "scale=2; $API_DELAY_MS/1000" | bc)" 2>/dev/null || sleep 0.4

if [ "$CREATE_STATUS" = "201" ] || [ "$CREATE_STATUS" = "409" ]; then
  ENVS_TO_PATCH=("production" "uat" "test")
  for env in "${ENVS_TO_PATCH[@]}"; do
    echo "  Adding versionName rule [$env]..."
    patch_flag "verify-rule-value-replace" "[{\"op\":\"replace\",\"path\":\"/environments/${env}/rules\",\"value\":[{\"clauses\":[{\"attribute\":\"versionName\",\"op\":\"semVerLessThan\",\"values\":[\"26.3.30\"],\"contextKind\":\"ld_application\",\"negate\":true}],\"variation\":0}]}]"
  done
fi
echo ""

# 6. verify-rule-value-remove: create flag + two-clause rule (versionName + country) to test action:remove
echo "[6/7] verify-rule-value-remove (create + versionName+country rule)"
CREATE_BODY_REM='{"key":"verify-rule-value-remove","name":"Verify Rule Value Remove","description":"Two-clause rule (versionName + country) - tests ruleValueReplacements action:remove drops versionName clause, keeps country","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["verify"]}'
echo "Creating flag verify-rule-value-remove..."
CREATE_OUT_REM=$(curl_req POST "${BASE_URL}/flags/${PROJECT}" "$CREATE_BODY_REM")
CREATE_STATUS_REM=$(echo "$CREATE_OUT_REM" | tail -1)
echo "  HTTP $CREATE_STATUS_REM"
sleep "$(echo "scale=2; $API_DELAY_MS/1000" | bc)" 2>/dev/null || sleep 0.4

if [ "$CREATE_STATUS_REM" = "201" ] || [ "$CREATE_STATUS_REM" = "409" ]; then
  ENVS_TO_PATCH=("production" "uat" "test")
  for env in "${ENVS_TO_PATCH[@]}"; do
    echo "  Adding versionName + country rule [$env]..."
    patch_flag "verify-rule-value-remove" "[{\"op\":\"replace\",\"path\":\"/environments/${env}/rules\",\"value\":[{\"clauses\":[{\"attribute\":\"versionName\",\"op\":\"semVerLessThan\",\"values\":[\"99.0.0\"],\"contextKind\":\"ld_application\",\"negate\":true},{\"attribute\":\"country\",\"op\":\"in\",\"values\":[\"US\"],\"contextKind\":\"user\"}],\"variation\":0}]}]"
  done
fi
echo ""

# 7. verify-rule-value-replace-generic: create flag + add generic CVS rule (tests ruleValueReplacements without attribute filter)
echo "[7/7] verify-rule-value-replace-generic (create + company=CVS rule)"
CREATE_BODY_GEN='{"key":"verify-rule-value-replace-generic","name":"Verify Rule Value Replace Generic","description":"Generic clause value replacement (CVS -> Health100) - tests ruleValueReplacements without attribute filter","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["verify"]}'
echo "Creating flag verify-rule-value-replace-generic..."
CREATE_OUT_GEN=$(curl_req POST "${BASE_URL}/flags/${PROJECT}" "$CREATE_BODY_GEN")
CREATE_STATUS_GEN=$(echo "$CREATE_OUT_GEN" | tail -1)
echo "  HTTP $CREATE_STATUS_GEN"
sleep "$(echo "scale=2; $API_DELAY_MS/1000" | bc)" 2>/dev/null || sleep 0.4

if [ "$CREATE_STATUS_GEN" = "201" ] || [ "$CREATE_STATUS_GEN" = "409" ]; then
  ENVS_TO_PATCH=("production" "uat" "test")
  for env in "${ENVS_TO_PATCH[@]}"; do
    echo "  Adding company=CVS rule [$env]..."
    patch_flag "verify-rule-value-replace-generic" "[{\"op\":\"replace\",\"path\":\"/environments/${env}/rules\",\"value\":[{\"clauses\":[{\"attribute\":\"company\",\"op\":\"in\",\"values\":[\"CVS\"],\"contextKind\":\"user\"}],\"variation\":0}]}]"
  done
fi
echo ""

echo "=== Done. Re-extract then run incremental workflow ==="
echo "  deno task source-from-ld -p $PROJECT --extract-segments=true"
echo "  deno task workflow -f examples/workflow-nljordan-incremental.yaml"
echo ""
