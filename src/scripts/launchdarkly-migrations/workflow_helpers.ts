/**
 * Pure helpers for workflow config parsing and CLI arg building.
 * Used by workflow.ts and by unit tests.
 */

import { parse as parseYaml } from "https://deno.land/std@0.224.0/yaml/parse.ts";

export interface WorkflowConfig {
  workflow?: {
    steps?: string[];
  };
  source: {
    projectKey: string;
    domain?: string;
  };
  destination?: {
    projectKey: string;
    domain?: string;
  };
  extraction?: {
    includeSegments?: boolean;
  };
  memberMapping?: {
    outputFile?: string;
  };
  migration?: {
    assignMaintainerIds?: boolean;
    migrateSegments?: boolean;
    conflictPrefix?: string;
    targetView?: string;
    environments?: string[];
    environmentMapping?: Record<string, string>;
    dryRun?: boolean;
    incremental?: boolean;
    since?: string;
  };
  thirdPartyImport?: {
    inputFile: string;
    targetProject: string;
    dryRun?: boolean;
    upsert?: boolean;
    reportOutput?: string;
  };
  revert?: {
    dryRun?: boolean;
    deleteViews?: boolean;
    viewKeys?: string[];
  };
}

export const DEFAULT_WORKFLOW_STEPS = ["extract-source", "map-members", "migrate"] as const;

function buildBaseRunArgs(scriptPath: string, permissions: string[]): string[] {
  return ["run", ...permissions, scriptPath];
}

function addOptionalArg(args: string[], flag: string, value?: string): string[] {
  return value ? [...args, flag, value] : args;
}

function addBooleanFlag(args: string[], flag: string, condition?: boolean): string[] {
  return condition ? [...args, flag] : args;
}

function formatEnvMapping(mapping: Record<string, string>): string {
  return Object.entries(mapping)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

/**
 * Parses YAML content into WorkflowConfig (for tests; workflow.ts uses loadConfig from file).
 */
export function parseWorkflowConfig(content: string): WorkflowConfig {
  return parseYaml(content) as WorkflowConfig;
}

export function getWorkflowSteps(config: WorkflowConfig): string[] {
  return config.workflow?.steps ?? [...DEFAULT_WORKFLOW_STEPS];
}

export function buildExtractSourceArgs(config: WorkflowConfig): string[] {
  const baseArgs = buildBaseRunArgs(
    "src/scripts/launchdarkly-migrations/source_from_ld.ts",
    ["--allow-net", "--allow-read", "--allow-write"]
  );

  let args = [...baseArgs, "-p", config.source.projectKey];
  args = addOptionalArg(args, "--domain", config.source.domain);

  const shouldExtractSegments =
    config.extraction?.includeSegments === true ||
    config.migration?.migrateSegments === true;

  if (shouldExtractSegments) {
    args = [...args, "--extract-segments=true"];
  }

  return args;
}

export function buildMapMembersArgs(config: WorkflowConfig): string[] {
  const baseArgs = buildBaseRunArgs(
    "src/scripts/launchdarkly-migrations/map_members_between_ld_instances.ts",
    ["--allow-net", "--allow-read", "--allow-write"]
  );

  const withOutput = addOptionalArg(baseArgs, "-o", config.memberMapping?.outputFile);
  const withSourceDomain = addOptionalArg(withOutput, "--source-domain", config.source.domain);
  return addOptionalArg(withSourceDomain, "--dest-domain", config.destination?.domain);
}

export function buildMigrationArgs(config: WorkflowConfig): string[] {
  const migration = config.migration || {};
  let args: string[] = [];

  args = addBooleanFlag(args, "-m", migration.assignMaintainerIds);
  args = addBooleanFlag(args, "-s=false", migration.migrateSegments === false);
  args = addBooleanFlag(args, "--dry-run", migration.dryRun);
  args = addBooleanFlag(args, "--incremental", migration.incremental);
  args = addOptionalArg(args, "-c", migration.conflictPrefix);
  args = addOptionalArg(args, "-v", migration.targetView);
  args = addOptionalArg(args, "-e", migration.environments?.join(","));
  args = addOptionalArg(args, "--since", migration.since);

  if (migration.environmentMapping) {
    args = addOptionalArg(args, "--env-map", formatEnvMapping(migration.environmentMapping));
  }

  return args;
}

export function buildMigrateArgs(config: WorkflowConfig): string[] {
  if (!config.destination?.projectKey) {
    throw new Error("Destination project key is required for migration step");
  }

  const baseArgs = buildBaseRunArgs(
    "src/scripts/launchdarkly-migrations/migrate_between_ld_instances.ts",
    ["--allow-net", "--allow-read", "--allow-write"]
  );

  const withProjects = [
    ...baseArgs,
    "-p",
    config.source.projectKey,
    "-d",
    config.destination.projectKey,
  ];

  const withMigrationOpts = [...withProjects, ...buildMigrationArgs(config)];
  return addOptionalArg(withMigrationOpts, "--domain", config.destination?.domain);
}

export function buildThirdPartyImportArgs(config: WorkflowConfig): string[] {
  const importConfig = config.thirdPartyImport!;

  const baseArgs = buildBaseRunArgs(
    "src/scripts/third-party-migrations/import_flags_from_external.ts",
    ["--allow-net", "--allow-read", "--allow-write", "--allow-env"]
  );

  const withRequiredArgs = [
    ...baseArgs,
    "-f",
    importConfig.inputFile,
    "-p",
    importConfig.targetProject,
  ];

  const withDryRun = addBooleanFlag(withRequiredArgs, "-d", importConfig.dryRun);
  const withUpsert = addBooleanFlag(withDryRun, "-u", importConfig.upsert);
  const withOutput = addOptionalArg(withUpsert, "-o", importConfig.reportOutput);
  return addOptionalArg(withOutput, "--domain", config.destination?.domain);
}

export function buildRevertArgs(config: WorkflowConfig, configFilePath: string): string[] {
  const revertConfig = config.revert || {};

  const baseArgs = buildBaseRunArgs(
    "src/scripts/launchdarkly-migrations/revert_migration.ts",
    ["--allow-net", "--allow-read", "--allow-write"]
  );

  const withConfigFile = [...baseArgs, "-f", configFilePath];
  let args = addBooleanFlag(withConfigFile, "--dry-run", revertConfig.dryRun);
  args = addBooleanFlag(args, "--delete-views", revertConfig.deleteViews);

  if (revertConfig.viewKeys && revertConfig.viewKeys.length > 0) {
    args = addOptionalArg(args, "-v", revertConfig.viewKeys.join(","));
  }

  return args;
}
