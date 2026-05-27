// deno-lint-ignore-file no-explicit-any
import { parse } from "https://deno.land/std@0.177.0/flags/mod.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { getDestinationApiKey } from "../../utils/api_keys.ts";
import {
  ACCOUNT_SOURCE_ROOT,
  buildProjectKeyMapping,
  type CustomRoleRecord,
  keyFromJsonFilename,
  listJsonFiles,
  parseProjectKeyMapArg,
  remapPolicyResources,
  shouldIncludeKey,
  stripRoleForWrite,
} from "../../utils/account_iam.ts";
import {
  applyConflictPrefix,
  ConflictTracker,
  ldAPIPatchRequest,
  ldAPIPostRequest,
  ldAPIRequest,
  rateLimitRequest,
} from "../../utils/utils.ts";

interface MigrateRolesFlags {
  domain: string;
  "project-key-map"?: string;
  "source-project"?: string;
  "dest-project"?: string;
  "dry-run"?: boolean;
  "conflict-prefix"?: string;
  "include-roles"?: string;
  "exclude-roles"?: string;
  "source-dir"?: string;
}

async function roleExists(
  apiKey: string,
  domain: string,
  roleKey: string,
): Promise<boolean> {
  const req = ldAPIRequest(apiKey, domain, `roles/${roleKey}`);
  const response = await rateLimitRequest(req, "roles");
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`GET roles/${roleKey} failed: ${response.status} ${await response.text()}`);
  }
  return true;
}

async function createRole(
  apiKey: string,
  domain: string,
  body: Record<string, unknown>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(Colors.gray(`    [DRY RUN] Would POST roles (${body.key})`));
    return;
  }
  const req = ldAPIPostRequest(apiKey, domain, "roles", body);
  const response = await rateLimitRequest(req, "roles");
  if (!response.ok) {
    throw new Error(`POST roles failed: ${response.status} ${await response.text()}`);
  }
}

async function updateRole(
  apiKey: string,
  domain: string,
  roleKey: string,
  body: Record<string, unknown>,
  dryRun: boolean,
): Promise<void> {
  const patches: Array<{ op: string; path: string; value: unknown }> = [];
  if (body.name != null) patches.push({ op: "replace", path: "/name", value: body.name });
  if (body.description != null) {
    patches.push({ op: "replace", path: "/description", value: body.description });
  }
  if (body.policy != null) patches.push({ op: "replace", path: "/policy", value: body.policy });

  if (patches.length === 0) return;

  if (dryRun) {
    console.log(Colors.gray(`    [DRY RUN] Would PATCH roles/${roleKey}`));
    return;
  }

  const req = ldAPIPatchRequest(apiKey, domain, `roles/${roleKey}`, patches);
  const response = await rateLimitRequest(req, "roles");
  if (!response.ok) {
    throw new Error(`PATCH roles/${roleKey} failed: ${response.status} ${await response.text()}`);
  }
}

async function main(): Promise<void> {
  const flags = parse(Deno.args, {
    string: [
      "domain",
      "project-key-map",
      "source-project",
      "dest-project",
      "conflict-prefix",
      "include-roles",
      "exclude-roles",
      "source-dir",
    ],
    boolean: ["dry-run"],
    default: { domain: "app.launchdarkly.com" },
  }) as MigrateRolesFlags;

  const domain = flags.domain ?? "app.launchdarkly.com";
  const dryRun = flags["dry-run"] === true;
  const conflictPrefix = flags["conflict-prefix"] ?? "";
  const sourceDir = flags["source-dir"] ?? `${ACCOUNT_SOURCE_ROOT}/roles`;
  const includeRoles = flags["include-roles"]?.split(",").map((s) => s.trim()).filter(Boolean);
  const excludeRoles = flags["exclude-roles"]?.split(",").map((s) => s.trim()).filter(Boolean);

  const explicitMap = flags["project-key-map"]
    ? parseProjectKeyMapArg(flags["project-key-map"])
    : {};
  const projectKeyMapping = buildProjectKeyMapping(
    explicitMap,
    flags["source-project"],
    flags["dest-project"],
  );

  const apiKey = await getDestinationApiKey();
  const conflictTracker = new ConflictTracker();

  const files = await listJsonFiles(sourceDir);
  if (files.length === 0) {
    console.log(Colors.yellow(`No role files found in ${sourceDir}. Run extract-account first.`));
    Deno.exit(0);
  }

  console.log(Colors.blue(`Migrating ${files.length} custom role(s) to ${domain}`));
  if (Object.keys(projectKeyMapping).length > 0) {
    console.log(Colors.cyan("Project key mapping:"));
    for (const [src, dest] of Object.entries(projectKeyMapping)) {
      console.log(Colors.cyan(`  ${src} → ${dest}`));
    }
  }
  if (dryRun) console.log(Colors.yellow("DRY RUN — no changes will be applied"));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const filePath of files) {
    const sourceKey = keyFromJsonFilename(filePath);
    if (!shouldIncludeKey(sourceKey, includeRoles, excludeRoles)) {
      skipped++;
      continue;
    }

    const raw = JSON.parse(await Deno.readTextFile(filePath)) as CustomRoleRecord;
    const remappedPolicy = remapPolicyResources(raw.policy ?? [], projectKeyMapping);
    const body = stripRoleForWrite({ ...raw, policy: remappedPolicy });

    let destKey = sourceKey;
    const exists = await roleExists(apiKey, domain, destKey);

    if (exists && conflictPrefix) {
      destKey = applyConflictPrefix(sourceKey, conflictPrefix);
      body.key = destKey;
      conflictTracker.addResolution({
        resourceType: "custom-role",
        originalKey: sourceKey,
        resolvedKey: destKey,
        conflictPrefix,
      });
    }

    const destExists = destKey !== sourceKey
      ? await roleExists(apiKey, domain, destKey)
      : exists;

    console.log(`\n${sourceKey}${destKey !== sourceKey ? ` → ${destKey}` : ""}`);

    if (destExists && destKey === sourceKey) {
      console.log(Colors.gray("  Role exists — updating policy"));
      await updateRole(apiKey, domain, destKey, body, dryRun);
      updated++;
    } else if (destExists) {
      console.log(Colors.yellow(`  Skipping: prefixed key ${destKey} also exists`));
      skipped++;
    } else {
      console.log(Colors.gray("  Creating role"));
      await createRole(apiKey, domain, body, dryRun);
      created++;
    }
  }

  console.log(Colors.green(`\nRoles: ${created} created, ${updated} updated, ${skipped} skipped`));
  if (conflictTracker.hasConflicts()) {
    console.log(conflictTracker.getReport());
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(Colors.red(err instanceof Error ? err.message : String(err)));
    Deno.exit(1);
  });
}
