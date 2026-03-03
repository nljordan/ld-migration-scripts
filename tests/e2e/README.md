# E2E tests

E2E tests run the real workflow against LaunchDarkly when `LD_E2E_API_KEY` is set. **They always use `--dry-run`** for every step that supports it (migrate, revert, third-party import), so no data is written to or deleted from LaunchDarkly.

## Test files

- **helpers.ts** – Shared helpers: `prepareWorkflowConfig()` (injects project keys and forces dry-run for migration, revert, and third-party import), `runWorkflowWithConfig()`, `isE2EEnabled()`, `stdoutIndicatesSuccess()`.
- **workflow_e2e_test.ts** – Single workflow run using `tests/fixtures/e2e_config.yaml` (extract + migrate with dry-run).
- **workflow_examples_e2e_test.ts** – One test per `examples/workflow-*.yaml`; each config is prepared with env project keys and dry-run for all applicable steps, then the workflow is run.

## Required env (when not skipped)

- `LD_E2E_API_KEY` – API key used for both source and destination (write into `config/api_keys.json` in CI).
- `LD_E2E_SOURCE_PROJECT` (optional) – Source project key; default `e2e-source`.
- `LD_E2E_DEST_PROJECT` (optional) – Destination project key; default `e2e-dest`.

## CI

See `.github/workflows/ci.yml`: the e2e job runs only when `LD_E2E_API_KEY` is set and creates `config/api_keys.json` from it.

## Run locally

```bash
# With API key and project keys (uses examples from examples/)
export LD_E2E_API_KEY=your-key
export LD_E2E_SOURCE_PROJECT=your-source-project
export LD_E2E_DEST_PROJECT=your-dest-project
# Ensure config/api_keys.json has the same key for source and destination
deno task test:e2e
```

Without `LD_E2E_API_KEY`, all e2e tests are skipped (no API calls).
