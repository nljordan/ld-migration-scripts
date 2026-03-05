# LaunchDarkly Migration Guide: Extract, Migrate & Revert

This guide walks through the full process of **exporting** (extracting) data from a source LaunchDarkly project, **migrating** it to a destination project, and **reverting** a migration when needed. It also lists all YAML parameters you can change and when to use them.

---

## Table of contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Parameters to modify per YAML (before you run)](#parameters-to-modify-per-yaml-before-you-run)
4. [Phase 1: Extract (export)](#phase-1-extract-export)
5. [Phase 2: Migrate](#phase-2-migrate)
6. [Phase 3: Revert](#phase-3-revert)
7. [Include flags and other options](#include-flags-and-other-options)
8. [YAML parameters reference](#yaml-parameters-reference)
9. [Quick reference: which file to use](#quick-reference-which-file-to-use)

---

## Overview

The migration flow has three main steps:

| Step | What it does |
|------|----------------|
| **Extract (export)** | Reads flags, environments, and optionally segments from the **source** project and saves them under `data/launchdarkly-migrations/source/`. |
| **Map members** | (Optional) Builds a mapping of source account members to destination account members so migrated flags can keep maintainer assignments. |
| **Migrate** | Creates (or updates) flags, environments, and segments in the **destination** project using the extracted data. |

**Revert** undoes a migration: it finds the migrated flags in the destination (using extracted source data), archives and deletes them, and optionally cleans up views.

You can run these steps via:

- **Workflow** (recommended): one command runs multiple steps from a single YAML config.
- **Individual tasks**: run extract, map-members, or migrate separately with their own config/CLI args.

---

## Prerequisites

- **Deno** installed.
- **API access**: destination project API token (and source token if extract and destination are in different accounts). Configure in `config/api_keys.json` or via environment (see README).

---

## Parameters to modify per YAML (before you run)

For each workflow or config file, change these parameters **before** running the step. Required items must be set; optional items depend on your setup.

### `examples/workflow-full.yaml` (full migration: extract → map-members → migrate)

| Parameter | What to set |
|-----------|-------------|
| `source.projectKey` | Your source LaunchDarkly project key. |
| `source.domain` | e.g. `app.launchdarkly.com` or `app.eu.launchdarkly.com`. |
| `destination.projectKey` | Your destination project key. |
| `destination.domain` | Destination LaunchDarkly domain. |
| `memberMapping.outputFile` | Path for member mapping file; required if `migration.assignMaintainerIds: true`. |
| `migration.assignMaintainerIds` | `true` only if you want maintainer mapping (map-members step runs first). |
| `migration.migrateSegments` | `true` only if you set `extraction.includeSegments: true`. |
| `migration.includeFlags` | List of flag keys to migrate; omit or comment out to migrate all. |
| `migration.environments` | List of env keys to migrate; omit to migrate all. |
| `migration.environmentMapping` | Only if source and destination use different env names. |
| `extraction.includeSegments` | `true` if you will migrate segments (uncomment the block). |

### `examples/workflow-extract-migrate-incremental.yaml` (extract + migrate, incremental sync)

| Parameter | What to set |
|-----------|-------------|
| `source.projectKey` | Your source LaunchDarkly project key. |
| `source.domain` | e.g. `app.launchdarkly.com`. |
| `destination.projectKey` | Your destination project key. |
| `destination.domain` | Destination domain. |
| `extraction.includeSegments` | `true` only if `migration.migrateSegments: true`. |
| `migration.migrateSegments` | `true` if you want segments migrated. |
| `migration.assignMaintainerIds` | Usually `false` (no map-members step). |
| `migration.incremental` | Keep `true` for incremental sync. |
| `migration.includeFlags` | List of flag keys to migrate; omit to migrate all. |
| Do not set `migration.conflictPrefix` | Would create new flags each run instead of updating. |

### `examples/workflow-migrate-only.yaml` (migrate only; extract already done)

| Parameter | What to set |
|-----------|-------------|
| `source.projectKey` | Source project key (must match the project you extracted). |
| `destination.projectKey` | Destination project key. |
| `source.domain` / `destination.domain` | Domains if not default. |
| `migration.assignMaintainerIds` | `true` only if you have run map-members and have a mapping file. |
| `migration.migrateSegments` | `true` only if segments were extracted. |
| `migration.includeFlags` | List of flag keys; omit to migrate all. |
| `migration.environments` | List of env keys; omit to migrate all. |
| `migration.environmentMapping` | Only if env keys differ between source and destination. |
| `migration.conflictPrefix` | Only for initial full migration when keys collide; do not use with incremental. |
| `migration.targetView` | View to link migrated flags to. |

### `examples/revert-migration-example.yaml` (revert only)

| Parameter | What to set |
|-----------|-------------|
| `source.projectKey` | Source project key (same as the migration you are reverting). |
| `destination.projectKey` | Destination project key (flags will be deleted here). |
| `source.domain` / `destination.domain` | Domains if not default. |
| `migration.targetView` | View key used during migration; uncomment if you used a target view. |
| CLI `--dry-run` | Use for preview; omit to execute revert. |

### `examples/workflow-revert-and-migrate.yaml` (revert then re-migrate)

| Parameter | What to set |
|-----------|-------------|
| `source.projectKey` | Same as the migration you are reverting. |
| `destination.projectKey` | Destination project (revert deletes flags here; migrate runs here). |
| `source.domain` / `destination.domain` | Domains if not default. |
| `revert.dryRun` | `true` to preview revert; set `false` to execute. |
| `migration.dryRun` | `true` to preview migrate; set `false` to execute. |
| `migration.includeFlags` | List of flag keys to re-migrate; omit to migrate all. |
| Other `migration.*` | Same as other migrate workflows (environments, targetView, etc.). |
| Do not set `migration.conflictPrefix` | If you use incremental or want to update existing flags. |

---

## Phase 1: Extract (export)

Extract reads the source project and writes flag and project data to disk. This data is used by both migrate and revert.

### What gets extracted

- Project metadata, environments, flag list, and each flag’s full configuration (rules, targets, etc.).
- Optionally: segments (if `extraction.includeSegments: true` and you plan to migrate segments).

### Commands

**Option A – Full workflow (extract + map-members + migrate)**  
Uses `workflow-full.yaml`. Extract runs as the first step.

```bash
deno task workflow -f examples/workflow-full.yaml
```

**Option B – Extract + migrate only (no member mapping)**  
Uses `workflow-extract-migrate-incremental.yaml`. Good for incremental syncs.

```bash
deno task workflow -f examples/workflow-extract-migrate-incremental.yaml
```

**Option C – Extract only**  
Use a workflow that only runs `extract-source`, or run the extract script directly (see README).

See [Parameters to modify per YAML](#parameters-to-modify-per-yaml-before-you-run) for extract parameters by workflow file.

---

## Phase 2: Migrate

Migrate reads the extracted data and creates (or updates) flags and optionally segments in the destination project.

### What migrate does

- Creates flags in the destination (or updates them if they already exist and you’re not using a conflict prefix).
- **Important:** Do **not** use `conflictPrefix` with incremental sync. With a prefix set, the script creates new prefixed flags instead of updating existing ones, so incremental runs would keep creating duplicates.
- Copies environments, rules, targets, and other flag settings.
- Can limit which flags and which environments are migrated (see [Include flags and other options](#include-flags-and-other-options)).
- Optionally links flags to a view, maps maintainers, and maps environment keys.

### Commands

**Full workflow (extract → map-members → migrate):**

```bash
deno task workflow -f examples/workflow-full.yaml
```

**Extract + migrate (incremental-friendly):**

```bash
deno task workflow -f examples/workflow-extract-migrate-incremental.yaml
```

**Migrate only** (assumes extract already done):

```bash
deno task workflow -f examples/workflow-migrate-only.yaml
```

Use **dry run first** when trying a new config: set `migration.dryRun: true` to preview, then set `dryRun: false` and run again to apply. See [Parameters to modify per YAML](#parameters-to-modify-per-yaml-before-you-run) for the full list of migration parameters.

---

## Phase 3: Revert

Revert removes migrated flags from the destination. It uses the same extracted source data to know which flags to remove (smart mode).

### What revert does

1. Identifies flags to revert (from source data or from flags in a target view).
2. Deletes pending approval requests for those flags.
3. Unlinks flags from the target view(s).
4. Archives and deletes the flags in the destination.
5. Optionally deletes the view(s).

### Commands

**Revert only (standalone):**

```bash
# Preview
deno task revert -f examples/revert-migration-example.yaml --dry-run

# Execute
deno task revert -f examples/revert-migration-example.yaml
```

**Revert then re-migrate (workflow):**

```bash
deno task workflow -f examples/workflow-revert-and-migrate.yaml
```

With the workflow, set `revert.dryRun` and `migration.dryRun` to `true` for a preview, then to `false` to execute.

### Parameters to set before revert

In the revert config (e.g. `revert-migration-example.yaml` or `workflow-revert-and-migrate.yaml`):

| Parameter | Where | Description |
|-----------|--------|-------------|
| `source.projectKey` | `source:` | Source project key (used to find which flags were migrated). **Required.** |
| `destination.projectKey` | `destination:` | Destination project (flags are deleted here). **Required.** |
| `source.domain` / `destination.domain` | `source:` / `destination:` | Domains. Optional. |
| `migration.targetView` | `migration:` | View key that was used during migration; revert will unlink flags from this view. Optional if using source-data smart mode. |
| `revert.dryRun` | `revert:` | `true` = preview only; `false` = execute. |
| `revert.deleteViews` | `revert:` | Set `true` to delete the target view(s) after unlinking. Optional. |
| `revert.viewKeys` | `revert:` | List of view keys to process. Optional; overrides using `migration.targetView`. |

Revert works best when the same source data used for migration is still present (same `source.projectKey` and extracted data). It then knows exactly which flags to remove.

---

## Include flags and other options

### Migrating only specific flags

Use `migration.includeFlags` in any workflow that runs the migrate step:

```yaml
migration:
  includeFlags:
    - config-welcome-message
    - my-feature-flag
```

- Only these flag keys are migrated (and they must exist in the extracted source).
- **Comment out or remove `includeFlags`** to migrate all extracted flags.

### Other useful migration options

- **Environments:** Migrate only certain environments:
  ```yaml
  migration:
    environments:
      - production
      - staging
  ```

- **Environment mapping:** Source and destination use different env names:
  ```yaml
  migration:
    environmentMapping:
      prod: production
      stg: staging
  ```

- **Conflict prefix:** When the same flag key exists in both projects, create a prefixed copy in destination. **Do not use with incremental sync**—it would create new prefixed flags instead of updating existing ones.
  ```yaml
  migration:
    conflictPrefix: "imported-"
  ```

- **Target view:** Group migrated flags in a view (helps with revert and organization):
  ```yaml
  migration:
    targetView: "migration-2024"
  ```

- **Incremental / since:** In workflows that support it, use `migration.incremental: true` to sync only changes, or `migration.since: "2025-01-15"` to sync only flags modified after that date.

---

## YAML parameters reference

Parameters you can change in the YAML files, grouped by section.

### Source and destination (all workflows)

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `source.projectKey` | Yes | Source LaunchDarkly project key | `Aman-Migration-Test` |
| `source.domain` | No | Source LaunchDarkly domain | `app.launchdarkly.com` |
| `destination.projectKey` | Yes | Destination project key | `aman-migration-2` |
| `destination.domain` | No | Destination domain | `app.launchdarkly.com` |

### Workflow steps (workflow files only)

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `workflow.steps` | No | Steps to run (default: extract, map-members, migrate) | `["extract-source", "migrate"]` |

### Extraction (when step extract-source is used)

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `extraction.includeSegments` | No | Extract segments (needed if you migrate segments) | `true` |

### Member mapping (when step map-members is used)

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `memberMapping.outputFile` | No | Path for member ID mapping file | `data/.../maintainer_mapping.json` |

### Migration (all workflows that run migrate)

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `migration.assignMaintainerIds` | No | Use member mapping for maintainers | `true` / `false` |
| `migration.migrateSegments` | No | Migrate segments | `true` / `false` |
| `migration.conflictPrefix` | No | Prefix for conflicting flag keys. **Do not use with incremental sync.** | `"imported-"` |
| `migration.targetView` | No | View to link migrated flags to | `"migration-2024"` |
| `migration.includeFlags` | No | Only migrate these flag keys (omit = all) | `["flag-a", "flag-b"]` |
| `migration.environments` | No | Only migrate these environments (omit = all) | `["production", "staging"]` |
| `migration.environmentMapping` | No | Source → destination env key map | `{ "prod": "production" }` |
| `migration.dryRun` | No | Preview only | `true` / `false` |
| `migration.incremental` | No | Sync only changes (uses manifest) | `true` / `false` |
| `migration.since` | No | Only flags modified after date (ISO 8601) | `"2025-01-15"` |

### Revert (revert workflow or revert config)

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `revert.dryRun` | No | Preview only | `true` / `false` |
| `revert.deleteViews` | No | Delete view(s) after unlinking flags | `true` / `false` |
| `revert.viewKeys` | No | View keys to process | `["migration-2024"]` |
| `migration.targetView` | No | View used during migration (for revert) | `"migration-2024"` |

---

## Quick reference: which file to use

| Goal | YAML file | Command |
|------|-----------|---------|
| Full migration (extract + map members + migrate) | `examples/workflow-full.yaml` | `deno task workflow -f examples/workflow-full.yaml` |
| Extract + migrate, incremental sync | `examples/workflow-extract-migrate-incremental.yaml` | `deno task workflow -f examples/workflow-extract-migrate-incremental.yaml` |
| Migrate only (extract already done) | `examples/workflow-migrate-only.yaml` | `deno task workflow -f examples/workflow-migrate-only.yaml` |
| Revert only | `examples/revert-migration-example.yaml` | `deno task revert -f examples/revert-migration-example.yaml` |
| Revert then re-migrate | `examples/workflow-revert-and-migrate.yaml` | `deno task workflow -f examples/workflow-revert-and-migrate.yaml` |

Before running, set at least:

- **Any workflow:** `source.projectKey`, `destination.projectKey` (and optionally domains).
- **Migrate:** Any of `includeFlags`, `environments`, `environmentMapping`, `conflictPrefix`, `targetView`, `dryRun` as needed.
- **Revert:** Same source/destination as the migration; set `revert.dryRun` (and optionally `migration.targetView`, `revert.viewKeys`, `revert.deleteViews`).

For more detail on CLI flags and advanced usage, see the main [README](../README.md).
