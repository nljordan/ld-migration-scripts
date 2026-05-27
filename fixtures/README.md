# Migration Fix Verification Fixtures

Flag definitions used to verify the migration branch fixes (Phase 1 env scoping, Phase 2 variation/rule handling).

**Primary source:** `data/seed/` (one JSON file per flag). Use `./scripts/seed-ld-project-for-verification.sh --config` for full seeding with segments, rules, targets, and rollouts.

## Quick Start

```bash
export LD_API_KEY="your-api-key"
export LD_PROJECT_KEY="your-source-project"

./scripts/seed-ld-project-for-verification.sh --config
# Or simpler: ./scripts/seed-from-verify-json.sh --config
```

## Coverage

| Flag | Phase 1 (env scoping) | Phase 2a (rule clamp) | Phase 2b (effective max) | Phase 2c (addVariation) | Phase 2e (targets remap) |
|------|------------------------|------------------------|---------------------------|--------------------------|---------------------------|
| verify-boolean-simple | ✓ | ✓ | ✓ | - | - |
| verify-string-three | ✓ | ✓ | ✓ | ✓* | - |
| verify-number-multi | ✓ | ✓ | ✓ | - | - |
| verify-multi-var-rules | ✓ | ✓ | ✓** | - | - |
| verify-targets-single | ✓ | - | - | - | ✓ |
| verify-targets-many | ✓ | - | - | - | ✓ |
| verify-rollout-rule | ✓ | ✓ | ✓ | - | - |
| verify-json-nested | ✓ | - | - | - | - |

\* Add 4th variation on source, migrate to existing dest with 3 variations  
\*\* Shrink: migrate source (5 vars) to dest that has 3 variations
