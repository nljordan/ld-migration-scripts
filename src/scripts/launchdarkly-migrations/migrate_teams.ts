// deno-lint-ignore-file no-explicit-any
import { parse } from "https://deno.land/std@0.177.0/flags/mod.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { getDestinationApiKey, getSourceApiKey } from "../../utils/api_keys.ts";
import {
  ACCOUNT_SOURCE_ROOT,
  DEFAULT_MEMBER_MAPPING_PATH,
  extractTeamCustomRoleKeys,
  extractTeamMaintainerIds,
  extractTeamMemberIds,
  fetchTeamMemberIds,
  keyFromJsonFilename,
  listJsonFiles,
  mapMemberIds,
  remapTeamPermissionGrants,
  type MemberMapping,
  type TeamRecord,
  shouldIncludeKey,
  teamNeedsMemberIdBackfill,
} from "../../utils/account_iam.ts";
import {
  applyConflictPrefix,
  ConflictTracker,
  getJson,
  ldAPIPatchRequestSemantic,
  ldAPIPostRequest,
  ldAPIRequest,
  rateLimitRequest,
} from "../../utils/utils.ts";

interface MigrateTeamsFlags {
  domain: string;
  "source-domain"?: string;
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

async function resolveSourceMemberIds(
  team: TeamRecord,
  teamKey: string,
  sourceApiKey: string | undefined,
  sourceDomain: string,
): Promise<string[]> {
  let ids = [
    ...new Set([
      ...extractTeamMemberIds(team),
      ...extractTeamMaintainerIds(team),
    ]),
  ];

  if (ids.length === 0 && teamNeedsMemberIdBackfill(team) && sourceApiKey) {
    console.log(Colors.cyan(
      `  Fetching source member IDs for ${teamKey} (extract file missing memberIDs; re-run extract-account after upgrade)`,
    ));
    ids = await fetchTeamMemberIds(sourceApiKey, sourceDomain, teamKey);
    const maintainerIds = extractTeamMaintainerIds(team);
    ids = [...new Set([...ids, ...maintainerIds])];
  }

  return ids;
}

function buildTeamPostBody(
  team: TeamRecord,
  memberMapping: MemberMapping,
  sourceMemberIds: string[],
): { body: Record<string, unknown>; skippedMembers: number; sourceMemberCount: number } {
  const { mapped: memberIDs, skipped } = mapMemberIds(sourceMemberIds, memberMapping);

  const body: Record<string, unknown> = {
    key: team.key,
    name: team.name,
  };
  if (team.description) body.description = team.description;

  const customRoleKeys = extractTeamCustomRoleKeys(team);
  if (customRoleKeys.length > 0) body.customRoleKeys = customRoleKeys;
  if (memberIDs.length > 0) body.memberIDs = memberIDs;
  const remappedGrants = remapTeamPermissionGrants(team.permissionGrants, memberMapping);
  if (remappedGrants?.length) body.permissionGrants = remappedGrants;
  if (team.roleAttributes && Object.keys(team.roleAttributes).length > 0) {
    body.roleAttributes = team.roleAttributes;
  }

  return { body, skippedMembers: skipped, sourceMemberCount: sourceMemberIds.length };
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

function buildTeamPatchInstructions(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const instructions: Array<Record<string, unknown>> = [];
  const memberIDs = body.memberIDs as string[] | undefined;
  if (memberIDs && memberIDs.length > 0) {
    instructions.push({ kind: "replaceMembers", values: memberIDs });
  }
  const customRoleKeys = body.customRoleKeys as string[] | undefined;
  if (customRoleKeys && customRoleKeys.length > 0) {
    instructions.push({ kind: "addCustomRoles", values: customRoleKeys });
  }
  return instructions;
}

async function updateExistingTeam(
  apiKey: string,
  domain: string,
  teamKey: string,
  body: Record<string, unknown>,
  dryRun: boolean,
): Promise<boolean> {
  const instructions = buildTeamPatchInstructions(body);
  if (instructions.length === 0) {
    console.log(Colors.yellow(`  No mapped members or roles to apply`));
    return false;
  }

  if (dryRun) {
    console.log(Colors.gray(`    [DRY RUN] Would PATCH teams/${teamKey} (${instructions.length} instruction(s))`));
    return true;
  }

  const req = ldAPIPatchRequestSemantic(apiKey, domain, `teams/${teamKey}`, { instructions });
  const response = await rateLimitRequest(req, "teams");
  if (!response.ok) {
    throw new Error(`PATCH teams/${teamKey} failed: ${response.status} ${await response.text()}`);
  }
  return true;
}

async function main(): Promise<void> {
  const flags = parse(Deno.args, {
    string: [
      "domain",
      "source-domain",
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
  const sourceDomain = flags["source-domain"] ?? "app.launchdarkly.com";
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
  let sourceApiKey: string | undefined;
  try {
    sourceApiKey = await getSourceApiKey();
  } catch {
    console.log(Colors.yellow("Warning: No source API key — cannot backfill team member IDs from source API"));
  }

  const conflictTracker = new ConflictTracker();
  const mapping = memberMapping ?? {};
  const mappedDestCount = Object.values(mapping).filter((id) => id != null).length;
  console.log(Colors.cyan(`Member mapping: ${Object.keys(mapping).length} source IDs, ${mappedDestCount} mapped to destination`));

  const files = await listJsonFiles(sourceDir);
  if (files.length === 0) {
    console.log(Colors.yellow(`No team files found in ${sourceDir}. Run extract-account first.`));
    Deno.exit(0);
  }

  console.log(Colors.blue(`Migrating ${files.length} team(s) to ${domain}`));
  if (dryRun) console.log(Colors.yellow("DRY RUN — no changes will be applied"));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const filePath of files) {
    const sourceKey = keyFromJsonFilename(filePath);
    if (!shouldIncludeKey(sourceKey, includeTeams, excludeTeams)) {
      skipped++;
      continue;
    }

    const team = JSON.parse(await Deno.readTextFile(filePath)) as TeamRecord;
    const sourceMemberIds = await resolveSourceMemberIds(
      team,
      sourceKey,
      sourceApiKey,
      sourceDomain,
    );
    const { body, skippedMembers, sourceMemberCount } = buildTeamPostBody(
      team,
      mapping,
      sourceMemberIds,
    );

    if (sourceMemberCount === 0 && (team.members?.totalCount ?? 0) > 0) {
      console.log(Colors.yellow(
        `\n${sourceKey}: team has ${team.members!.totalCount} member(s) on source but no member IDs in extract — re-run extract-account`,
      ));
    } else if (sourceMemberCount > 0 && (body.memberIDs as string[] | undefined)?.length === 0) {
      console.log(Colors.yellow(
        `\n${sourceKey}: ${sourceMemberCount} source member(s) but none mapped — check FedRAMP users exist with same emails (map-members)`,
      ));
    }

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
        console.log(`\n${sourceKey}: already exists — updating members`);
        if (skippedMembers > 0) {
          console.log(Colors.yellow(`  ${skippedMembers} member(s) unmapped and omitted`));
        }
        const memberCount = (body.memberIDs as string[] | undefined)?.length ?? 0;
        console.log(Colors.gray(`  Members: ${memberCount}, roles: ${
          (body.customRoleKeys as string[] | undefined)?.length ?? 0
        }`));
        const didUpdate = await updateExistingTeam(apiKey, domain, destKey, body, dryRun);
        if (didUpdate) {
          updated++;
        } else {
          skipped++;
        }
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

  console.log(Colors.green(`\nTeams: ${created} created, ${updated} updated, ${skipped} skipped`));
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
