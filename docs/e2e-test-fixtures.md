# E2E Test Fixtures

This document describes the LaunchDarkly flags and segments used to test migration coverage. Use the `scripts/create-e2e-fixtures.sh` script to create these fixtures via the LaunchDarkly API.

## Overview

The fixture set covers all flag kinds, variation types, segment types, targeting rules, and individual targets supported by the migration scripts. Create these in a dedicated test project (e.g. `LD_E2E_SOURCE_PROJECT`) before running E2E migrations.

## Coverage Matrix

### Flag Kinds (4 types)

| Kind | Description | Migration Support |
|------|-------------|-------------------|
| `boolean` | true/false | Yes |
| `string` | Text values | Yes |
| `number` | Numeric values | Yes |
| `json` | JSON objects or arrays | Yes |

### Variation Types

| Type | Example | Flag Key |
|------|---------|----------|
| Boolean | `true`, `false` | `e2e-boolean-simple` |
| String | `"a"`, `"b"`, `"c"` | `e2e-string-multi` |
| Number | `0`, `1`, `5`, `10` | `e2e-number-multi` |
| JSON object | `{"enabled": true, "config": {...}}` | `e2e-json-nested` |
| JSON array | `[1, 2, 3]`, `[4, 5, 6]` | `e2e-json-array` |

### Segment Types

| Type | Description | Migration Support |
|------|-------------|-------------------|
| Rule-based (included rules) | Rules with clauses | Yes |
| Included contexts | User/context keys | Yes |
| Excluded contexts | Excluded keys | Yes |
| Unbounded (big segments) | Synced from external store | No (skipped) |

### Targeting Rule Types (per environment)

| Type | Clause Operator | Purpose |
|------|------------------|---------|
| User attribute | `in` | Match key/email in list |
| String operator | `endsWith`, `contains` | Match attribute patterns |
| Segment match | `segmentMatch` | Context in segment |
| Multiple clauses | AND | Rule with 2+ conditions |
| Multiple rules | OR | 2+ rules on same flag |

## Fixture Catalog

### Segments (create first)

| Key | Type | Purpose |
|-----|------|---------|
| `e2e-seg-included` | Rule-based | Single rule, user attribute clause |
| `e2e-seg-multi-rules` | Rule-based | Multiple rules |
| `e2e-seg-included-contexts` | Included contexts | Explicit user keys |

### Flags by Kind

#### Boolean

| Key | Variations | Defaults | Purpose |
|-----|-------------|----------|---------|
| `e2e-boolean-simple` | `[true, false]` | on=0, off=1 | Basic boolean |
| `e2e-boolean-off-nonzero` | `[true, false]` | on=0, off=0 | offVariation != 0 |

#### String

| Key | Variations | Purpose |
|-----|-------------|---------|
| `e2e-string-multi` | `["a", "b", "c"]` | 3+ string variations |
| `e2e-string-five` | `["v1","v2","v3","v4","v5"]` | 5 variations |

#### Number

| Key | Variations | Purpose |
|-----|-------------|---------|
| `e2e-number-multi` | `[0, 1, 5, 10]` | Multiple numeric variations |
| `e2e-number-ten` | `[0,1,2,3,4,5,6,7,8,9]` | 10 variations (stress) |

#### JSON

| Key | Variations | Purpose |
|-----|-------------|---------|
| `e2e-json-nested` | `[{"enabled":true,"config":{"timeout":5000}}, {"enabled":false}]` | Nested object |
| `e2e-json-array` | `[[1,2,3], [4,5,6]]` | JSON array variations |

### Flags with Targeting

| Key | Rules | Targets | Purpose |
|-----|-------|---------|---------|
| `e2e-rule-user-attr` | key in ["user-1","user-2"] | — | User attribute clause |
| `e2e-rule-segment` | segmentMatch e2e-seg-included | — | Segment-based rule |
| `e2e-rule-multi-clause` | 2 clauses (AND) | — | Multiple clauses |
| `e2e-rule-multi-rules` | 3 rules (OR) | — | Multiple rules |
| `e2e-targets-single` | — | 1 target | Individual target |
| `e2e-targets-many` | — | 5 targets | Many targets |

### Flags with Metadata

| Key | Tags | Custom Properties | Purpose |
|-----|------|-------------------|---------|
| `e2e-tags-many` | 5+ tags | — | Tag migration |
| `e2e-custom-props` | — | plan, region | Custom properties |
| `e2e-description-long` | — | — | Long description |

## Creation Order

1. **Segments** – Create `e2e-seg-included`, `e2e-seg-multi-rules`, `e2e-seg-included-contexts`
2. **Flags (no rules)** – Create all flags; rules/targets added via PATCH
3. **Flag rules/targets** – PATCH each flag's environment config

## Running the Script

**Dependencies:** `curl`, `jq`

```bash
# Required: API key and project
export LD_API_KEY="your-api-key"
export LD_PROJECT_KEY="your-project-key"

# Optional: override defaults
export LD_DOMAIN="app.launchdarkly.com"   # or app.eu.launchdarkly.com
export LD_ENV="production"                 # environment for segments/flags

./scripts/create-e2e-fixtures.sh
```

The script uses `LD_API_KEY` or `LD_E2E_API_KEY`, and `LD_PROJECT_KEY` or `LD_E2E_SOURCE_PROJECT`. Run from the project root.

## API Reference

- **Create flag:** `POST https://{domain}/api/v2/flags/{projectKey}`
- **Patch flag:** `PATCH https://{domain}/api/v2/flags/{projectKey}/{flagKey}` (JSON Patch)
- **Create segment:** `POST https://{domain}/api/v2/segments/{projectKey}/{envKey}`
- **Patch segment:** `PATCH https://{domain}/api/v2/segments/{projectKey}/{envKey}/{segmentKey}` (JSON Patch)
