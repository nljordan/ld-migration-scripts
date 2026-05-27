// deno-lint-ignore-file no-explicit-any
/**
 * LaunchDarkly Migration Workflow Orchestrator
 * 
 * Supports running complete migration workflows from a single YAML config file.
 * Default behavior: Runs full workflow (extract → map → migrate)
 */

import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import { parse as parseYaml } from "https://deno.land/std@0.224.0/yaml/parse.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import {
  applyCertificateErrorOverrides,
  buildDenoRunArgs,
  coerceProjectKey,
  normalizeWorkflowConfig,
  partitionWorkflowSteps,
  resolveProjectKeys,
  shouldIgnoreCertificateErrors,
  usesProjectKeysList,
  withProjectKey,
  type WorkflowConfig,
  type WorkflowStepName,
} from "../../utils/workflow_config.ts";

interface Arguments {
  config?: string;
  ignoreCertificateErrors?: boolean;
}

type StepName = WorkflowStepName;
type CommandOptions = { args: string[]; stdout: "inherit"; stderr: "inherit" };

// ==================== Configuration ====================

const DEFAULT_WORKFLOW_STEPS: StepName[] = ["extract-source", "map-members", "migrate"];

const inputArgs: Arguments = yargs(Deno.args)
  .alias("f", "config")
  .option("config", { type: "string", description: "Path to workflow configuration YAML file" })
  .option("ignore-certificate-errors", {
    type: "boolean",
    description:
      "Pass --unsafely-ignore-certificate-errors to all child Deno steps (same as workflow.ignoreCertificateErrors in YAML)",
  })
  .describe("f", "Path to workflow configuration YAML file")
  .parse() as Arguments;

// Allow positional YAML path: deno task workflow examples/workflow-full.yaml
const configPath = inputArgs.config ?? (Deno.args.length > 0 && !Deno.args[0].startsWith("-") && /\.(yaml|yml)$/i.test(Deno.args[0]) ? Deno.args[0] : undefined);
if (!configPath) {
  console.log(Colors.red("Error: No workflow config specified. Use -f <file> or pass the YAML file path."));
  console.log(Colors.gray("  deno task workflow -f examples/workflow-full.yaml"));
  console.log(Colors.gray("  deno task workflow examples/workflow-full.yaml"));
  Deno.exit(1);
}

// ==================== Config Loading ====================

/**
 * Loads and parses a YAML configuration file
 */
const loadConfig = async (configPath: string): Promise<WorkflowConfig> => {
  try {
    const configContent = await Deno.readTextFile(configPath);
    return normalizeWorkflowConfig(parseYaml(configContent) as WorkflowConfig);
  } catch (error) {
    console.log(Colors.red(
      `Error loading config file: ${error instanceof Error ? error.message : String(error)}`
    ));
    Deno.exit(1);
  }
};

// ==================== Command Execution ====================

/**
 * Creates command options for Deno subprocess
 */
const createCommandOptions = (args: string[]): CommandOptions => ({
  args,
  stdout: "inherit",
  stderr: "inherit"
});

/**
 * Executes a Deno command and handles errors
 */
const executeCommand = async (args: string[], stepName: string): Promise<void> => {
  console.log(Colors.gray(`Executing: deno ${args.join(' ')}\n`));

  const command = new Deno.Command("deno", createCommandOptions(args));
  const { code } = await command.output();

  if (code !== 0) {
    console.error(Colors.red(`\n❌ ${stepName} failed`));
    Deno.exit(1);
  }
};

/**
 * Prints step header
 */
const printStepHeader = (stepNumber: string, title: string): void => {
  const divider = "=".repeat(60);
  console.log(Colors.cyan(`\n${divider}`));
  console.log(Colors.cyan(`${stepNumber}: ${title}`));
  console.log(Colors.cyan(`${divider}\n`));
};

/**
 * Prints step completion
 */
const printStepCompletion = (message: string): void => {
  console.log(Colors.green(`\n✓ ${message}\n`));
};

// ==================== Step Builders ====================

/**
 * Conditionally adds arguments if value exists
 */
const addOptionalArg = (args: string[], flag: string, value?: string): string[] =>
  value ? [...args, flag, value] : args;

/**
 * Conditionally adds a boolean flag if true
 */
const addBooleanFlag = (args: string[], flag: string, condition?: boolean): string[] =>
  condition ? [...args, flag] : args;

// ==================== Extract Source Step ====================

/**
 * Builds arguments for extract source command
 */
const buildExtractSourceArgs = (config: WorkflowConfig): string[] => {
  const baseArgs = buildDenoRunArgs(
    "src/scripts/launchdarkly-migrations/source_from_ld.ts",
    ["--allow-net", "--allow-read", "--allow-write"],
    config
  );

  let args = [...baseArgs, "-p", coerceProjectKey(config.source.projectKey)!];
  args = addOptionalArg(args, "--domain", config.source.domain);
  
  // Only extract segments if explicitly enabled AND migration will use them
  const shouldExtractSegments = 
    config.extraction?.includeSegments === true || 
    config.migration?.migrateSegments === true;
  
  if (shouldExtractSegments) {
    args = [...args, "--extract-segments=true"];
  }
  
  return args;
};

/**
 * Runs the extract source data step
 */
const runExtractSource = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP 1", "Extract Source Project Data");
  const args = buildExtractSourceArgs(config);
  await executeCommand(args, "Extract source step");
  printStepCompletion("Source data extraction completed");
};

// ==================== Extract Account Step ====================

const buildExtractAccountArgs = (config: WorkflowConfig): string[] => {
  const account = config.accountMigration ?? {};
  const baseArgs = buildDenoRunArgs(
    "src/scripts/launchdarkly-migrations/extract_account_from_ld.ts",
    ["--allow-net", "--allow-read", "--allow-write"],
    config,
  );

  let args = addOptionalArg(baseArgs, "--domain", config.source.domain);
  if (account.includeRoles === false) {
    args = [...args, "--include-roles=false"];
  }
  if (account.includeTeams === false) {
    args = [...args, "--include-teams=false"];
  }
  return args;
};

const runExtractAccount = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP", "Extract Account IAM (Roles & Teams)");
  const args = buildExtractAccountArgs(config);
  await executeCommand(args, "Extract account step");
  printStepCompletion("Account IAM extraction completed");
};

// ==================== Map Members Step ====================

/**
 * Builds arguments for map members command
 */
const buildMapMembersArgs = (config: WorkflowConfig): string[] => {
  const baseArgs = buildDenoRunArgs(
    "src/scripts/launchdarkly-migrations/map_members_between_ld_instances.ts",
    ["--allow-net", "--allow-read", "--allow-write"],
    config
  );

  const withOutput = addOptionalArg(baseArgs, "-o", config.memberMapping?.outputFile);
  const withSourceDomain = addOptionalArg(withOutput, "--source-domain", config.source.domain);
  return addOptionalArg(withSourceDomain, "--dest-domain", config.destination?.domain);
};

/**
 * Runs the member mapping step
 */
const runMapMembers = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP 2", "Map Members Between Instances");
  const args = buildMapMembersArgs(config);
  await executeCommand(args, "Member mapping step");
  printStepCompletion("Member mapping completed");
};

// ==================== Migrate Roles Step ====================

const buildProjectKeyMapArg = (config: WorkflowConfig): string | undefined => {
  const explicit = config.accountMigration?.projectKeyMapping;
  const parts: string[] = [];
  if (explicit && Object.keys(explicit).length > 0) {
    parts.push(formatKeyValueMapping(explicit));
  }
  // Implicit single-pair mapping only when using one projectKey (not projectKeys list)
  if (!usesProjectKeysList(config)) {
    const src = coerceProjectKey(config.source.projectKey);
    const dest = coerceProjectKey(config.destination?.projectKey);
    if (src && dest && src !== dest) {
      const implicit = `${src}:${dest}`;
      if (!explicit?.[src]) parts.push(implicit);
    }
  } else if (!explicit || Object.keys(explicit).length === 0) {
    console.log(Colors.yellow(
      "Note: source.projectKeys is set — use accountMigration.projectKeyMapping for role policy proj/<key> remapping.",
    ));
  }
  return parts.length > 0 ? parts.join(",") : undefined;
};

const buildMigrateRolesArgs = (config: WorkflowConfig): string[] => {
  const account = config.accountMigration ?? {};
  const baseArgs = buildDenoRunArgs(
    "src/scripts/launchdarkly-migrations/migrate_custom_roles.ts",
    ["--allow-net", "--allow-read", "--allow-write"],
    config,
  );

  let args = addOptionalArg(baseArgs, "--domain", config.destination?.domain);
  args = addOptionalArg(args, "--project-key-map", buildProjectKeyMapArg(config));
  args = addOptionalArg(args, "--source-project", coerceProjectKey(config.source.projectKey));
  args = addOptionalArg(args, "--dest-project", coerceProjectKey(config.destination?.projectKey));
  args = addBooleanFlag(args, "--dry-run", accountMigrationDryRun(config));
  args = addOptionalArg(args, "--conflict-prefix", account.conflictPrefix);
  args = addOptionalArg(
    args,
    "--include-roles",
    account.includeRolesKeys?.length ? account.includeRolesKeys.join(",") : undefined,
  );
  args = addOptionalArg(
    args,
    "--exclude-roles",
    account.excludeRolesKeys?.length ? account.excludeRolesKeys.join(",") : undefined,
  );
  return args;
};

const runMigrateRoles = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP", "Migrate Custom Roles");
  const args = buildMigrateRolesArgs(config);
  await executeCommand(args, "Migrate roles step");
  printStepCompletion("Custom roles migration completed");
};

// ==================== Migrate Teams Step ====================

const buildMigrateTeamsArgs = (
  config: WorkflowConfig,
  stepsInRun: string[],
): string[] => {
  const account = config.accountMigration ?? {};
  const baseArgs = buildDenoRunArgs(
    "src/scripts/launchdarkly-migrations/migrate_teams.ts",
    ["--allow-net", "--allow-read", "--allow-write"],
    config,
  );

  let args = addOptionalArg(baseArgs, "--domain", config.destination?.domain);
  args = addOptionalArg(args, "--source-domain", config.source.domain);
  args = addOptionalArg(args, "--member-mapping", config.memberMapping?.outputFile);
  args = addBooleanFlag(args, "--dry-run", accountMigrationDryRun(config));
  args = addOptionalArg(args, "--conflict-prefix", account.conflictPrefix);
  args = addOptionalArg(
    args,
    "--include-teams",
    account.includeTeamsKeys?.length ? account.includeTeamsKeys.join(",") : undefined,
  );
  args = addOptionalArg(
    args,
    "--exclude-teams",
    account.excludeTeamsKeys?.length ? account.excludeTeamsKeys.join(",") : undefined,
  );

  if (!stepsInRun.includes("map-members")) {
    console.log(Colors.yellow(
      "Note: map-members was not in this workflow run. Ensure maintainer_mapping.json exists and is current.",
    ));
  }
  return args;
};

const runMigrateTeams = async (
  config: WorkflowConfig,
  stepsInRun: string[],
): Promise<void> => {
  printStepHeader("STEP", "Migrate Teams");
  const args = buildMigrateTeamsArgs(config, stepsInRun);
  await executeCommand(args, "Migrate teams step");
  printStepCompletion("Teams migration completed");
};

// ==================== Migrate Step ====================

/**
 * Validates migration prerequisites
 */
const validateMigrationConfig = (config: WorkflowConfig): void => {
  if (!coerceProjectKey(config.source.projectKey)) {
    console.log(Colors.red("Error: Source project key is required for migration step"));
    Deno.exit(1);
  }
  if (!coerceProjectKey(config.destination?.projectKey)) {
    console.log(Colors.red("Error: Destination project key is required for migration step"));
    Deno.exit(1);
  }
};

/**
 * Formats environment mapping as command argument
 */
const formatKeyValueMapping = (mapping: Record<string, string>): string =>
  Object.entries(mapping)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");

const formatEnvMapping = formatKeyValueMapping;

/** Dry-run for account IAM steps: accountMigration.dryRun, else migration.dryRun */
const accountMigrationDryRun = (config: WorkflowConfig): boolean =>
  config.accountMigration?.dryRun === true || config.migration?.dryRun === true;

/**
 * Builds migration-specific arguments
 */
const buildMigrationArgs = (config: WorkflowConfig): string[] => {
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
  args = addOptionalArg(args, "--include-flags", migration.includeFlags?.length ? migration.includeFlags.join(",") : undefined);
  args = addOptionalArg(args, "--exclude-flags", migration.excludeFlags?.length ? migration.excludeFlags.join(",") : undefined);
  args = addOptionalArg(args, "--concurrency", migration.concurrency != null ? String(migration.concurrency) : undefined);

  if (migration.environmentMapping) {
    args = addOptionalArg(args, "--env-map", formatEnvMapping(migration.environmentMapping));
  }

  if (migration.ruleValueReplacements?.length) {
    args = addOptionalArg(args, "--rule-value-replacements", JSON.stringify(migration.ruleValueReplacements));
  }

  return args;
};

/**
 * Builds complete migration command arguments
 */
const buildMigrateArgs = (config: WorkflowConfig): string[] => {
  const baseArgs = buildDenoRunArgs(
    "src/scripts/launchdarkly-migrations/migrate_between_ld_instances.ts",
    ["--allow-net", "--allow-read", "--allow-write"],
    config
  );

  const withProjects = [
    ...baseArgs,
    "-p", coerceProjectKey(config.source.projectKey)!,
    "-d", coerceProjectKey(config.destination!.projectKey)!
  ];

  const withMigrationOpts = [...withProjects, ...buildMigrationArgs(config)];
  return addOptionalArg(withMigrationOpts, "--domain", config.destination?.domain);
};

/**
 * Runs the migration step
 */
const runMigrate = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP 3", "Migrate Project");
  validateMigrationConfig(config);
  const args = buildMigrateArgs(config);
  await executeCommand(args, "Migration step");
  printStepCompletion("Migration completed");
};

// ==================== Third-Party Import Step ====================

/**
 * Validates third-party import configuration
 */
const validateThirdPartyConfig = (config: WorkflowConfig): void => {
  if (!config.thirdPartyImport) {
    console.log(Colors.red("Error: thirdPartyImport configuration is required"));
    Deno.exit(1);
  }
};

/**
 * Builds arguments for third-party import command
 */
const buildThirdPartyImportArgs = (config: WorkflowConfig): string[] => {
  const importConfig = config.thirdPartyImport!;
  
  const baseArgs = buildDenoRunArgs(
    "src/scripts/third-party-migrations/import_flags_from_external.ts",
    ["--allow-net", "--allow-read", "--allow-write", "--allow-env"],
    config
  );

  const withRequiredArgs = [
    ...baseArgs,
    "-f", importConfig.inputFile,
    "-p", importConfig.targetProject
  ];

  const withDryRun = addBooleanFlag(withRequiredArgs, "-d", importConfig.dryRun);
  const withUpsert = addBooleanFlag(withDryRun, "-u", importConfig.upsert);
  const withOutput = addOptionalArg(withUpsert, "-o", importConfig.reportOutput);
  return addOptionalArg(withOutput, "--domain", config.destination?.domain);
};

/**
 * Runs the third-party import step
 */
const runThirdPartyImport = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP", "Third-Party Flag Import");
  validateThirdPartyConfig(config);
  const args = buildThirdPartyImportArgs(config);
  await executeCommand(args, "Third-party import");
  printStepCompletion("Third-party import completed");
};

// ==================== Revert Step ====================

/**
 * Validates revert configuration
 */
const validateRevertConfig = (config: WorkflowConfig): void => {
  if (!config.destination?.projectKey) {
    console.log(Colors.red("Error: Destination project key is required for revert step"));
    Deno.exit(1);
  }
};

/**
 * Builds arguments for revert command
 */
const buildRevertArgs = (config: WorkflowConfig): string[] => {
  const revertConfig = config.revert || {};
  
  const baseArgs = buildDenoRunArgs(
    "src/scripts/launchdarkly-migrations/revert_migration.ts",
    ["--allow-net", "--allow-read", "--allow-write"],
    config
  );

  // Use the config file itself as the -f parameter (revert reads from it)
  const withConfigFile = [...baseArgs, "-f", configPath];
  
  // Add optional flags
  let args = addBooleanFlag(withConfigFile, "--dry-run", revertConfig.dryRun);
  args = addBooleanFlag(args, "--delete-views", revertConfig.deleteViews);
  
  // Add view keys if specified
  if (revertConfig.viewKeys && revertConfig.viewKeys.length > 0) {
    args = addOptionalArg(args, "-v", revertConfig.viewKeys.join(","));
  }
  
  return args;
};

/**
 * Runs the revert step
 */
const runRevert = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP", "Revert Migration");
  validateRevertConfig(config);
  const args = buildRevertArgs(config);
  await executeCommand(args, "Revert step");
  printStepCompletion("Revert completed");
};

// ==================== Step Execution ====================

type StepExecutor = (config: WorkflowConfig) => Promise<void>;

/**
 * Maps step names to their executor functions
 */
const STEP_EXECUTORS: Record<StepName, StepExecutor> = {
  'extract-source': runExtractSource,
  'extract-account': runExtractAccount,
  'map-members': runMapMembers,
  'migrate-roles': runMigrateRoles,
  'migrate-teams': (config) => runMigrateTeams(config, []),
  'migrate': runMigrate,
  'third-party-import': runThirdPartyImport,
  'revert': runRevert,
};

/**
 * Executes a single workflow step
 */
const executeStep = async (
  step: string,
  config: WorkflowConfig,
  stepsInRun: string[],
): Promise<void> => {
  const executor = STEP_EXECUTORS[step as StepName];

  if (step === "migrate-teams") {
    await runMigrateTeams(config, stepsInRun);
    return;
  }

  if (executor) {
    await executor(config);
  } else {
    console.log(Colors.yellow(`Warning: Unknown step "${step}", skipping...`));
  }
};

const printProjectBanner = (index: number, total: number, projectKey: string): void => {
  const divider = "=".repeat(60);
  console.log(Colors.magenta(`\n${divider}`));
  console.log(Colors.magenta(`Project ${index + 1}/${total}: ${projectKey}`));
  console.log(Colors.magenta(`${divider}\n`));
};

/**
 * Validates config before running project-scoped steps.
 */
const validateProjectStepsPrerequisites = (config: WorkflowConfig): void => {
  try {
    resolveProjectKeys(config);
  } catch (error) {
    console.log(Colors.red(error instanceof Error ? error.message : String(error)));
    Deno.exit(1);
  }
};

/**
 * Executes all workflow steps: account-level steps once, then project steps per key.
 */
const executeWorkflowSteps = async (steps: string[], config: WorkflowConfig): Promise<void> => {
  const { accountSteps, projectSteps, unknownSteps } = partitionWorkflowSteps(steps);

  for (const step of unknownSteps) {
    console.log(Colors.yellow(`Warning: Unknown step "${step}", skipping...`));
  }

  for (const step of accountSteps) {
    await executeStep(step, config, steps);
  }

  if (projectSteps.length === 0) {
    return;
  }

  validateProjectStepsPrerequisites(config);
  const projectKeys = resolveProjectKeys(config);

  for (let i = 0; i < projectKeys.length; i++) {
    const key = projectKeys[i];
    printProjectBanner(i, projectKeys.length, key);
    const projectConfig = withProjectKey(config, key);
    for (const step of projectSteps) {
      await executeStep(step, projectConfig, steps);
    }
  }
};

// ==================== Workflow Summary ====================

/**
 * Prints workflow header with configuration summary
 */
const printWorkflowHeader = (config: WorkflowConfig, steps: string[]): void => {
  const divider = "=".repeat(60);

  console.log(Colors.blue(`\n🚀 LaunchDarkly Migration Workflow`));
  console.log(Colors.blue(`${divider}\n`));
  console.log(Colors.cyan(`Configuration loaded: ${configPath}`));

  if (usesProjectKeysList(config)) {
    try {
      const keys = resolveProjectKeys(config);
      console.log(Colors.cyan(`Projects: ${keys.length} (${keys[0]} … ${keys[keys.length - 1]})`));
      console.log(Colors.gray(`  Same project key used on destination for each project`));
    } catch {
      console.log(Colors.cyan(`Projects: (see source.projectKeys — validation at project steps)`));
    }
  } else if (config.source.projectKey) {
    console.log(Colors.cyan(`Source Project: ${config.source.projectKey}`));
    if (config.destination?.projectKey) {
      console.log(Colors.cyan(`Destination Project: ${config.destination.projectKey}`));
    }
  } else {
    console.log(Colors.yellow(`Source Project: not set (use source.projectKey or source.projectKeys)`));
  }

  const { accountSteps, projectSteps } = partitionWorkflowSteps(steps);
  if (accountSteps.length > 0 && projectSteps.length > 0) {
    console.log(Colors.cyan(
      `Steps: account [${accountSteps.join(" → ")}] then per-project [${projectSteps.join(" → ")}]`,
    ));
  } else {
    console.log(Colors.cyan(`Steps to execute: ${steps.join(" → ")}`));
  }
  console.log("");

  if (shouldIgnoreCertificateErrors(config)) {
    const explicit = config.workflow?.ignoreCertificateErrors;
    const reason = explicit === true || explicit === "true"
      ? "ignoreCertificateErrors is enabled in config"
      : "ignoring certificate errors by default (set workflow.ignoreCertificateErrors: false to disable)";
    console.log(Colors.yellow(
      `TLS: ${reason} — child steps use --unsafely-ignore-certificate-errors.\n`,
    ));
  }
};

/**
 * Prints workflow completion message
 */
const printWorkflowCompletion = (): void => {
  const divider = "=".repeat(60);
  console.log(Colors.green(`\n${divider}`));
  console.log(Colors.green("✓ Workflow completed successfully!"));
  console.log(Colors.green(`${divider}\n`));
};

/**
 * Gets workflow steps from config or uses defaults
 */
const getWorkflowSteps = (config: WorkflowConfig): string[] =>
  config.workflow?.steps || DEFAULT_WORKFLOW_STEPS;

// ==================== Main Entry Point ====================

/**
 * Main workflow orchestration function
 */
const main = async (): Promise<void> => {
  let config = await loadConfig(configPath);
  config = applyCertificateErrorOverrides(config, {
    cliIgnoreCertificateErrors: inputArgs.ignoreCertificateErrors === true,
  });
  const steps = getWorkflowSteps(config);
  
  printWorkflowHeader(config, steps);
  await executeWorkflowSteps(steps, config);
  printWorkflowCompletion();
};

if (import.meta.main) {
  main();
}
