#!/usr/bin/env bash
# Load data/seed/*.json flag fixtures into a LaunchDarkly project.
# Covers all migration branch fixes: env scoping, rule clamping, variation handling,
# targets/contextTargets remap, semantic patch fallback, rollout rules.
#
# Usage:
#   ./scripts/seed-from-verify-json.sh
#   ./scripts/seed-from-verify-json.sh --config
#
# Env vars (required):
#   LD_API_KEY or LD_E2E_API_KEY  - API key (or use --config for config/api_keys.json)
#   LD_PROJECT_KEY                - Project key to seed (or LD_E2E_SOURCE_PROJECT)
#
# Optional:
#   LD_DOMAIN   - Default: app.launchdarkly.com
#   LD_ENVS     - Comma-separated envs (default: production,uat,test)
#
# Requires: curl, jq

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SEED_DIR="${REPO_ROOT}/data/seed"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

if [ ! -d "$SEED_DIR" ]; then
  echo "Error: $SEED_DIR not found"
  exit 1
fi

# Parse --config
USE_CONFIG=false
for arg in "$@"; do
  if [ "$arg" = "--config" ]; then
    USE_CONFIG=true
  fi
done

if [ "$USE_CONFIG" = true ]; then
  CONFIG_PATH="${REPO_ROOT}/config/api_keys.json"
  if [ -f "$CONFIG_PATH" ]; then
    API_KEY=$(jq -r '.source_account_api_key // .destination_account_api_key // empty' "$CONFIG_PATH")
    if [ -n "$API_KEY" ] && [ "$API_KEY" != "null" ]; then
      export LD_API_KEY="$API_KEY"
      echo "Using API key from $CONFIG_PATH"
    fi
  fi
fi

API_KEY="${LD_API_KEY:-$LD_E2E_API_KEY}"
PROJECT="${LD_PROJECT_KEY:-$LD_E2E_SOURCE_PROJECT}"
DOMAIN="${LD_DOMAIN:-app.launchdarkly.com}"
ENVS_STR="${LD_ENVS:-production,uat,test}"
IFS=',' read -ra ENVS <<< "$ENVS_STR"
BASE_URL="https://${DOMAIN}/api/v2"

if [ -z "$API_KEY" ]; then
  echo "Error: LD_API_KEY or LD_E2E_API_KEY must be set (or use --config)"
  exit 1
fi

if [ -z "$PROJECT" ]; then
  echo "Error: LD_PROJECT_KEY or LD_E2E_SOURCE_PROJECT must be set"
  exit 1
fi

echo "=== Loading migration fix verification fixtures ==="
echo "Project: $PROJECT"
echo "Envs: ${ENVS[*]}"
echo "Seed: $SEED_DIR"
echo ""

# --- Helpers ---
create_segment() {
  local env=$1 key=$2 name=$3 desc=$4
  echo "[$env] Creating segment: $key"
  curl -s -X POST "${BASE_URL}/segments/${PROJECT}/${env}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"key\":\"${key}\",\"name\":\"${name}\",\"description\":\"${desc}\"}" \
    -w "\nHTTP %{http_code}\n" -o /dev/null || true
}

patch_segment_rules() {
  local env=$1 key=$2 rules_json=$3
  echo "  [$env] Patching segment $key with rules"
  curl -s -X PATCH "${BASE_URL}/segments/${PROJECT}/${env}/${key}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "[{\"op\":\"replace\",\"path\":\"/rules\",\"value\":${rules_json}}]" \
    -w "\nHTTP %{http_code}\n" -o /dev/null || true
}

create_flag() {
  local body=$1
  echo "Creating flag: $(echo "$body" | jq -r '.key')"
  curl -s -X POST "${BASE_URL}/flags/${PROJECT}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    -w "\nHTTP %{http_code}\n" -o /dev/null || true
}

patch_flag_env() {
  local flag_key=$1 env=$2 patch_json=$3
  echo "  Patching flag $flag_key environment $env"
  curl -s -X PATCH "${BASE_URL}/flags/${PROJECT}/${flag_key}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$patch_json" \
    -w "\nHTTP %{http_code}\n" -o /dev/null || true
}

add_rule_with_variation() {
  local flag_key=$1 env=$2 clauses_json=$3 variation_idx=$4
  local flag_json var_id
  flag_json=$(curl -s -X GET "${BASE_URL}/flags/${PROJECT}/${flag_key}?env=*" -H "Authorization: ${API_KEY}")
  var_id=$(echo "$flag_json" | jq -r ".variations[${variation_idx}]._id")
  if [ -z "$var_id" ] || [ "$var_id" = "null" ]; then
    echo "  Warning: Could not get variation ID for $flag_key idx $variation_idx, skipping"
    return
  fi
  local patch="[{\"op\":\"add\",\"path\":\"/environments/${env}/rules/-\",\"value\":{\"clauses\":${clauses_json},\"variationId\":\"${var_id}\"}}]"
  patch_flag_env "$flag_key" "$env" "$patch"
}

add_targets() {
  local flag_key=$1 env=$2 targets_json=$3
  local patch="[{\"op\":\"replace\",\"path\":\"/environments/${env}/targets\",\"value\":${targets_json}}]"
  patch_flag_env "$flag_key" "$env" "$patch"
}

add_rollout_fallthrough() {
  local flag_key=$1 env=$2
  echo "  Adding rollout fallthrough to $flag_key [$env]"
  local patch='[{"op":"replace","path":"/environments/'"${env}"'/fallthrough","value":{"rollout":{"variations":[{"variation":0,"weight":50000},{"variation":1,"weight":25000},{"variation":2,"weight":25000}],"contextKind":"user"}}}]'
  patch_flag_env "$flag_key" "$env" "$patch"
}

# --- 1. Segments (per env, required for segment-match rules) ---
echo "=== Segments ==="
for env in "${ENVS[@]}"; do
  create_segment "$env" "verify-seg-included" "Verify Segment Included" "For segment-match rule"
  patch_segment_rules "$env" "verify-seg-included" '[{"clauses":[{"attribute":"key","op":"in","values":["verify-user-1","verify-user-2"],"contextKind":"user"}]}]'
done

# --- 2. Flags from data/seed/*.json ---
echo ""
echo "=== Flags ==="
for flag_file in "$SEED_DIR"/verify-*.json; do
  [ -f "$flag_file" ] || continue
  create_flag "$(cat "$flag_file")"
done

# --- 3. Rules, targets, rollouts per env ---
echo ""
echo "=== Adding rules and targets per env ==="

for env in "${ENVS[@]}"; do
  # verify-multi-var-rules: rules at variation 0, 1, 2 (tests rule clamping)
  add_rule_with_variation "verify-multi-var-rules" "$env" '[{"attribute":"key","op":"in","values":["r0"],"contextKind":"user"}]' 0
  add_rule_with_variation "verify-multi-var-rules" "$env" '[{"attribute":"key","op":"in","values":["r1"],"contextKind":"user"}]' 1
  add_rule_with_variation "verify-multi-var-rules" "$env" '[{"attribute":"key","op":"in","values":["r2"],"contextKind":"user"}]' 2

  # verify-string-three: segment match rule
  add_rule_with_variation "verify-string-three" "$env" '[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-included"]}]' 0

  # verify-rollout-rule: percentage rollout (50/25/25)
  add_rollout_fallthrough "verify-rollout-rule" "$env"

  # Targets (variationId - tests Phase 2e remapping)
  TARGET_FLAG=$(curl -s -X GET "${BASE_URL}/flags/${PROJECT}/verify-targets-single?env=*" -H "Authorization: ${API_KEY}")
  TARGET_VAR_ID=$(echo "$TARGET_FLAG" | jq -r '.variations[0]._id')
  if [ -n "$TARGET_VAR_ID" ] && [ "$TARGET_VAR_ID" != "null" ]; then
    add_targets "verify-targets-single" "$env" "[{\"values\":[\"verify-target-user-1\"],\"variationId\":\"${TARGET_VAR_ID}\"}]"
  fi

  TARGETS_MANY=$(curl -s -X GET "${BASE_URL}/flags/${PROJECT}/verify-targets-many?env=*" -H "Authorization: ${API_KEY}")
  TV0=$(echo "$TARGETS_MANY" | jq -r '.variations[0]._id')
  TV1=$(echo "$TARGETS_MANY" | jq -r '.variations[1]._id')
  if [ -n "$TV0" ] && [ "$TV0" != "null" ]; then
    add_targets "verify-targets-many" "$env" "[{\"values\":[\"tm1\"],\"variationId\":\"${TV0}\"},{\"values\":[\"tm2\"],\"variationId\":\"${TV1}\"},{\"values\":[\"tm3\"],\"variationId\":\"${TV0}\"}]"
  fi

  # verify-rule-value-replace: ld_application versionName rule (tests ruleValueReplacements)
  add_rule_with_variation "verify-rule-value-replace" "$env" '[{"attribute":"versionName","op":"semVerLessThan","values":["26.3.30"],"contextKind":"ld_application","negate":true}]' 0

  # verify-rule-value-replace-generic: generic value replacement (CVS -> Health100)
  add_rule_with_variation "verify-rule-value-replace-generic" "$env" '[{"attribute":"company","op":"in","values":["CVS"],"contextKind":"user"}]' 0
done

echo ""
echo "=== Done ==="
echo ""
echo "Next steps to verify migration branch fixes:"
echo "  1. Extract: deno task source-from-ld -p $PROJECT --extract-segments"
echo "  2. Migrate: deno task migrate -p $PROJECT -d YOUR_DEST_PROJECT -e production,uat,test"
echo "  Or workflow: deno run -A src/scripts/launchdarkly-migrations/workflow.ts -f examples/workflow-verify-branch-fix.yaml"
echo ""
