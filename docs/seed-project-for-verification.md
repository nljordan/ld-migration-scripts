# Pre-seeding a LaunchDarkly Project for Branch Verification

This guide explains how to pre-seed a LaunchDarkly project with comprehensive fixtures to verify the migration branch fixes (variation handling, rule clamping, env scoping, semantic patch fallback).

## Quick Start

**Option A – Full seed** (recommended; segments + flags from `data/seed/`):
```bash
export LD_API_KEY="your-launchdarkly-api-key"
export LD_PROJECT_KEY="your-source-project-key"
./scripts/seed-ld-project-for-verification.sh --config
```

**Option B – JSON-driven fixtures only** (flags from `data/seed/*.json`):
```bash
export LD_API_KEY="your-launchdarkly-api-key"
export LD_PROJECT_KEY="your-source-project-key"
./scripts/seed-ld-project-for-verification.sh
```

Both support `--config` to read the API key from `config/api_keys.json`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LD_API_KEY` | Yes* | - | LaunchDarkly API key (Admin or Writer role) |
| `LD_E2E_API_KEY` | Yes* | - | Alternative env var for API key |
| `LD_PROJECT_KEY` | Yes | - | Project key to seed |
| `LD_E2E_SOURCE_PROJECT` | Yes* | - | Alternative for project key |
| `LD_DOMAIN` | No | app.launchdarkly.com | LaunchDarkly domain |
| `LD_ENVS` | No | production,uat,test | Comma-separated env keys |
| `LD_DEST_PROJECT` | No | - | If set, ensures production,uat,test exist in this project (destination for workflow) |

\* Or use `--config` to read from `config/api_keys.json` (uses `source_account_api_key`).

## What Gets Created

### Segments (per environment)

- `verify-seg-included` – Rule-based segment (key in list)
- `verify-seg-multi-rules` – Multiple rules
- `verify-seg-contexts` – Included context keys

### Flags (from `data/seed/*.json`)

| Key | Purpose |
|-----|---------|
| `verify-boolean-simple` | Basic boolean flag |
| `verify-string-three` | 3 variations – tests rule clamping |
| `verify-number-multi` | Numeric variations |
| `verify-json-nested` | JSON object variations |
| `verify-multi-var-rules` | 5 variations, rules targeting different indices |
| `verify-targets-single` | Single individual target |
| `verify-targets-many` | Multiple individual targets |
| `verify-rollout-rule` | Percentage rollout in fallthrough |
| `verify-context-targets` | contextTargets for account and organization |
| `verify-rule-rollout` | Rule with percentage rollout (not just fallthrough) |
| `verify-prerequisite` | Depends on verify-boolean-simple |
| `verify-rules-and-targets` | Flag with BOTH rules and targets |
| `verify-single-var` | Single variation only |

### Per-environment config

- Rules with variation indices 0, 1, 2
- Segment-match rules
- Individual targets
- contextTargets (account, organization)
- Rule-level rollout
- Percentage rollout in fallthrough
- Prerequisites (per env)

## Verify the Branch Fix

1. **Pre-seed source project** (see Quick Start above).

2. **Update workflow config** – Edit `examples/workflow-verify-branch-fix.yaml`:
   - Set `source.projectKey` to your seeded project
   - Set `destination.projectKey` to your destination project

3. **Ensure `config/api_keys.json`** exists:
   ```json
   {
     "source_account_api_key": "your-api-key",
     "destination_account_api_key": "your-api-key"
   }
   ```

4. **Run the workflow**:
   ```bash
   deno run -A src/scripts/launchdarkly-migrations/workflow.ts -f examples/workflow-verify-branch-fix.yaml
   ```
   For full + incremental testing: [migration-test-walkthrough.md](migration-test-walkthrough.md)

5. **Check output** – Migration should:
   - Only update production, uat, test (not other envs)
   - Handle variation changes without "Unsupported json-patch operation"
   - Avoid "Rule refers to a variation that does not exist"
   - Apply flag-level and environment-level changes correctly

## Project Requirements

- The project must exist in LaunchDarkly.
- Environments (`production`, `uat`, `test` by default) are created by the script if they do not exist. Adjust `LD_ENVS` to control which envs are ensured (e.g. `LD_ENVS=production,uat,staging`).

## API Key Permissions

The API key needs:

- `Reader` – List projects, environments, flags, segments
- `Writer` – Create and update flags, segments

Use an Admin or custom role with these permissions.
