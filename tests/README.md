# Tests

Test layout follows [Deno testing best practices](https://docs.deno.com/examples/testing_tutorial/):

- **Unit tests** are co-located with source (e.g. `src/scripts/launchdarkly-migrations/workflow_helpers_test.ts` next to `workflow_helpers.ts`). They run with `deno task test` and require no external services.
- **E2E tests** live in `tests/e2e/` and run the real workflow against LaunchDarkly when `LD_E2E_API_KEY` is set. They always use `--dry-run` for every step that supports it (migrate, revert, third-party import), so no writes or deletes are made.

## Structure

```
tests/
├── README.md           # This file
├── fixtures/           # Shared test data (e.g. e2e_config.yaml)
└── e2e/                # End-to-end tests
    ├── README.md       # E2E env and run instructions
    ├── helpers.ts      # Shared helpers (prepareWorkflowConfig, runWorkflowWithConfig)
    ├── workflow_e2e_test.ts
    └── workflow_examples_e2e_test.ts
```

## Running tests

```bash
# All tests (unit + e2e; e2e are skipped without LD_E2E_API_KEY)
deno task test

# E2E only (with API key and project keys set)
export LD_E2E_API_KEY=your-key
export LD_E2E_SOURCE_PROJECT=your-source
export LD_E2E_DEST_PROJECT=your-dest
deno task test:e2e
```

## CI

- **Unit tests**: Run on every push/PR via `deno task test`.
- **E2E tests**: Run only when `LD_E2E_API_KEY` is configured; see `.github/workflows/ci.yml` and `tests/e2e/README.md`.
