/**
 * Shared helpers for E2E tests: config preparation and workflow execution.
 * Used by workflow_e2e_test.ts and workflow_examples_e2e_test.ts.
 */

import { parse } from "https://deno.land/std@0.224.0/yaml/parse.ts";
import { stringify } from "https://deno.land/std@0.224.0/yaml/stringify.ts";

/**
 * Prepares a workflow config YAML: injects source/dest project keys and forces
 * dry-run for every step that supports it (migration, revert, third-party import)
 * so E2E never writes to or deletes from LaunchDarkly.
 */
export function prepareWorkflowConfig(
  content: string,
  sourceProject: string,
  destProject: string
): string {
  const config = parse(content) as Record<string, unknown>;
  if (config.source && typeof config.source === "object" && config.source !== null) {
    (config.source as Record<string, unknown>).projectKey = sourceProject;
  }
  if (config.destination && typeof config.destination === "object" && config.destination !== null) {
    (config.destination as Record<string, unknown>).projectKey = destProject;
  }
  if (config.migration && typeof config.migration === "object" && config.migration !== null) {
    (config.migration as Record<string, unknown>).dryRun = true;
  }
  if (config.revert && typeof config.revert === "object" && config.revert !== null) {
    (config.revert as Record<string, unknown>).dryRun = true;
  }
  if (config.thirdPartyImport && typeof config.thirdPartyImport === "object" && config.thirdPartyImport !== null) {
    (config.thirdPartyImport as Record<string, unknown>).dryRun = true;
  }
  return stringify(config);
}

export interface RunWorkflowResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the workflow script with the given config file path.
 */
export async function runWorkflowWithConfig(configPath: string): Promise<RunWorkflowResult> {
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "src/scripts/launchdarkly-migrations/workflow.ts",
      "-f",
      configPath,
    ],
    cwd: Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

export const E2E_SOURCE_PROJECT = Deno.env.get("LD_E2E_SOURCE_PROJECT") ?? "e2e-source";
export const E2E_DEST_PROJECT = Deno.env.get("LD_E2E_DEST_PROJECT") ?? "e2e-dest";

export function isE2EEnabled(): boolean {
  return Deno.env.get("LD_E2E_API_KEY") != null && Deno.env.get("LD_E2E_API_KEY") !== "";
}

export const WORKFLOW_SUCCESS_MARKERS = [
  "Workflow completed successfully",
  "✓ Workflow completed successfully!",
];

export function stdoutIndicatesSuccess(stdout: string): boolean {
  return WORKFLOW_SUCCESS_MARKERS.some((m) => stdout.includes(m));
}
