/**
 * E2E tests that run the workflow using each example YAML in examples/.
 * Injects LD_E2E_SOURCE_PROJECT and LD_E2E_DEST_PROJECT and forces
 * migration.dryRun = true. Skips when LD_E2E_API_KEY is not set.
 * @see tests/e2e/README.md and https://docs.deno.com/examples/testing_tutorial/
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  E2E_SOURCE_PROJECT,
  E2E_DEST_PROJECT,
  isE2EEnabled,
  prepareWorkflowConfig,
  runWorkflowWithConfig,
  stdoutIndicatesSuccess,
} from "./helpers.ts";

const EXAMPLES_DIR = new URL("../../examples", import.meta.url).pathname;

function getWorkflowExamplePaths(): string[] {
  const names: string[] = [];
  for (const e of Deno.readDirSync(EXAMPLES_DIR)) {
    if (
      e.isFile &&
      e.name.startsWith("workflow-") &&
      e.name.endsWith(".yaml") &&
      !e.name.includes(" copy")
    ) {
      names.push(`${EXAMPLES_DIR}/${e.name}`);
    }
  }
  return names.sort();
}

const workflowExamples = getWorkflowExamplePaths();

for (const examplePath of workflowExamples) {
  const exampleName = examplePath.split("/").pop() ?? examplePath;

  Deno.test({
    name: `e2e: workflow with example ${exampleName}`,
    ignore: !isE2EEnabled(),
    permissions: { read: true, write: true, net: true, run: true, env: true },
    async fn() {
      if (!isE2EEnabled()) {
        throw new Error("LD_E2E_API_KEY is not set; e2e test skipped");
      }

      const content = await Deno.readTextFile(examplePath);
      const preparedYaml = prepareWorkflowConfig(content, E2E_SOURCE_PROJECT, E2E_DEST_PROJECT);

      const tmpFile = await Deno.makeTempFile({ suffix: ".yaml" });
      try {
        await Deno.writeTextFile(tmpFile, preparedYaml);
        const { code, stdout, stderr } = await runWorkflowWithConfig(tmpFile);

        if (code !== 0) {
          console.error(`[${exampleName}] stdout:`, stdout);
          console.error(`[${exampleName}] stderr:`, stderr);
        }

        assertEquals(
          code,
          0,
          `Workflow with ${exampleName} should exit 0; got ${code}. stderr: ${stderr}`
        );
        assertEquals(
          stdoutIndicatesSuccess(stdout),
          true,
          `Expected completion message in stdout for ${exampleName}`
        );
      } finally {
        try {
          await Deno.remove(tmpFile);
        } catch {
          // ignore
        }
      }
    },
  });
}
