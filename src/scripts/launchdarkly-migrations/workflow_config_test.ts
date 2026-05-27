import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDenoRunArgs,
  normalizeWorkflowConfig,
  partitionWorkflowSteps,
  resolveProjectKeys,
  shouldIgnoreCertificateErrors,
  withProjectKey,
  type WorkflowConfig,
} from "../../utils/workflow_config.ts";

const baseConfig = (): WorkflowConfig => ({
  source: { domain: "app.launchdarkly.com" },
  destination: { domain: "app.launchdarkly.us" },
});

Deno.test("shouldIgnoreCertificateErrors reads workflow.ignoreCertificateErrors", () => {
  const config: WorkflowConfig = {
    ...baseConfig(),
    workflow: { ignoreCertificateErrors: true },
  };
  assertEquals(shouldIgnoreCertificateErrors(config), true);
  assertEquals(shouldIgnoreCertificateErrors(baseConfig()), false);
});

Deno.test("resolveProjectKeys from projectKeys list", () => {
  const config: WorkflowConfig = {
    ...baseConfig(),
    source: { projectKeys: ["a", "b", "a"] },
  };
  assertEquals(resolveProjectKeys(config), ["a", "b"]);
});

Deno.test("resolveProjectKeys from single projectKey", () => {
  const config: WorkflowConfig = {
    ...baseConfig(),
    source: { projectKey: "my-proj" },
  };
  assertEquals(resolveProjectKeys(config), ["my-proj"]);
});

Deno.test("resolveProjectKeys throws when missing", () => {
  assertThrows(
    () => resolveProjectKeys(baseConfig()),
    Error,
    "source.projectKey",
  );
});

Deno.test("withProjectKey sets same key on source and destination and preserves TLS", () => {
  const config: WorkflowConfig = normalizeWorkflowConfig({
    ...baseConfig(),
    source: { projectKeys: ["x"] },
    workflow: { ignoreCertificateErrors: true },
  });
  const next = withProjectKey(config, "payroll");
  assertEquals(next.source.projectKey, "payroll");
  assertEquals(next.destination?.projectKey, "payroll");
  assertEquals(next.workflow?.ignoreCertificateErrors, true);
});

Deno.test("buildDenoRunArgs includes TLS flag when enabled", () => {
  const config = normalizeWorkflowConfig({
    ...baseConfig(),
    workflow: { ignoreCertificateErrors: true },
  });
  const args = buildDenoRunArgs("script.ts", ["--allow-net"], config);
  assertEquals(args.includes("--unsafely-ignore-certificate-errors"), true);
});

Deno.test("buildDenoRunArgs omits TLS flag when disabled", () => {
  const args = buildDenoRunArgs("script.ts", ["--allow-net"], baseConfig());
  assertEquals(args.includes("--unsafely-ignore-certificate-errors"), false);
});

Deno.test("partitionWorkflowSteps splits account and project steps", () => {
  const steps = [
    "map-members",
    "extract-account",
    "extract-source",
    "migrate",
    "unknown-step",
  ];
  const { accountSteps, projectSteps, unknownSteps } = partitionWorkflowSteps(steps);
  assertEquals(accountSteps, ["map-members", "extract-account"]);
  assertEquals(projectSteps, ["extract-source", "migrate"]);
  assertEquals(unknownSteps, ["unknown-step"]);
});
