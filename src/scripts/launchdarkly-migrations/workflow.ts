/**
 * LaunchDarkly Migration Workflow Orchestrator
 * 
 * Supports running complete migration workflows from a single YAML config file.
 * Default behavior: Runs full workflow (extract → map → migrate)
 */

import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import {
  type WorkflowConfig,
  parseWorkflowConfig,
  getWorkflowSteps,
  buildExtractSourceArgs,
  buildMapMembersArgs,
  buildMigrateArgs,
  buildThirdPartyImportArgs,
  buildRevertArgs,
} from "./workflow_helpers.ts";

interface Arguments {
  config: string;
}

type StepName = 'extract-source' | 'map-members' | 'migrate' | 'third-party-import' | 'revert';
type CommandOptions = { args: string[]; stdout: "inherit"; stderr: "inherit" };

const inputArgs: Arguments = yargs(Deno.args)
  .alias("f", "config")
  .demandOption(["config"])
  .describe("f", "Path to workflow configuration YAML file")
  .parse() as Arguments;

// ==================== Config Loading ====================

/**
 * Loads and parses a YAML configuration file
 */
const loadConfig = async (configPath: string): Promise<WorkflowConfig> => {
  try {
    const configContent = await Deno.readTextFile(configPath);
    return parseWorkflowConfig(configContent);
  } catch (_error) {
    console.log(Colors.red(
      `Error loading config file: ${_error instanceof Error ? _error.message : String(_error)}`
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

// ==================== Extract Source Step ====================

/**
 * Runs the extract source data step
 */
const runExtractSource = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP 1", "Extract Source Project Data");
  const args = buildExtractSourceArgs(config);
  await executeCommand(args, "Extract source step");
  printStepCompletion("Source data extraction completed");
};

// ==================== Map Members Step ====================

/**
 * Runs the member mapping step
 */
const runMapMembers = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP 2", "Map Members Between Instances");
  const args = buildMapMembersArgs(config);
  await executeCommand(args, "Member mapping step");
  printStepCompletion("Member mapping completed");
};

// ==================== Migrate Step ====================

/**
 * Validates migration prerequisites
 */
const validateMigrationConfig = (config: WorkflowConfig): void => {
  if (!config.destination?.projectKey) {
    console.log(Colors.red("Error: Destination project key is required for migration step"));
    Deno.exit(1);
  }
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
 * Runs the revert step
 */
const runRevert = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP", "Revert Migration");
  validateRevertConfig(config);
  const args = buildRevertArgs(config, inputArgs.config);
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
  'map-members': runMapMembers,
  'migrate': runMigrate,
  'third-party-import': runThirdPartyImport,
  'revert': runRevert
};

/**
 * Executes a single workflow step
 */
const executeStep = async (step: string, config: WorkflowConfig): Promise<void> => {
  const executor = STEP_EXECUTORS[step as StepName];
  
  if (executor) {
    await executor(config);
  } else {
    console.log(Colors.yellow(`Warning: Unknown step "${step}", skipping...`));
  }
};

/**
 * Executes all workflow steps in sequence
 */
const executeWorkflowSteps = async (steps: string[], config: WorkflowConfig): Promise<void> => {
  for (const step of steps) {
    await executeStep(step, config);
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
  console.log(Colors.cyan(`Configuration loaded: ${inputArgs.config}`));
  console.log(Colors.cyan(`Source Project: ${config.source.projectKey}`));
  
  if (config.destination?.projectKey) {
    console.log(Colors.cyan(`Destination Project: ${config.destination.projectKey}`));
  }
  
  console.log(Colors.cyan(`Steps to execute: ${steps.join(" → ")}\n`));
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

// ==================== Main Entry Point ====================

/**
 * Main workflow orchestration function
 */
const main = async (): Promise<void> => {
  const config = await loadConfig(inputArgs.config);
  const steps = getWorkflowSteps(config);
  
  printWorkflowHeader(config, steps);
  await executeWorkflowSteps(steps, config);
  printWorkflowCompletion();
};

if (import.meta.main) {
  main();
}
