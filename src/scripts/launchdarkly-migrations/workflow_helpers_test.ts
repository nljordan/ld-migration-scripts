/**
 * Unit tests for workflow config parsing and CLI arg building.
 * Co-located with workflow_helpers.ts per Deno testing best practices.
 * @see https://docs.deno.com/examples/testing_tutorial/
 */

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseWorkflowConfig,
  getWorkflowSteps,
  DEFAULT_WORKFLOW_STEPS,
  buildExtractSourceArgs,
  buildMapMembersArgs,
  buildMigrationArgs,
  buildMigrateArgs,
  buildThirdPartyImportArgs,
  buildRevertArgs,
} from "./workflow_helpers.ts";

const MINIMAL_YAML = `
source:
  projectKey: my-source
destination:
  projectKey: my-dest
`;

const FULL_YAML = `
workflow:
  steps:
    - extract-source
    - migrate
source:
  projectKey: src-proj
  domain: app.eu.launchdarkly.com
destination:
  projectKey: dest-proj
  domain: app.launchdarkly.com
extraction:
  includeSegments: true
migration:
  assignMaintainerIds: true
  migrateSegments: false
  dryRun: true
  incremental: true
  conflictPrefix: imported-
  targetView: my-view
  environments:
    - production
    - staging
  environmentMapping:
    prod: production
    dev: development
  since: "2026-01-15"
`;

Deno.test("workflow_helpers", async (t) => {
  await t.step("parseWorkflowConfig parses minimal YAML", () => {
    const config = parseWorkflowConfig(MINIMAL_YAML);
    assertEquals(config.source.projectKey, "my-source");
    assertEquals(config.destination?.projectKey, "my-dest");
  });

  await t.step("parseWorkflowConfig parses workflow.steps and domains", () => {
    const config = parseWorkflowConfig(FULL_YAML);
    assertEquals(config.workflow?.steps, ["extract-source", "migrate"]);
    assertEquals(config.source.domain, "app.eu.launchdarkly.com");
    assertEquals(config.destination?.domain, "app.launchdarkly.com");
  });

  await t.step("parseWorkflowConfig parses migration options", () => {
    const config = parseWorkflowConfig(FULL_YAML);
    assertEquals(config.migration?.dryRun, true);
    assertEquals(config.migration?.incremental, true);
    assertEquals(config.migration?.assignMaintainerIds, true);
    assertEquals(config.migration?.migrateSegments, false);
    assertEquals(config.migration?.conflictPrefix, "imported-");
    assertEquals(config.migration?.targetView, "my-view");
    assertEquals(config.migration?.environments, ["production", "staging"]);
    assertEquals(config.migration?.environmentMapping, {
      prod: "production",
      dev: "development",
    });
    assertEquals(config.migration?.since, "2026-01-15");
  });

  await t.step("getWorkflowSteps returns config steps when present", () => {
    const config = parseWorkflowConfig(FULL_YAML);
    assertEquals(getWorkflowSteps(config), ["extract-source", "migrate"]);
  });

  await t.step("getWorkflowSteps returns DEFAULT_WORKFLOW_STEPS when no steps", () => {
    const config = parseWorkflowConfig(MINIMAL_YAML);
    assertEquals(getWorkflowSteps(config), [...DEFAULT_WORKFLOW_STEPS]);
  });

  await t.step("buildExtractSourceArgs includes project and script path", () => {
    const config = parseWorkflowConfig(MINIMAL_YAML);
    const args = buildExtractSourceArgs(config);
    assertEquals(args.includes("-p"), true);
    assertEquals(args.includes("my-source"), true);
    assertEquals(
      args.includes("src/scripts/launchdarkly-migrations/source_from_ld.ts"),
      true
    );
  });

  await t.step("buildExtractSourceArgs adds extract-segments when migration or extraction include segments", () => {
    const config = parseWorkflowConfig(FULL_YAML);
    const args = buildExtractSourceArgs(config);
    assertEquals(args.includes("--extract-segments=true"), true);
  });

  await t.step("buildMigrateArgs includes dryRun and project keys when migration.dryRun is true", () => {
    const config = parseWorkflowConfig(FULL_YAML);
    const args = buildMigrateArgs(config);
    assertEquals(args.includes("--dry-run"), true);
    assertEquals(args.includes("-p"), true);
    assertEquals(args.includes("src-proj"), true);
    assertEquals(args.includes("-d"), true);
    assertEquals(args.includes("dest-proj"), true);
    assertEquals(args.includes("--env-map"), true);
  });

  await t.step("buildMigrateArgs throws when destination missing", async () => {
    const config = parseWorkflowConfig(`
source:
  projectKey: only-src
`);
    await assertRejects(
      () => Promise.resolve().then(() => buildMigrateArgs(config)),
      Error,
      "Destination project key is required"
    );
  });

  await t.step("buildMapMembersArgs includes optional source and dest domains", () => {
    const config = parseWorkflowConfig(FULL_YAML);
    const args = buildMapMembersArgs(config);
    assertEquals(args.includes("--source-domain"), true);
    assertEquals(args.includes("app.eu.launchdarkly.com"), true);
    assertEquals(args.includes("--dest-domain"), true);
  });

  await t.step("buildMigrationArgs produces expected flags for full config", () => {
    const config = parseWorkflowConfig(FULL_YAML);
    const args = buildMigrationArgs(config);
    assertEquals(args.includes("-m"), true);
    assertEquals(args.includes("-s=false"), true);
    assertEquals(args.includes("--dry-run"), true);
    assertEquals(args.includes("--incremental"), true);
    assertEquals(args.includes("-c"), true);
    assertEquals(args.includes("imported-"), true);
    assertEquals(args.includes("-v"), true);
    assertEquals(args.includes("my-view"), true);
    assertEquals(args.includes("-e"), true);
    assertEquals(args.includes("--since"), true);
  });

  await t.step("buildThirdPartyImportArgs includes input file, project, and dry-run", () => {
    const config = parseWorkflowConfig(`
source:
  projectKey: x
destination:
  projectKey: y
thirdPartyImport:
  inputFile: ./flags.json
  targetProject: target
  dryRun: true
`);
    const args = buildThirdPartyImportArgs(config);
    assertEquals(args.includes("-f"), true);
    assertEquals(args.includes("./flags.json"), true);
    assertEquals(args.includes("-p"), true);
    assertEquals(args.includes("target"), true);
    assertEquals(args.includes("-d"), true);
  });

  await t.step("buildRevertArgs includes config path and optional dry-run, delete-views, viewKeys", () => {
    const config = parseWorkflowConfig(`
source:
  projectKey: a
destination:
  projectKey: b
revert:
  dryRun: true
  deleteViews: true
  viewKeys:
    - v1
    - v2
`);
    const args = buildRevertArgs(config, "/path/to/config.yaml");
    assertEquals(args.includes("-f"), true);
    assertEquals(args.includes("/path/to/config.yaml"), true);
    assertEquals(args.includes("--dry-run"), true);
    assertEquals(args.includes("--delete-views"), true);
    assertEquals(args.includes("-v"), true);
    assertEquals(args.includes("v1,v2"), true);
  });
});
