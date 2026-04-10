#!/usr/bin/env bash
# generate-migration-policy.sh
#
# Generates a LaunchDarkly custom role policy.json for ld-migration-scripts.
#
# Usage:
#   Variant A — specific source + one or more named destinations:
#     ./scripts/generate-migration-policy.sh --source <key> --dest <key> [--dest <key> ...]
#
#   Variant B — specific source + wildcard (all projects):
#     ./scripts/generate-migration-policy.sh --source <key> --wildcard
#
#   Override output path (default: ./policy.json):
#     ./scripts/generate-migration-policy.sh --source <key> --dest <key> --output /path/to/file.json

set -euo pipefail

SOURCE_PROJECT=""
DEST_PROJECTS=()
WILDCARD=false
OUTPUT="policy.json"

usage() {
  echo "Usage:"
  echo "  $0 --source <project-key> --dest <project-key> [--dest <project-key> ...] [--output file.json]"
  echo "  $0 --source <project-key> --wildcard [--output file.json]"
  exit 1
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_PROJECT="$2"; shift 2 ;;
    --dest)
      DEST_PROJECTS+=("$2"); shift 2 ;;
    --wildcard)
      WILDCARD=true; shift ;;
    --output)
      OUTPUT="$2"; shift 2 ;;
    -h|--help)
      usage ;;
    *)
      echo "Unknown argument: $1"; usage ;;
  esac
done

if [[ -z "$SOURCE_PROJECT" ]]; then
  echo "Error: --source is required." >&2
  usage
fi

if [[ "$WILDCARD" == false && ${#DEST_PROJECTS[@]} -eq 0 ]]; then
  echo "Error: provide at least one --dest <key> or use --wildcard." >&2
  usage
fi

if [[ "$WILDCARD" == true && ${#DEST_PROJECTS[@]} -gt 0 ]]; then
  echo "Error: --wildcard and --dest are mutually exclusive." >&2
  usage
fi

# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------

# Emit the three read-only source statements
source_read_statements() {
  local src="$1"
  cat <<EOF
  {
    "resources": [
      "proj/${src}"
    ],
    "actions": [
      "viewProject"
    ],
    "effect": "allow"
  },
  {
    "resources": [
      "proj/${src}:env/*:flag/*"
    ],
    "actions": [
      "viewFlag"
    ],
    "effect": "allow"
  },
  {
    "resources": [
      "proj/${src}:env/*:segment/*"
    ],
    "actions": [
      "viewSegment"
    ],
    "effect": "allow"
  }
EOF
}

# Emit viewProject + flag write + segment write for a given resource prefix
# $1 = resource prefix, e.g. "proj/my-project" or "proj/*"
dest_write_statements() {
  local prefix="$1"
  cat <<EOF
  {
    "resources": [
      "${prefix}"
    ],
    "actions": [
      "viewProject",
      "createProject",
      "createEnvironment"
    ],
    "effect": "allow"
  },
  {
    "resources": [
      "${prefix}:env/*:flag/*"
    ],
    "actions": [
      "createFlag",
      "updateName",
      "updateOn",
      "updateDescription",
      "updateIncludeInSnippet",
      "updateClientSideFlagAvailability",
      "updateTemporary",
      "updateTags",
      "updateDeprecated",
      "updatePrerequisites",
      "updateTargets",
      "updateRules",
      "updateFlagRuleDescription",
      "updateFallthrough",
      "updateFlagVariations",
      "updateFlagDefaultVariations",
      "updateOffVariation",
      "updateMaintainer",
      "updateAttachedGoals",
      "updateExperimentActive",
      "updateExperimentBaseline",
      "updateFlagCustomProperties",
      "updateFlagSalt",
      "updateTrackEvents",
      "updateFlagFallthroughTrackEvents",
      "updateGlobalArchived",
      "updateExpiringTargets",
      "updateFeatureWorkflows",
      "updateScheduledChanges",
      "updateTriggers",
      "updateApprovalRequest",
      "updateFlagLink",
      "updateFlagCodeReferences",
      "updateReleasePhaseCompleted",
      "updateReleasePhaseStatus",
      "updateFlagConfigMigrationSettings",
      "updateMeasuredRolloutConfiguration",
      "updateFallthroughWithMeasuredRollout",
      "updateRulesWithMeasuredRollout",
      "createExperiment",
      "createTriggers",
      "createApprovalRequest",
      "createFlagLink",
      "deleteFlag",
      "deleteFlagLink",
      "deleteTriggers",
      "removeReleasePipeline",
      "deleteFlagAttachedGoalResults"
    ],
    "effect": "allow"
  },
  {
    "resources": [
      "${prefix}:env/*:segment/*"
    ],
    "actions": [
      "createSegment",
      "updateName",
      "updateDescription",
      "updateTags",
      "updateIncluded",
      "createApprovalRequest",
      "updateExcluded",
      "updateRules",
      "updateExpiringTargets",
      "updateScheduledChanges",
      "createSegmentExport",
      "deleteSegment"
    ],
    "effect": "allow"
  }
EOF
}

# ---------------------------------------------------------------------------
# Build policy
# ---------------------------------------------------------------------------
{
  echo "["

  # Source read-only statements (always present)
  source_read_statements "$SOURCE_PROJECT"

  if [[ "$WILDCARD" == true ]]; then
    echo ","
    dest_write_statements "proj/*"
  else
    for proj in "${DEST_PROJECTS[@]}"; do
      echo ","
      dest_write_statements "proj/${proj}"
    done
  fi

  echo "]"
} > "$OUTPUT"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "Policy written to: $OUTPUT"
echo ""

if [[ "$WILDCARD" == true ]]; then
  echo "  Variant B (wildcard)"
  echo "  Source (read-only): ${SOURCE_PROJECT}"
  echo "  Destinations:       proj/* (all projects)"
else
  echo "  Variant A (named projects)"
  echo "  Source (read-only): ${SOURCE_PROJECT}"
  echo "  Destinations:       ${DEST_PROJECTS[*]}"
fi

echo ""
echo "Paste the contents of ${OUTPUT} into the LaunchDarkly custom role Advanced editor."
echo "  Account settings → Team → Roles → <role name> → Advanced editor"
