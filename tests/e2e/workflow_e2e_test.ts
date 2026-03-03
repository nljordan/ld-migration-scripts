/**
 * E2E test: runs the full workflow (extract-source + migrate). Always uses
 * dry-run for the migrate step so no writes are made to LaunchDarkly.
 * Skips when LD_E2E_API_KEY is not set.
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

const FIXTURE_PATH = new URL("../fixtures/e2e_config.yaml", import.meta.url).pathname;

async function getE2EConfigPath(): Promise<string> {
  const content = await Deno.readTextFile(FIXTURE_PATH);
  const prepared = prepareWorkflowConfig(content, E2E_SOURCE_PROJECT, E2E_DEST_PROJECT);
  const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
  await Deno.writeTextFile(tmp, prepared);
  return tmp;
}

Deno.test({
  name: "e2e: workflow extract + migrate (dry-run) completes successfully",
  ignore: !isE2EEnabled(),
  permissions: { read: true, write: true, net: true, run: true, env: true },
  async fn() {
    if (!isE2EEnabled()) {
      throw new Error("LD_E2E_API_KEY is not set; e2e test skipped");
    }

    const configPath = await getE2EConfigPath();
    try {
      const { code, stdout, stderr } = await runWorkflowWithConfig(configPath);

      if (code !== 0) {
        console.error("stdout:", stdout);
        console.error("stderr:", stderr);
      }

      assertEquals(code, 0, `Workflow should exit 0; got ${code}. stderr: ${stderr}`);
      assertEquals(
        stdoutIndicatesSuccess(stdout),
        true,
        "Expected completion message in stdout"
      );
    } finally {
      try {
        await Deno.remove(configPath);
      } catch {
        // ignore cleanup errors
      }
    }
  },
});
