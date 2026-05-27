import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildProjectKeyMapping,
  extractTeamMemberIds,
  isUserCreatedRole,
  mapMemberIds,
  parseProjectKeyMapArg,
  remapPolicyResources,
  remapResourceString,
  remapTeamPermissionGrants,
  shouldIncludeKey,
  teamNeedsMemberIdBackfill,
} from "./account_iam.ts";

Deno.test("isUserCreatedRole skips preset bundle roles", () => {
  assertEquals(isUserCreatedRole({}), true);
  assertEquals(isUserCreatedRole({ _presetBundleVersion: 1 }), false);
});

Deno.test("remapResourceString rewrites proj prefix", () => {
  const mapping = { "us-prod": "eu-prod" };
  assertEquals(
    remapResourceString("proj/us-prod:env/*:flag/*", mapping),
    "proj/eu-prod:env/*:flag/*",
  );
  assertEquals(remapResourceString("proj/us-prod", mapping), "proj/eu-prod");
  assertEquals(remapResourceString("proj/other:env/x", mapping), "proj/other:env/x");
  assertEquals(remapResourceString("acct/*", mapping), "acct/*");
});

Deno.test("remapPolicyResources updates resources and notResources", () => {
  const policy = [
    {
      effect: "allow",
      actions: ["viewProject"],
      resources: ["proj/src:env/production:flag/*"],
      notResources: ["proj/src:env/staging:*"],
    },
  ];
  const result = remapPolicyResources(policy, { src: "dest" });
  assertEquals(result[0].resources, ["proj/dest:env/production:flag/*"]);
  assertEquals(result[0].notResources, ["proj/dest:env/staging:*"]);
});

Deno.test("remapPolicyResources no-op when mapping empty", () => {
  const policy = [{ effect: "allow", resources: ["proj/a"] }];
  const result = remapPolicyResources(policy, {});
  assertEquals(result[0].resources, ["proj/a"]);
});

Deno.test("buildProjectKeyMapping merges explicit and implicit", () => {
  assertEquals(
    buildProjectKeyMapping({ a: "b" }, "x", "y"),
    { a: "b", x: "y" },
  );
  assertEquals(buildProjectKeyMapping(undefined, "same", "same"), {});
});

Deno.test("parseProjectKeyMapArg", () => {
  assertEquals(parseProjectKeyMapArg("a:b, c : d "), { a: "b", c: "d" });
});

Deno.test("shouldIncludeKey respects include and exclude", () => {
  assertEquals(shouldIncludeKey("a", undefined, ["b"]), true);
  assertEquals(shouldIncludeKey("b", undefined, ["b"]), false);
  assertEquals(shouldIncludeKey("a", ["a"], undefined), true);
  assertEquals(shouldIncludeKey("b", ["a"], undefined), false);
});

Deno.test("extractTeamMemberIds uses denormalized memberIDs from extract", () => {
  assertEquals(
    extractTeamMemberIds({ key: "t", name: "T", memberIDs: ["a", "b"] }),
    ["a", "b"],
  );
});

Deno.test("teamNeedsMemberIdBackfill when only totalCount present", () => {
  assertEquals(
    teamNeedsMemberIdBackfill({ key: "t", name: "T", members: { totalCount: 3 } }),
    true,
  );
  assertEquals(
    teamNeedsMemberIdBackfill({ key: "t", name: "T", memberIDs: ["x"], members: { totalCount: 3 } }),
    false,
  );
});

Deno.test("remapTeamPermissionGrants maps memberIDs", () => {
  const grants = remapTeamPermissionGrants(
    [{ actions: ["updateTeamName"], memberIDs: ["src1", "src2"] }],
    { src1: "dest1", src2: null },
  ) as Array<{ memberIDs: string[] }>;
  assertEquals(grants[0].memberIDs, ["dest1"]);
});

Deno.test("mapMemberIds omits unmapped", () => {
  const { mapped, skipped } = mapMemberIds(
    ["s1", "s2", "s3"],
    { s1: "d1", s2: null, s3: "d3" },
  );
  assertEquals(mapped, ["d1", "d3"]);
  assertEquals(skipped, 1);
});
