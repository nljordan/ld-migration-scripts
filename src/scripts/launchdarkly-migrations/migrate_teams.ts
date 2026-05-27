// deno-lint-ignore-file no-explicit-any
import { parse } from "https://deno.land/std@0.177.0/flags/mod.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { getDestinationApiKey } from "../../utils/api_keys.ts";
import {
  ACCOUNT_SOURCE_ROOT,
  DEFAULT_MEMBER_MAPPING_PATH,
  extractTeamCustomRoleKeys,
  extractTeamMaintainerIds,
  extractTeamMemberIds,
  keyFromJsonFilename,
  listJsonFiles,
  mapMemberIds,
  type MemberMapping,
  type TeamRecord,
  shouldIncludeKey,
} from "../../utils/account_iam.ts";
import {
  applyConflictPrefix,
  ConflictTracker,
  getJson,
  ldAPIPostRequest,
  ldAPIRequest,
  rateLimitRequest,
} from "../../utils/utils.ts";

interface MigrateTeamsFlags {
  domain: string;
  "member-mapping"?: string;
  "dry-run"?: boolean;
  "conflict-prefix"?: string;
  "include-teams"?: string;
  "exclude-teams"?: string;
  "source-dir"?: string;
}

async function teamExists(
  apiKey: string,
  domain: string,
  teamKey: string,
): Promise<boolean> {
  const req = ldAPIRequest(apiKey, domain, `teams/${teamKey}`);
  const response = await rateLimitRequest(req, "teams");
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`GET teams/${teamKey} failed: ${response.status} ${await response.text()}`);
  }
  return true;
}

function buildTeamPostBody(
  team: TeamRecord,
  memberMapping: MemberMapping,
): { body: Record<string, unknown>; skippedMembers: number } {
  const sourceMemberIds = [
    ...new Set([
      ...extractTeamMemberIds(team),
      ...extractTeamMaintainerIds(team),
    ]),
  ];
  const { mapped: memberIDs, skipped } = mapMemberIds(sourceMemberIds, memberMapping);

  const body: Record<string, unknown> = {
    key: team.key,
    name: team.name,
  };
  if (team.description) body.description = team.description;

  const customRoleKeys = extractTeamCustomRoleKeys(team);
  if (customRoleKeys.length > 0) body.customRoleKeys = customRoleKeys;
  if (memberIDs.length > 0) body.memberIDs = memberIDs;
  if (team.permissionGrants?.length) body.permissionGrants = team.permissionGrants;
  if (team.roleAttributes && Object.keys(team.roleAttributes).length > 0) {
    body.roleAttributes = team.roleAttributes;
  }

  return { body, skippedMembers: skipped };
}

async function createTeam(
  apiKey: string,
  domain: string,
  body: Record<string, unknown>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(Colors.gray(`    [DRY RUN] Would POST teams (${body.key})`));
    return;
  }
  const req = ldAPIPostRequest(apiKey, domain, "teams", body);
  const response = await rateLimitRequest(req, "teams");
  if (!response.ok) {
    throw new Error(`POST teams failed: ${response.status} ${await response.text()}`);
  }
}

async function main(): Promise<void> {
  const flags = parse(Deno.args, {
    string: [
      "domain",
      "member-mapping",
      "conflict-prefix",
      "include-teams",
      "exclude-teams",
      "source-dir",
    ],
    boolean: ["dry-run"],
    default: { domain: "app.launchdarkly.com" },
  }) as MigrateTeamsFlags;

  const domain = flags.domain ?? "app.launchdarkly.com";
  const dryRun = flags["dry-run"] === true;
  const conflictPrefix = flags["conflict-prefix"] ?? "";
  const mappingPath = flags["member-mapping"] ?? DEFAULT_MEMBER_MAPPING_PATH;
  const sourceDir = flags["source-dir"] ?? `${ACCOUNT_SOURCE_ROOT}/teams`;
  const includeTeams = flags["include-teams"]?.split(",").map((s) => s.trim()).filter(Boolean);
  const excludeTeams = flags["exclude-teams"]?.split(",").map((s) => s.trim()).filter(Boolean);

  const memberMapping = (await getJson(mappingPath)) as MemberMapping | undefined;
  if (!memberMapping || Object.keys(memberMapping).length === 0) {
    console.log(
      Colors.yellow(
        `Warning: No member mapping at ${mappingPath}. Run map-members first. Team members will be omitted.`,
      ),
    );
  }

  const apiKey = await getDestinationApiKey();
  const conflictTracker = new ConflictTracker();
  const mapping = memberMapping ?? {};

  const files = await listJsonFiles(sourceDir);
  if (files.length === 0) {
    console.log(Colors.yellow(`No team files found in ${sourceDir}. Run extract-account first.`));
    Deno.exit(0);
  }

  console.log(Colors.blue(`Migrating ${files.length} team(s) to ${domain}`));
  if (dryRun) console.log(Colors.yellow("DRY RUN — no changes will be applied"));

  let created = 0;
  let skipped = 0;

  for (const filePath of files) {
    const sourceKey = keyFromJsonFilename(filePath);
    if (!shouldIncludeKey(sourceKey, includeTeams, excludeTeams)) {
      skipped++;
      continue;
    }

    const team = JSON.parse(await Deno.readTextFile(filePath)) as TeamRecord;
    const { body, skippedMembers } = buildTeamPostBody(team, mapping);

    let destKey = sourceKey;
    const exists = await teamExists(apiKey, domain, destKey);

    if (exists) {
      if (conflictPrefix) {
        destKey = applyConflictPrefix(sourceKey, conflictPrefix);
        body.key = destKey;
        const prefixedExists = await teamExists(apiKey, domain, destKey);
        if (prefixedExists) {
          console.log(Colors.yellow(`\n${sourceKey}: prefixed key ${destKey} exists — skipping`));
          skipped++;
          continue;
        }
        conflictTracker.addResolution({
          resourceType: "team",
          originalKey: sourceKey,
          resolvedKey: destKey,
          conflictPrefix,
        });
      } else {
        console.log(Colors.gray(`\n${sourceKey}: already exists — skipping`));
        skipped++;
        continue;
      }
    }

    console.log(`\n${sourceKey}${destKey !== sourceKey ? ` → ${destKey}` : ""}`);
    if (skippedMembers > 0) {
      console.log(Colors.yellow(`  ${skippedMembers} member(s) unmapped and omitted`));
    }
    const memberCount = (body.memberIDs as string[] | undefined)?.length ?? 0;
    console.log(Colors.gray(`  Members: ${memberCount}, roles: ${
      (body.customRoleKeys as string[] | undefined)?.length ?? 0
    }`));

    await createTeam(apiKey, domain, body, dryRun);
    created++;
  }

  console.log(Colors.green(`\nTeams: ${created} created, ${skipped} skipped`));
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
