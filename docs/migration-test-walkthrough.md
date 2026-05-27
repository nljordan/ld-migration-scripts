# Migration Test Walkthrough

Step-by-step guide to test migration from `njordan-ld-migration-scripts-source` to `ld-migration-scripts-dest`, including incremental sync and change detection.

## Prerequisites

- [ ] Source project `njordan-ld-migration-scripts-source` exists in LaunchDarkly (ld-stg)
- [ ] Destination project `ld-migration-scripts-dest` exists
- [ ] `config/api_keys.json` has `source_account_api_key` and `destination_account_api_key`
- [ ] Seed script run to create verify flags and ensure envs (production, uat, test)

## Step 0: Seed and ensure environments

```bash
LD_PROJECT_KEY=njordan-ld-migration-scripts-source \
LD_DOMAIN=ld-stg.launchdarkly.com \
LD_DEST_PROJECT=ld-migration-scripts-dest \
./scripts/seed-ld-project-for-verification.sh --config
```

Verify: production, uat, test exist in both projects; 13 verify flags created.

---

## Step 1: Full migration (creates sync manifest)

```bash
deno task workflow -f examples/workflow-nljordan-full.yaml
```

**Verify:**

- No errors; flags and segments created in `ld-migration-scripts-dest`
- Sync manifest: `data/launchdarkly-migrations/sync-manifest-njordan-ld-migration-scripts-source-ld-migration-scripts-dest.json`
- All 13 verify flags in dest with rules, targets, etc.

---

## Step 2: Incremental with no changes (should skip all)

```bash
deno task workflow -f examples/workflow-nljordan-incremental.yaml
```

**Verify:** Output shows "Incremental sync: skipped N flag(s), M environment(s) as unchanged"

---

## Step 3: Change flags on source (REQUIRED before incremental test)

Updates 4 flags across 3 envs to trigger version bumps:

```bash
LD_PROJECT_KEY=njordan-ld-migration-scripts-source \
LD_DOMAIN=ld-stg.launchdarkly.com \
./scripts/update-source-flags-for-incremental-test.sh --config
```

**What it changes:**

| Flag | Env | Change |
|------|-----|--------|
| verify-boolean-simple | production | Add rule for "incremental-test-user" |
| verify-string-three | production | Add rule for "incremental-str-user" |
| verify-targets-single | production | Add second target |
| verify-multi-var-rules | test | Change fallthrough to 40/30/30 |

**Verify:** HTTP 200 for each PATCH

---

## Step 4: Re-extract source data

```bash
deno task source-from-ld -p njordan-ld-migration-scripts-source --extract-segments=true
```

**Verify:** Extract completes; flag JSON files in `data/launchdarkly-migrations/source/project/njordan-ld-migration-scripts-source/flags/` reflect changes

---

## Step 5: Incremental migration (validates change detection)

```bash
deno task workflow -f examples/workflow-nljordan-incremental.yaml
```

**Verify:**

- Only the 4 modified flag+env combinations patched (others skipped)
- Output shows specific flags updated, others "unchanged, skipping"
- Sync manifest updated

---

## Step 6: Verify destination matches source

- LD UI: compare flags between source and dest
- Or: `deno task diff` with SDK keys for both projects

---

## Quick reference

| Step | Command |
|------|---------|
| 0 | `LD_PROJECT_KEY=... LD_DEST_PROJECT=... ./scripts/seed-ld-project-for-verification.sh --config` |
| 1 | `deno task workflow -f examples/workflow-nljordan-full.yaml` |
| 2 | `deno task workflow -f examples/workflow-nljordan-incremental.yaml` |
| 3 | `LD_PROJECT_KEY=... LD_DOMAIN=ld-stg... ./scripts/update-source-flags-for-incremental-test.sh --config` |
| 4 | `deno task source-from-ld -p njordan-ld-migration-scripts-source --extract-segments=true` |
| 5 | `deno task workflow -f examples/workflow-nljordan-incremental.yaml` |

## Files

- `examples/workflow-nljordan-full.yaml` - Full sync
- `examples/workflow-nljordan-incremental.yaml` - Incremental sync
- `scripts/update-source-flags-for-incremental-test.sh` - Update 4 flags on source
