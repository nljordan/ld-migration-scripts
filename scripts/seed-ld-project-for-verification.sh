#!/usr/bin/env bash
# Pre-seed a LaunchDarkly project with comprehensive fixtures to verify migration branch fixes.
# Idempotent: safe to run multiple times (409 on create = already exists; rules/targets/rollouts use replace).
#
# 0. Ensures environments exist (creates production, uat, test if missing)
# 1. Segments: rule-based, multi-rules, included contexts, excluded contexts (per env)
# 2. Flags: from data/seed/*.json (boolean, string, number, json, multi-var, targets, rollout, contextTargets, rule-rollout, prerequisite, rules+targets, single-var)
# 3. Per-env config: user-attr rules, segment-match (all segments), multi-clause rules, targets, rollout fallthrough
#
# Usage:
#   ./scripts/seed-ld-project-for-verification.sh
#
# Env vars (required):
#   LD_API_KEY or LD_E2E_API_KEY  - API key (or use --config to read from config/api_keys.json)
#   LD_PROJECT_KEY                - Project key to seed (source project for migration)
#
# Optional:
#   LD_DOMAIN                     - Default: app.launchdarkly.com
#   LD_ENVS                       - Comma-separated envs (default: production,uat,test)
#   LD_DEST_PROJECT               - If set, also ensures production,uat,test exist in this project (for workflow destination)
#   API_DELAY_MS                  - Delay between requests in ms (default: 600). Increase if hitting 429s.
#
#   --debug                       - Save last 4xx response to seed_last_error.json for inspection.
#
# Requires: curl, jq

set -e

# Rate limiting: delay between API calls (ms). Increase if hitting 429s (e.g. 600–800)
API_DELAY_MS="${API_DELAY_MS:-600}"
ERR_COUNT=0
ERR_LOG=""

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

# Parse --config and --debug
USE_CONFIG=false
DEBUG_RESPONSE=false
for arg in "$@"; do
  if [ "$arg" = "--config" ]; then
    USE_CONFIG=true
  elif [ "$arg" = "--debug" ]; then
    DEBUG_RESPONSE=true
  fi
done

if [ "$USE_CONFIG" = true ]; then
  CONFIG_PATH="$(dirname "$0")/../config/api_keys.json"
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
  echo "Error: LD_API_KEY or LD_E2E_API_KEY must be set (or use --config with config/api_keys.json)"
  exit 1
fi

if [ -z "$PROJECT" ]; then
  echo "Error: LD_PROJECT_KEY or LD_E2E_SOURCE_PROJECT must be set"
  exit 1
fi

echo "=== Pre-seeding LaunchDarkly project for migration branch verification ==="
echo "Project: $PROJECT"
echo "Envs: ${ENVS[*]}"
echo "Domain: $DOMAIN"
echo ""

# --- Helpers ---
ensure_environment() {
  local key=$1 name color
  case "$key" in
    production)  name="Production";  color="#417505" ;;
    uat)         name="UAT";         color="#6D1ED4" ;;
    test)        name="Test";        color="#E1562C" ;;
    staging)     name="Staging";     color="#1B7C8C" ;;
    development) name="Development";  color="#2E7D32" ;;
    *)           name="$key";        color="#6D1ED4" ;;
  esac
  echo "Creating environment: $key"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/projects/${PROJECT}/environments" \
    -H "Authorization: ${API_KEY}" -H "Content-Type: application/json" \
    -d "{\"key\":\"${key}\",\"name\":\"${name}\",\"color\":\"${color}\"}")
  if [ "$status" = "201" ]; then
    echo "  Created: $key"
  elif [ "$status" = "409" ] || [ "$status" = "200" ]; then
    echo "  $key: already exists"
  else
    echo "  Warning: Could not create $key (HTTP $status)"
  fi
}

# Helper: run curl with retry on 429/409, return HTTP status
# 429 = rate limit (Retry-After or exponential backoff)
# 409 = conflict (retry after delay; often transient with concurrent updates)
api_call() {
  local method=$1 url=$2 data=$3 max_retries=5
  local status i retry_sec
  for i in $(seq 1 "$max_retries"); do
    if [ -n "$data" ]; then
      status=$(curl -s -D /tmp/seed_headers.txt -o /tmp/seed_resp.json -w "%{http_code}" -X "$method" "$url" -H "Authorization: ${API_KEY}" -H "Content-Type: application/json" -d "$data")
    else
      status=$(curl -s -D /tmp/seed_headers.txt -o /tmp/seed_resp.json -w "%{http_code}" -X "$method" "$url" -H "Authorization: ${API_KEY}")
    fi
    if [ "$status" = "429" ] && [ "$i" -lt "$max_retries" ]; then
      retry_sec=$(grep -i '^retry-after:' /tmp/seed_headers.txt 2>/dev/null | head -1 | tr -d '\r' | awk '{print $2}')
      if [ -n "$retry_sec" ] && [ "$retry_sec" -gt 0 ] 2>/dev/null; then
        echo "  Rate limited (429), waiting ${retry_sec}s (Retry-After)..." >&2
        sleep "$retry_sec"
      else
        retry_sec=$((2 ** i))
        echo "  Rate limited (429), waiting ${retry_sec}s (attempt $i/$max_retries)..." >&2
        sleep "$retry_sec"
      fi
    elif [ "$status" = "409" ] && [ "$i" -lt "$max_retries" ] && [ "$method" = "PATCH" ]; then
      retry_sec=$((3 + i))
      echo "  Conflict (409), waiting ${retry_sec}s before retry ($i/$max_retries)..." >&2
      sleep "$retry_sec"
    else
      break
    fi
  done
  [ "$API_DELAY_MS" -gt 0 ] 2>/dev/null && sleep "$(echo "scale=2; $API_DELAY_MS/1000" | bc)" 2>/dev/null || sleep 0.4
  echo "$status"
}

record_err() {
  ERR_COUNT=$((ERR_COUNT + 1))
  local msg="$2"
  if [[ "$msg" == *"HTTP 40"* ]]; then
    local api_msg
    api_msg=$(jq -r '.message // .errors[0].message? // .error // empty' /tmp/seed_resp.json 2>/dev/null)
    [ -n "$api_msg" ] && msg="${msg} | API: ${api_msg}"
    [ "$DEBUG_RESPONSE" = true ] && cp /tmp/seed_resp.json "$(dirname "$0")/../seed_last_error.json" 2>/dev/null && echo "  (saved to seed_last_error.json)" >&2
  fi
  ERR_LOG="${ERR_LOG}$(printf '\n  [%s] %s' "$1" "$msg")"
}

# Ensure production, uat, test exist in a project (workflow requires these)
ensure_workflow_envs() {
  local proj=$1
  local envs_to_ensure=(production uat test)
  local existing
  existing=$(curl -s -X GET "${BASE_URL}/projects/${proj}/environments" -H "Authorization: ${API_KEY}" | jq -r '.items[]?.key // empty' | tr '\n' ' ')
  for env in "${envs_to_ensure[@]}"; do
    if [[ " $existing " =~ " ${env} " ]]; then
      echo "  [$proj] $env: already exists"
    else
      ensure_environment_for_project "$proj" "$env"
      sleep 0.5
    fi
  done
}

ensure_environment_for_project() {
  local proj=$1 key=$2 name color
  case "$key" in
    production)  name="Production";  color="#417505" ;;
    uat)         name="UAT";         color="#6D1ED4" ;;
    test)        name="Test";        color="#E1562C" ;;
    staging)     name="Staging";     color="#1B7C8C" ;;
    development) name="Development"; color="#2E7D32" ;;
    *)           name="$key";        color="#6D1ED4" ;;
  esac
  echo "  [$proj] Creating environment: $key"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/projects/${proj}/environments" \
    -H "Authorization: ${API_KEY}" -H "Content-Type: application/json" \
    -d "{\"key\":\"${key}\",\"name\":\"${name}\",\"color\":\"${color}\"}")
  if [ "$status" = "201" ]; then
    echo "    Created: $key"
  elif [ "$status" = "409" ] || [ "$status" = "200" ]; then
    echo "    $key: already exists"
  else
    echo "    Warning: Could not create $key (HTTP $status)"
  fi
}

# --- 0. Ensure environments exist (workflow requires production, uat, test) ---
echo "=== Ensuring environments exist ==="
# Always ensure workflow-required envs in source project
ensure_workflow_envs "$PROJECT"

# If LD_DEST_PROJECT set, ensure destination has same envs (migration will fail without them)
if [ -n "${LD_DEST_PROJECT:-}" ]; then
  echo ""
  echo "Ensuring destination project ${LD_DEST_PROJECT} has workflow envs..."
  ensure_workflow_envs "$LD_DEST_PROJECT"
  echo ""
fi

# Resolve VALID_ENVS for seeding (source project; re-fetch after ensure_workflow_envs)
resp=$(curl -s -X GET "${BASE_URL}/projects/${PROJECT}/environments" -H "Authorization: ${API_KEY}")
EXISTING_ENVS=""
if echo "$resp" | jq -e '.items' &>/dev/null; then
  EXISTING_ENVS=$(echo "$resp" | jq -r '.items[].key' | tr '\n' ' ')
fi
VALID_ENVS=()
for env in "${ENVS[@]}"; do
  if [[ " $EXISTING_ENVS " =~ " ${env} " ]]; then
    VALID_ENVS+=("$env")
  else
    echo "  Skipping $env (not available in project)"
  fi
done
# If VALID_ENVS is empty, use EXISTING_ENVS from initial fetch
if [ ${#VALID_ENVS[@]} -eq 0 ]; then
  for e in $EXISTING_ENVS; do VALID_ENVS+=("$e"); done
fi
echo "Valid envs for seeding: ${VALID_ENVS[*]:-(none)}"
echo ""

create_segment() {
  local env=$1 key=$2 name=$3 desc=$4 status
  local body="{\"key\":\"${key}\",\"name\":\"${name}\",\"description\":\"${desc}\"}"
  echo "[$env] Creating segment: $key"
  status=$(api_call POST "${BASE_URL}/segments/${PROJECT}/${env}" "$body")
  case "$status" in
    201) echo "HTTP 201" ;;
    409) echo "  (already exists)" ;;
    *) echo "HTTP $status"; record_err "segment-create" "$key [$env]: HTTP $status" ;;
  esac
}

patch_segment_rules() {
  local env=$1 key=$2 rules_json=$3 status
  echo "  [$env] Patching segment $key with rules"
  status=$(api_call PATCH "${BASE_URL}/segments/${PROJECT}/${env}/${key}" "[{\"op\":\"replace\",\"path\":\"/rules\",\"value\":${rules_json}}]")
  echo "HTTP $status"
  case "$status" in 200) ;; *) record_err "segment-patch-rules" "$key [$env]: HTTP $status" ;; esac
}

patch_segment_included() {
  local env=$1 key=$2 included_json=$3 status
  echo "  [$env] Patching segment $key with included"
  status=$(api_call PATCH "${BASE_URL}/segments/${PROJECT}/${env}/${key}" "[{\"op\":\"replace\",\"path\":\"/included\",\"value\":${included_json}}]")
  echo "HTTP $status"
  case "$status" in 200) ;; *) record_err "segment-patch-included" "$key [$env]: HTTP $status" ;; esac
}

patch_segment_excluded() {
  local env=$1 key=$2 excluded_json=$3 status
  echo "  [$env] Patching segment $key with excluded"
  status=$(api_call PATCH "${BASE_URL}/segments/${PROJECT}/${env}/${key}" "[{\"op\":\"replace\",\"path\":\"/excluded\",\"value\":${excluded_json}}]")
  echo "HTTP $status"
  case "$status" in 200) ;; *) record_err "segment-patch-excluded" "$key [$env]: HTTP $status" ;; esac
}

create_flag() {
  local body=$1 key status
  key=$(echo "$body" | jq -r '.key')
  echo "Creating flag: $key"
  status=$(api_call POST "${BASE_URL}/flags/${PROJECT}" "$body")
  case "$status" in
    201) echo "HTTP 201" ;;
    409) echo "  (already exists)" ;;
    *) echo "HTTP $status"; record_err "flag-create" "$key: HTTP $status" ;;
  esac
}

patch_flag_env() {
  local flag_key=$1 env=$2 patch_json=$3 status
  echo "  Patching flag $flag_key environment $env"
  status=$(api_call PATCH "${BASE_URL}/flags/${PROJECT}/${flag_key}" "$patch_json")
  echo "HTTP $status"
  case "$status" in 200) ;; *) record_err "flag-patch" "$flag_key [$env]: HTTP $status" ;; esac
}

# Populate FLAG_V0, FLAG_V1, ... from flag (for idempotent rule building)
get_flag_var_ids() {
  local flag_key=$1
  api_call GET "${BASE_URL}/flags/${PROJECT}/${flag_key}?env=*" "" >/dev/null
  FLAG_V0=$(jq -r '.variations[0]._id // empty' /tmp/seed_resp.json)
  FLAG_V1=$(jq -r '.variations[1]._id // empty' /tmp/seed_resp.json)
  FLAG_V2=$(jq -r '.variations[2]._id // empty' /tmp/seed_resp.json)
  FLAG_V3=$(jq -r '.variations[3]._id // empty' /tmp/seed_resp.json)
  FLAG_V4=$(jq -r '.variations[4]._id // empty' /tmp/seed_resp.json)
}

# Replace entire rules array (idempotent). Fallback: clear then add each rule if replace returns 400.
set_flag_rules() {
  local flag_key=$1 env=$2 rules_json=$3 status
  echo "  Patching flag $flag_key environment $env"
  status=$(api_call PATCH "${BASE_URL}/flags/${PROJECT}/${flag_key}" "[{\"op\":\"replace\",\"path\":\"/environments/${env}/rules\",\"value\":${rules_json}}]")
  echo "HTTP $status"
  if [ "$status" = "200" ]; then
    : # success
  elif [ "$status" = "400" ]; then
    record_err "flag-patch" "$flag_key [$env]: HTTP 400"
    # Fallback: clear rules, then add each rule (some APIs reject bulk replace)
    echo "  Retrying with clear-then-add..."
    api_call PATCH "${BASE_URL}/flags/${PROJECT}/${flag_key}" "[{\"op\":\"replace\",\"path\":\"/environments/${env}/rules\",\"value\":[]}]" >/dev/null
    local count idx=0
    count=$(echo "$rules_json" | jq 'length')
    while [ "$idx" -lt "$count" ]; do
      local rule
      rule=$(echo "$rules_json" | jq -c ".[$idx]")
      status=$(api_call PATCH "${BASE_URL}/flags/${PROJECT}/${flag_key}" "[{\"op\":\"add\",\"path\":\"/environments/${env}/rules/-\",\"value\":${rule}}]")
      echo "HTTP $status (rule $((idx+1))/$count)"
      [ "$status" != "200" ] && record_err "flag-patch-add-rule" "$flag_key [$env] rule $((idx+1)): HTTP $status"
      idx=$((idx + 1))
    done
  else
    record_err "flag-patch" "$flag_key [$env]: HTTP $status"
  fi
}

add_rollout_fallthrough() {
  local flag_key=$1 env=$2
  patch_flag_env "$flag_key" "$env" '[{"op":"replace","path":"/environments/'"${env}"'/fallthrough","value":{"rollout":{"variations":[{"variation":0,"weight":50000},{"variation":1,"weight":25000},{"variation":2,"weight":25000}],"contextKind":"user"}}}]'
}

add_targets() {
  local flag_key=$1 env=$2 targets_json=$3
  patch_flag_env "$flag_key" "$env" "[{\"op\":\"replace\",\"path\":\"/environments/${env}/targets\",\"value\":${targets_json}}]"
}

add_context_targets() {
  local flag_key=$1 env=$2 context_targets_json=$3
  patch_flag_env "$flag_key" "$env" "[{\"op\":\"replace\",\"path\":\"/environments/${env}/contextTargets\",\"value\":${context_targets_json}}]"
}

add_prerequisite() {
  local flag_key=$1 env=$2 prereq_key=$3 prereq_variation=$4 status
  echo "  Adding prerequisite $prereq_key (variation $prereq_variation) to $flag_key [$env]"
  status=$(api_call PATCH "${BASE_URL}/flags/${PROJECT}/${flag_key}" "[{\"op\":\"replace\",\"path\":\"/environments/${env}/prerequisites\",\"value\":[{\"key\":\"${prereq_key}\",\"variation\":${prereq_variation}}]}]")
  echo "HTTP $status"
  case "$status" in 200) ;; *) record_err "flag-prereq" "$flag_key [$env]: HTTP $status" ;; esac
}

# --- 1. Segments (all types, per env) ---
sleep 1
echo "=== Segments (all types) ==="
for env in "${VALID_ENVS[@]}"; do
  create_segment "$env" "verify-seg-included" "Verify Segment Included" "Rule-based segment (key in list)"
  patch_segment_rules "$env" "verify-seg-included" '[{"clauses":[{"attribute":"key","op":"in","values":["verify-user-1","verify-user-2"],"contextKind":"user"}]}]'

  create_segment "$env" "verify-seg-multi-rules" "Verify Segment Multi Rules" "Segment with multiple rules"
  SEG_MULTI_RULES='[{"clauses":[{"attribute":"key","op":"in","values":["u1"],"contextKind":"user"}]},{"clauses":[{"attribute":"email","op":"endsWith","values":[".test@example.com"],"contextKind":"user"}]}]'
  patch_segment_rules "$env" "verify-seg-multi-rules" "$SEG_MULTI_RULES"

  create_segment "$env" "verify-seg-contexts" "Verify Segment Contexts" "Included context keys"
  patch_segment_included "$env" "verify-seg-contexts" '["verify-included-1","verify-included-2"]'

  create_segment "$env" "verify-seg-excluded" "Verify Segment Excluded" "Included + excluded context keys"
  patch_segment_included "$env" "verify-seg-excluded" '["verify-exc-a","verify-exc-b","verify-exc-c"]'
  patch_segment_excluded "$env" "verify-seg-excluded" '["verify-exc-a"]'
done

sleep 2
echo ""
echo "=== Flags (from data/seed/*.json) ==="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SEED_DIR="${REPO_ROOT}/data/seed"

if [ ! -d "$SEED_DIR" ]; then
  echo "Error: $SEED_DIR not found"
  exit 1
fi

for flag_file in "$SEED_DIR"/verify-*.json; do
  [ -f "$flag_file" ] || continue
  create_flag "$(cat "$flag_file")"
done

# Prefetch variation IDs once per flag (reduces API calls by ~2/3 in config phase)
sleep 2
echo ""
echo "=== Adding rules, targets, rollouts (all combinations per env) ==="
get_flag_var_ids "verify-boolean-simple"; BOOL_V0=$FLAG_V0
get_flag_var_ids "verify-string-three"; STR_V0=$FLAG_V0; STR_V1=$FLAG_V1
get_flag_var_ids "verify-number-multi"; NUM_V0=$FLAG_V0
get_flag_var_ids "verify-json-nested"; JSON_V0=$FLAG_V0
get_flag_var_ids "verify-multi-var-rules"; MULTI_V0=$FLAG_V0; MULTI_V1=$FLAG_V1; MULTI_V2=$FLAG_V2
get_flag_var_ids "verify-rollout-rule"; ROLLOUT_V0=$FLAG_V0
get_flag_var_ids "verify-targets-single"; TGT_SINGLE_V0=$FLAG_V0
get_flag_var_ids "verify-targets-many"; TGT_MANY_V0=$FLAG_V0; TGT_MANY_V1=$FLAG_V1
get_flag_var_ids "verify-context-targets"; CTX_V0=$FLAG_V0; CTX_V1=$FLAG_V1; CTX_V2=$FLAG_V2
get_flag_var_ids "verify-rule-rollout"; RULE_ROLL_V0=$FLAG_V0; RULE_ROLL_V1=$FLAG_V1; RULE_ROLL_V2=$FLAG_V2
get_flag_var_ids "verify-rules-and-targets"; RULES_TGT_V0=$FLAG_V0; RULES_TGT_V1=$FLAG_V1; RULES_TGT_V2=$FLAG_V2
get_flag_var_ids "verify-single-var"; SINGLE_V0=$FLAG_V0
get_flag_var_ids "verify-rule-value-replace"; REPLACE_V0=$FLAG_V0
get_flag_var_ids "verify-rule-value-remove"; REMOVE_V0=$FLAG_V0
get_flag_var_ids "verify-rule-value-replace-generic"; REPLACE_GEN_V0=$FLAG_V0

# Use "variation" (index) not "variationId" (UUID) - ld-stg JSON Patch expects fixed variation by index
for env in "${VALID_ENVS[@]}"; do
  # verify-boolean-simple: user-attr, segment-match, multi-clause (all var 0)
  if [ -n "$BOOL_V0" ]; then
    set_flag_rules "verify-boolean-simple" "$env" '[{"clauses":[{"attribute":"key","op":"in","values":["verify-user-1"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-included"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"key","op":"in","values":["multi-1"],"contextKind":"user"},{"attribute":"email","op":"endsWith","values":[".test@example.com"],"contextKind":"user"}],"variation":0}]'
  fi

  # verify-string-three: user-attr (0), segment-match (0,1,0)
  if [ -n "$STR_V0" ] && [ -n "$STR_V1" ]; then
    set_flag_rules "verify-string-three" "$env" '[{"clauses":[{"attribute":"key","op":"in","values":["str-user"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-included"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-multi-rules"],"contextKind":"user"}],"variation":1},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-contexts"],"contextKind":"user"}],"variation":0}]'
  fi

  # verify-number-multi, verify-json-nested: user-attr (0)
  if [ -n "$NUM_V0" ]; then
    set_flag_rules "verify-number-multi" "$env" '[{"clauses":[{"attribute":"key","op":"in","values":["num-user"],"contextKind":"user"}],"variation":0}]'
  fi

  if [ -n "$JSON_V0" ]; then
    set_flag_rules "verify-json-nested" "$env" '[{"clauses":[{"attribute":"key","op":"in","values":["json-user"],"contextKind":"user"}],"variation":0}]'
  fi

  # verify-multi-var-rules: user-attr (0,1,2), segment-match (0,1,2,0)
  if [ -n "$MULTI_V0" ] && [ -n "$MULTI_V1" ] && [ -n "$MULTI_V2" ]; then
    set_flag_rules "verify-multi-var-rules" "$env" '[{"clauses":[{"attribute":"key","op":"in","values":["r0"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"key","op":"in","values":["r1"],"contextKind":"user"}],"variation":1},{"clauses":[{"attribute":"key","op":"in","values":["r2"],"contextKind":"user"}],"variation":2},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-included"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-multi-rules"],"contextKind":"user"}],"variation":1},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-contexts"],"contextKind":"user"}],"variation":2},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-excluded"],"contextKind":"user"}],"variation":0}]'
  fi

  # verify-rollout-rule: user-attr, segment-match (both 0)
  if [ -n "$ROLLOUT_V0" ]; then
    set_flag_rules "verify-rollout-rule" "$env" '[{"clauses":[{"attribute":"key","op":"in","values":["rollout-user"],"contextKind":"user"}],"variation":0},{"clauses":[{"attribute":"segmentMatch","op":"segmentMatch","values":["verify-seg-included"],"contextKind":"user"}],"variation":0}]'
  fi

  add_rollout_fallthrough "verify-string-three" "$env"
  add_rollout_fallthrough "verify-multi-var-rules" "$env"
  add_rollout_fallthrough "verify-rollout-rule" "$env"

  if [ -n "$TGT_SINGLE_V0" ]; then
    add_targets "verify-targets-single" "$env" "[{\"values\":[\"verify-target-user-1\"],\"variationId\":\"${TGT_SINGLE_V0}\"}]"
  fi

  if [ -n "$TGT_MANY_V0" ] && [ -n "$TGT_MANY_V1" ]; then
    add_targets "verify-targets-many" "$env" "[{\"values\":[\"tm1\"],\"variationId\":\"${TGT_MANY_V0}\"},{\"values\":[\"tm2\"],\"variationId\":\"${TGT_MANY_V1}\"},{\"values\":[\"tm3\"],\"variationId\":\"${TGT_MANY_V0}\"}]"
  fi

  # verify-context-targets: contextTargets for account and org (covers non-user targeting)
  if [ -n "$CTX_V1" ] && [ -n "$CTX_V2" ]; then
    add_context_targets "verify-context-targets" "$env" "[{\"values\":[\"verify-acc-1\"],\"variationId\":\"${CTX_V1}\",\"contextKind\":\"account\"},{\"values\":[\"verify-org-1\"],\"variationId\":\"${CTX_V2}\",\"contextKind\":\"organization\"}]"
  fi

  # verify-rule-rollout: rule with percentage rollout (not just fallthrough)
  if [ -n "$RULE_ROLL_V0" ] && [ -n "$RULE_ROLL_V1" ]; then
    set_flag_rules "verify-rule-rollout" "$env" '[{"clauses":[{"attribute":"key","op":"in","values":["rule-roll-user"],"contextKind":"user"}],"rollout":{"variations":[{"variation":0,"weight":60000},{"variation":1,"weight":40000}],"contextKind":"user"}}]'
    add_rollout_fallthrough "verify-rule-rollout" "$env"
  fi

  # verify-rules-and-targets: BOTH rules AND targets
  if [ -n "$RULES_TGT_V0" ] && [ -n "$RULES_TGT_V1" ]; then
    set_flag_rules "verify-rules-and-targets" "$env" '[{"clauses":[{"attribute":"key","op":"in","values":["r-and-t-user"],"contextKind":"user"}],"variation":0}]'
    add_targets "verify-rules-and-targets" "$env" "[{\"values\":[\"r-and-t-target-1\"],\"variationId\":\"${RULES_TGT_V1}\"},{\"values\":[\"r-and-t-target-2\"],\"variationId\":\"${RULES_TGT_V0}\"}]"
  fi

  # verify-single-var: single variation only
  if [ -n "$SINGLE_V0" ]; then
    set_flag_rules "verify-single-var" "$env" '[{"clauses":[{"attribute":"key","op":"in","values":["single-var-user"],"contextKind":"user"}],"variation":0}]'
  fi

  # verify-prerequisite: per-env prerequisite (depends on verify-boolean-simple)
  add_prerequisite "verify-prerequisite" "$env" "verify-boolean-simple" "0"

  # verify-rule-value-replace: single-clause versionName rule (tests replace: 26.3.30 -> 1.0.0)
  if [ -n "$REPLACE_V0" ]; then
    set_flag_rules "verify-rule-value-replace" "$env" '[{"clauses":[{"attribute":"versionName","op":"semVerLessThan","values":["26.3.30"],"contextKind":"ld_application","negate":true}],"variation":0}]'
  fi

  # verify-rule-value-remove: two-clause rule (versionName + country) to test clause-level removal
  if [ -n "$REMOVE_V0" ]; then
    set_flag_rules "verify-rule-value-remove" "$env" '[{"clauses":[{"attribute":"versionName","op":"semVerLessThan","values":["99.0.0"],"contextKind":"ld_application","negate":true},{"attribute":"country","op":"in","values":["US"],"contextKind":"user"}],"variation":0}]'
  fi

  # verify-rule-value-replace-generic: generic value replacement (CVS -> Health100)
  if [ -n "$REPLACE_GEN_V0" ]; then
    set_flag_rules "verify-rule-value-replace-generic" "$env" '[{"clauses":[{"attribute":"company","op":"in","values":["CVS"],"contextKind":"user"}],"variation":0}]'
  fi
done

echo ""
echo "=== Done ==="
echo ""
VALID_CNT=${#VALID_ENVS[@]}
if [ "$ERR_COUNT" -gt 0 ]; then
  echo "Summary: ${ERR_COUNT} error(s) occurred (envs used: ${VALID_CNT}: ${VALID_ENVS[*]}). Sample:"
  echo "$ERR_LOG" | head -20
  echo ""
  echo "Created (partial): 4 segment types × ${VALID_CNT} envs; flags from data/seed; rules, targets, contextTargets, rollouts, prerequisites"
else
  echo "Created: 4 segment types × ${VALID_CNT} envs; flags from data/seed; rules (user-attr, segment-match × 4, multi-clause, rule-rollout), targets, contextTargets (account/org), rollouts, prerequisites, rules+targets, single-var"
fi
echo ""
echo "Next steps to verify branch fix:"
echo "  1. Extract: deno task source-from-ld -p $PROJECT --extract-segments"
echo "  2. Migrate: deno task migrate -p $PROJECT -d YOUR_DEST_PROJECT -e production,uat,test"
echo "     Or use workflow: deno run -A src/scripts/launchdarkly-migrations/workflow.ts -f examples/workflow-verify-branch-fix.yaml"
echo ""
echo "Tip: Set LD_DEST_PROJECT=ld-migration-scripts-dest to ensure the destination has production,uat,test before migrating."
echo ""
