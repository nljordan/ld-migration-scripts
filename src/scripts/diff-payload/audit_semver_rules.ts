#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

import { parseArgs } from "jsr:@std/cli/parse-args";
import { fetchSDKPayload } from "./mod.ts";

const DEFAULT_KEYS_FILE = new URL(
  "../../../config/server_side_sdk_keys.json",
  import.meta.url,
);

const SEMVER_OPS = new Set([
  "semVerEqual",
  "semVerLessThan",
  "semVerGreaterThan",
]);

const SEMVER_VALUE_RE = /^\d+\.\d+(\.\d+)?$/;

interface SemVerMatch {
  flagKey: string;
  ruleIndex: number;
  ruleDescription?: string;
  attribute: string;
  op: string;
  values: unknown[];
  contextKind?: string;
  negate?: boolean;
  humanOp: string;
}

interface SemVerVariation {
  flagKey: string;
  variationIndex: number;
  value: string;
}

const VERSION_ATTRS = new Set(["version", "versionName"]);

interface VersionClause {
  flagKey: string;
  ruleIndex: number;
  ruleDescription?: string;
  attribute: string;
  op: string;
  values: unknown[];
  contextKind?: string;
  negate?: boolean;
  humanOp: string;
}

// Translate op + negate into a human-readable comparison.
// Reference: https://launchdarkly.com/docs/home/flags/target-rules
//   semVerEqual          + negate=false  →  "= (equal)"
//   semVerEqual          + negate=true   →  "!= (not equal)"
//   semVerLessThan       + negate=false  →  "< (less than)"
//   semVerLessThan       + negate=true   →  ">= (greater than or equal)"
//   semVerGreaterThan    + negate=false  →  "> (greater than)"
//   semVerGreaterThan    + negate=true   →  "<= (less than or equal)"
function humanReadableOp(op: string, negate: boolean): string {
  switch (op) {
    case "semVerEqual":
      return negate ? "!= (not equal)" : "= (equal)";
    case "semVerLessThan":
      return negate ? ">= (greater than or equal)" : "< (less than)";
    case "semVerGreaterThan":
      return negate ? "<= (less than or equal)" : "> (greater than)";
    case "in":
      return negate ? "not in" : "in";
    case "contains":
      return negate ? "does not contain" : "contains";
    case "startsWith":
      return negate ? "does not start with" : "starts with";
    case "endsWith":
      return negate ? "does not end with" : "ends with";
    case "matches":
      return negate ? "does not match" : "matches";
    case "lessThan":
      return negate ? ">=" : "<";
    case "lessThanOrEqual":
      return negate ? ">" : "<=";
    case "greaterThan":
      return negate ? "<=" : ">";
    case "greaterThanOrEqual":
      return negate ? "<" : ">=";
    default:
      return negate ? `NOT ${op}` : op;
  }
}

async function loadKeysFromFile(keysPath: URL | string): Promise<{ sdkKeyA: string; sdkKeyB: string }> {
  const configUrl =
    keysPath instanceof URL
      ? keysPath
      : keysPath.startsWith("/") || keysPath.match(/^[A-Za-z]:/)
        ? new URL(`file://${keysPath}`)
        : new URL(keysPath, `file://${Deno.cwd()}/`);
  const pathLabel = keysPath instanceof URL ? configUrl.pathname : keysPath;
  const text = await Deno.readTextFile(configUrl).catch((err) => {
    throw new Error(
      `Could not read keys file ${pathLabel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const data = JSON.parse(text) as Record<string, unknown>;
  if (typeof data.sdkKeyA !== "string" || typeof data.sdkKeyB !== "string") {
    throw new Error(
      "Keys file must contain sdkKeyA and sdkKeyB (strings). See config/server_side_sdk_keys.json.example.",
    );
  }
  return { sdkKeyA: data.sdkKeyA as string, sdkKeyB: data.sdkKeyB as string };
}

const args = parseArgs(Deno.args, {
  string: ["base-url", "format", "keys-file", "key", "exclude-version"],
  boolean: ["help"],
  alias: { h: "help", f: "format", k: "key" },
  default: { format: "console", key: "b" },
  collect: ["exclude-version"],
});

if (args.help) {
  console.error(
    `Usage: audit_semver_rules.ts [options]

Fetch the SDK polling payload and report all flags with:
  - Rule clauses using semVer operators (semVerEqual, semVerLessThan, semVerGreaterThan)
  - Rule clauses targeting version or versionName with any operator
  - Variations whose values are semantic versions (MAJOR.MINOR or MAJOR.MINOR.PATCH)

Options:
  --key, -k             Which SDK key to use: "a" or "b" (default: b)
  --format, -f          Output format: console (default) | json
  --exclude-version     Exclude clauses/variations matching this version (repeatable)
  --base-url            SDK polling base URL (default: https://sdk.launchdarkly.com)
  --keys-file           Path to JSON file with sdkKeyA and sdkKeyB
                        (default: config/server_side_sdk_keys.json)
  --help, -h            Show this help message

Examples:
  deno task audit-semver
  deno task audit-semver -- --key a
  deno task audit-semver -- --exclude-version 1.0.0
  deno task audit-semver -- --format json | jq .
  deno task audit-semver -- --keys-file ./config/server_side_sdk_keys.json`,
  );
  Deno.exit(0);
}

const keySide = (args.key as string).toLowerCase();
if (keySide !== "a" && keySide !== "b") {
  console.error('Error: --key must be "a" or "b"');
  Deno.exit(1);
}

const format = args.format as string;
if (format !== "console" && format !== "json") {
  console.error('Error: --format must be "console" or "json"');
  Deno.exit(1);
}

const excludeVersions = new Set(
  ((args["exclude-version"] ?? []) as string[]).filter(Boolean),
);

const keysPath: URL | string = args["keys-file"] ?? DEFAULT_KEYS_FILE;
let sdkKey: string;
try {
  const keys = await loadKeysFromFile(keysPath);
  sdkKey = keySide === "a" ? keys.sdkKeyA : keys.sdkKeyB;
} catch (err) {
  console.error("Error loading SDK keys:", err instanceof Error ? err.message : String(err));
  Deno.exit(1);
}

const baseUrl = args["base-url"] ||
  Deno.env.get("LD_BASE_URL") ||
  "https://sdk.launchdarkly.com";

if (excludeVersions.size) {
  console.error(`Excluding version(s): ${[...excludeVersions].join(", ")}`);
}
console.error(`Fetching SDK payload (key ${keySide.toUpperCase()}) from ${baseUrl}...`);
const payload = await fetchSDKPayload(sdkKey, baseUrl);
const flags = (payload.flags ?? {}) as Record<string, Record<string, unknown>>;
const flagCount = Object.keys(flags).length;
console.error(`Fetched ${flagCount} flags\n`);

const ruleMatches: SemVerMatch[] = [];
const versionClauseMatches: VersionClause[] = [];
const variationMatches: SemVerVariation[] = [];

for (const [flagKey, flag] of Object.entries(flags)) {
  const rules = (flag.rules ?? []) as Array<Record<string, unknown>>;
  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    const clauses = (rule.clauses ?? []) as Array<Record<string, unknown>>;
    for (const clause of clauses) {
      const op = clause.op as string;
      const attr = clause.attribute as string;
      const negate = clause.negate as boolean ?? false;

      if (SEMVER_OPS.has(op) && attr !== "/os/version") {
        const rawValues = clause.values as unknown[];
        const values = excludeVersions.size
          ? rawValues.filter((v) => !excludeVersions.has(String(v)))
          : rawValues;
        if (values.length === 0) continue;
        ruleMatches.push({
          flagKey,
          ruleIndex: ri,
          ruleDescription: rule.description as string | undefined,
          attribute: attr,
          op,
          values,
          contextKind: clause.contextKind as string | undefined,
          negate: negate || undefined,
          humanOp: humanReadableOp(op, negate),
        });
      } else if (VERSION_ATTRS.has(attr)) {
        const rawValues = clause.values as unknown[];
        const values = excludeVersions.size
          ? rawValues.filter((v) => !excludeVersions.has(String(v)))
          : rawValues;
        if (values.length === 0) continue;
        versionClauseMatches.push({
          flagKey,
          ruleIndex: ri,
          ruleDescription: rule.description as string | undefined,
          attribute: attr,
          op,
          values,
          contextKind: clause.contextKind as string | undefined,
          negate: negate || undefined,
          humanOp: humanReadableOp(op, negate),
        });
      }
    }
  }

  const variations = (flag.variations ?? []) as unknown[];
  for (let vi = 0; vi < variations.length; vi++) {
    const v = variations[vi];
    if (typeof v === "string" && SEMVER_VALUE_RE.test(v) && !excludeVersions.has(v)) {
      variationMatches.push({ flagKey, variationIndex: vi, value: v });
    }
  }
}

const flagsWithRules = new Set(ruleMatches.map((m) => m.flagKey));
const flagsWithVersionClauses = new Set(versionClauseMatches.map((m) => m.flagKey));
const flagsWithVariations = new Set(variationMatches.map((m) => m.flagKey));

if (format === "json") {
  console.log(JSON.stringify({
    rules: ruleMatches,
    versionClauses: versionClauseMatches,
    variations: variationMatches,
  }, null, 2));
} else {
  // --- Rules section ---
  if (ruleMatches.length === 0) {
    console.log("No flags with semVer rules found.");
  } else {
    console.log("=== Rules using semVer operators ===\n");
    let currentFlag = "";
    for (const m of ruleMatches) {
      if (m.flagKey !== currentFlag) {
        if (currentFlag) console.log();
        currentFlag = m.flagKey;
        console.log(currentFlag);
      }
      const desc = m.ruleDescription ? ` "${m.ruleDescription}"` : "";
      const ctx = m.contextKind ?? "user";
      const versions = (m.values as string[]).join(", ");
      console.log(
        `  rule[${m.ruleIndex}]:${desc} ${m.attribute} ${m.humanOp} ${versions}  [${ctx}]`,
      );
    }
  }

  // --- version/versionName with non-semVer ops ---
  if (versionClauseMatches.length > 0) {
    console.log("\n\n=== version/versionName clauses using non-semVer operators ===\n");
    let currentFlag = "";
    for (const m of versionClauseMatches) {
      if (m.flagKey !== currentFlag) {
        if (currentFlag) console.log();
        currentFlag = m.flagKey;
        console.log(currentFlag);
      }
      const desc = m.ruleDescription ? ` "${m.ruleDescription}"` : "";
      const ctx = m.contextKind ?? "user";
      const versions = (m.values as string[]).join(", ");
      console.log(
        `  rule[${m.ruleIndex}]:${desc} ${m.attribute} ${m.humanOp} ${versions}  [${ctx}]`,
      );
    }
  }

  // --- Variations section ---
  if (variationMatches.length > 0) {
    console.log("\n\n=== Variations with semVer values ===\n");
    let currentFlag = "";
    for (const m of variationMatches) {
      if (m.flagKey !== currentFlag) {
        if (currentFlag) console.log();
        currentFlag = m.flagKey;
        console.log(currentFlag);
      }
      console.log(`  variation[${m.variationIndex}]: ${m.value}`);
    }
  }

  // --- Summary ---
  const parts: string[] = [];
  parts.push(`${flagsWithRules.size} flag(s) with semVer rules, ${ruleMatches.length} clause(s)`);
  if (versionClauseMatches.length > 0) {
    parts.push(`${flagsWithVersionClauses.size} flag(s) with version/versionName non-semVer clauses, ${versionClauseMatches.length} clause(s)`);
  }
  parts.push(`${flagsWithVariations.size} flag(s) with semVer variation values, ${variationMatches.length} variation(s)`);
  console.log(`\nSummary:\n  ${parts.join("\n  ")}`);
}
