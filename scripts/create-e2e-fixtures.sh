#!/usr/bin/env bash
# Create E2E test fixtures (flags and segments) in LaunchDarkly via API.
# Requires: LD_API_KEY or LD_E2E_API_KEY, LD_PROJECT_KEY or LD_E2E_SOURCE_PROJECT
# Optional: LD_DOMAIN (default: app.launchdarkly.com), LD_ENV (default: production)
# Depends: curl, jq

set -e

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

API_KEY="${LD_API_KEY:-$LD_E2E_API_KEY}"
PROJECT="${LD_PROJECT_KEY:-$LD_E2E_SOURCE_PROJECT}"
DOMAIN="${LD_DOMAIN:-app.launchdarkly.com}"
ENV="${LD_ENV:-production}"
BASE_URL="https://${DOMAIN}/api/v2"

if [ -z "$API_KEY" ]; then
  echo "Error: LD_API_KEY or LD_E2E_API_KEY must be set"
  exit 1
fi

if [ -z "$PROJECT" ]; then
  echo "Error: LD_PROJECT_KEY or LD_E2E_SOURCE_PROJECT must be set"
  exit 1
fi

echo "Creating E2E fixtures in project $PROJECT (env: $ENV)"
echo ""

# --- Segments ---
create_segment() {
  local key=$1
  local name=$2
  local desc=$3
  echo "Creating segment: $key"
  curl -s -X POST "${BASE_URL}/segments/${PROJECT}/${ENV}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"key\":\"${key}\",\"name\":\"${name}\",\"description\":\"${desc}\"}" \
    -w "\nHTTP %{http_code}\n" -o /dev/null || true
}

patch_segment_rules() {
  local key=$1
  local rules_json=$2
  echo "  Patching segment $key with rules"
  curl -s -X PATCH "${BASE_URL}/segments/${PROJECT}/${ENV}/${key}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "[{\"op\":\"replace\",\"path\":\"/rules\",\"value\":${rules_json}}]" \
    -w "\nHTTP %{http_code}\n" -o /dev/null || true
}

patch_segment_included() {
  local key=$1
  local included_json=$2
  echo "  Patching segment $key with included"
  curl -s -X PATCH "${BASE_URL}/segments/${PROJECT}/${ENV}/${key}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "[{\"op\":\"replace\",\"path\":\"/included\",\"value\":${included_json}}]" \
    -w "\nHTTP %{http_code}\n" -o /dev/null || true
}

# --- Flags ---
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
  local flag_key=$1
  local patch_json=$2
  echo "  Patching flag $flag_key environment $ENV"
  curl -s -X PATCH "${BASE_URL}/flags/${PROJECT}/${flag_key}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$patch_json" \
    -w "\nHTTP %{http_code}\n" -o /dev/null || true
}

# --- 1. Segments ---
echo "=== Segments ==="
create_segment "e2e-seg-included" "E2E Segment Included" "Rule-based segment for migration tests"
# Rule: key in ["e2e-user-1", "e2e-user-2"]
patch_segment_rules "e2e-seg-included" '[{"clauses":[{"attribute":"key","op":"in","values":["e2e-user-1","e2e-user-2"],"contextKind":"user"}]}]'

create_segment "e2e-seg-multi-rules" "E2E Segment Multi Rules" "Segment with multiple rules"
patch_segment_rules "e2e-seg-multi-rules" '[{"clauses":[{"attribute":"key","op":"in","values":["u1"],"contextKind":"user"}]},{"clauses":[{"attribute":"email","op":"endsWith","values":[".test@example.com"],"contextKind":"user"}]}]'

create_segment "e2e-seg-included-contexts" "E2E Segment Included Contexts" "Segment with included context keys"
patch_segment_included "e2e-seg-included-contexts" '["e2e-included-user-1","e2e-included-user-2"]'

# --- 2. Flags (all kinds) ---
echo ""
echo "=== Flags ==="

# Boolean
create_flag '{"key":"e2e-boolean-simple","name":"E2E Boolean Simple","description":"Basic boolean flag","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["e2e","boolean"]}'
create_flag '{"key":"e2e-boolean-off-nonzero","name":"E2E Boolean Off Nonzero","description":"offVariation=0","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":0},"tags":["e2e"]}'

# String
create_flag '{"key":"e2e-string-multi","name":"E2E String Multi","description":"3+ string variations","variations":[{"value":"a"},{"value":"b"},{"value":"c"}],"defaults":{"onVariation":0,"offVariation":2},"tags":["e2e","string"]}'
create_flag '{"key":"e2e-string-five","name":"E2E String Five","description":"5 variations","variations":[{"value":"v1"},{"value":"v2"},{"value":"v3"},{"value":"v4"},{"value":"v5"}],"defaults":{"onVariation":0,"offVariation":0},"tags":["e2e"]}'

# Number
create_flag '{"key":"e2e-number-multi","name":"E2E Number Multi","description":"Numeric variations","variations":[{"value":0},{"value":1},{"value":5},{"value":10}],"defaults":{"onVariation":2,"offVariation":0},"tags":["e2e","number"]}'
create_flag '{"key":"e2e-number-ten","name":"E2E Number Ten","description":"10 variations","variations":[{"value":0},{"value":1},{"value":2},{"value":3},{"value":4},{"value":5},{"value":6},{"value":7},{"value":8},{"value":9}],"defaults":{"onVariation":0,"offVariation":9},"tags":["e2e"]}'

# JSON
create_flag '{"key":"e2e-json-nested","name":"E2E JSON Nested","description":"Nested JSON object","variations":[{"value":{"enabled":true,"config":{"timeout":5000}}},{"value":{"enabled":false}}],"defaults":{"onVariation":0,"offVariation":1},"tags":["e2e","json"]}'
create_flag '{"key":"e2e-json-array","name":"E2E JSON Array","description":"JSON array variations","variations":[{"value":[1,2,3]},{"value":[4,5,6]}],"defaults":{"onVariation":0,"offVariation":1},"tags":["e2e"]}'

# Metadata
create_flag '{"key":"e2e-tags-many","name":"E2E Tags Many","description":"Flag with many tags","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["e2e","tag1","tag2","tag3","tag4","tag5"]}'
create_flag '{"key":"e2e-custom-props","name":"E2E Custom Properties","description":"Flag with custom properties","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"customProperties":{"plan":"pro","region":"us"}}'
create_flag '{"key":"e2e-description-long","name":"E2E Description Long","description":"This flag has a long description to test that descriptions are migrated correctly. It includes multiple sentences and various punctuation: commas, periods, and more. Used for E2E migration fixture coverage.","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["e2e"]}'

# Flags for rules/targets (need variation IDs from GET - we add rules after creation)
create_flag '{"key":"e2e-rule-user-attr","name":"E2E Rule User Attr","description":"User attribute rule","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["e2e"]}'
create_flag '{"key":"e2e-rule-segment","name":"E2E Rule Segment","description":"Segment match rule","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["e2e"]}'
create_flag '{"key":"e2e-rule-multi-clause","name":"E2E Rule Multi Clause","description":"Multiple clauses","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["e2e"]}'
create_flag '{"key":"e2e-rule-multi-rules","name":"E2E Rule Multi Rules","description":"Multiple rules","variations":[{"value":"a"},{"value":"b"},{"value":"c"}],"defaults":{"onVariation":0,"offVariation":0},"tags":["e2e"]}'
create_flag '{"key":"e2e-targets-single","name":"E2E Targets Single","description":"Single individual target","variations":[{"value":true},{"value":false}],"defaults":{"onVariation":0,"offVariation":1},"tags":["e2e"]}'
create_flag '{"key":"e2e-targets-many","name":"E2E Targets Many","description":"Many individual targets","variations":[{"value":1},{"value":2},{"value":3},{"value":4},{"value":5}],"defaults":{"onVariation":0,"offVariation":0},"tags":["e2e"]}'

# --- 3. Add rules and targets (requires variation IDs - fetch flag first) ---
echo ""
echo "=== Adding rules and targets ==="

add_rule_with_variation() {
  local flag_key=$1
  local clauses_json=$2
  local variation_idx=$3
  # Fetch flag to get variation ID
  local flag_json
  flag_json=$(curl -s -X GET "${BASE_URL}/flags/${PROJECT}/${flag_key}?env=*" -H "Authorization: ${API_KEY}")
  local var_id
  var_id=$(echo "$flag_json" | jq -r ".variations[${variation_idx}]._id")
  if [ -z "$var_id" ] || [ "$var_id" = "null" ]; then
    echo "  Warning: Could not get variation ID for $flag_key, skipping rule"
    return
  fi
  local patch="[{\"op\":\"add\",\"path\":\"/environments/${ENV}/rules/-\",\"value\":{\"clauses\":${clauses_json},\"variationId\":\"${var_id}\"}}]"
  patch_flag_env "$flag_key" "$patch"
}

# e2e-rule-user-attr: key in ["e2e-user-1","e2e-user-2"]
add_rule_with_variation "e2e-rule-user-attr" '[{"attribute":"key","op":"in","values":["e2e-user-1","e2e-user-2"],"contextKind":"user"}]' 0

# e2e-rule-segment: segmentMatch e2e-seg-included
add_rule_with_variation "e2e-rule-segment" '[{"attribute":"segmentMatch","op":"segmentMatch","values":["e2e-seg-included"]}]' 0

# e2e-rule-multi-clause: key in [...] AND email endsWith ...
add_rule_with_variation "e2e-rule-multi-clause" '[{"attribute":"key","op":"in","values":["multi-1"],"contextKind":"user"},{"attribute":"email","op":"endsWith","values":[".test@example.com"],"contextKind":"user"}]' 0

# e2e-rule-multi-rules: 3 separate rules
add_rule_with_variation "e2e-rule-multi-rules" '[{"attribute":"key","op":"in","values":["r1"],"contextKind":"user"}]' 0
add_rule_with_variation "e2e-rule-multi-rules" '[{"attribute":"key","op":"in","values":["r2"],"contextKind":"user"}]' 1
add_rule_with_variation "e2e-rule-multi-rules" '[{"attribute":"key","op":"in","values":["r3"],"contextKind":"user"}]' 2

# Individual targets
add_targets() {
  local flag_key=$1
  local targets_json=$2
  local patch="[{\"op\":\"replace\",\"path\":\"/environments/${ENV}/targets\",\"value\":${targets_json}}]"
  patch_flag_env "$flag_key" "$patch"
}

# e2e-targets-single: 1 target (fetch variation ID first)
TARGET_FLAG=$(curl -s -X GET "${BASE_URL}/flags/${PROJECT}/e2e-targets-single?env=*" -H "Authorization: ${API_KEY}")
TARGET_VAR_ID=$(echo "$TARGET_FLAG" | jq -r '.variations[0]._id')
add_targets "e2e-targets-single" "[{\"values\":[\"e2e-target-user-1\"],\"variationId\":\"${TARGET_VAR_ID}\"}]"

# e2e-targets-many: 5 targets
TARGETS_MANY_FLAG=$(curl -s -X GET "${BASE_URL}/flags/${PROJECT}/e2e-targets-many?env=*" -H "Authorization: ${API_KEY}")
TV0=$(echo "$TARGETS_MANY_FLAG" | jq -r '.variations[0]._id')
TV1=$(echo "$TARGETS_MANY_FLAG" | jq -r '.variations[1]._id')
add_targets "e2e-targets-many" "[{\"values\":[\"tm1\"],\"variationId\":\"${TV0}\"},{\"values\":[\"tm2\"],\"variationId\":\"${TV0}\"},{\"values\":[\"tm3\"],\"variationId\":\"${TV1}\"},{\"values\":[\"tm4\"],\"variationId\":\"${TV1}\"},{\"values\":[\"tm5\"],\"variationId\":\"${TV0}\"}]"

echo ""
echo "Done. Run extract + migrate to verify:"
echo "  deno task source-from-ld -p $PROJECT --extract-segments"
echo "  deno task migrate -p $PROJECT -d DEST_PROJECT -e $ENV"
