import { ensureDirSync } from "https://deno.land/std@0.149.0/fs/mod.ts";
import { parse } from "https://deno.land/std@0.177.0/flags/mod.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { getSourceApiKey } from "../../utils/api_keys.ts";
import { ldAPIRequest, rateLimitRequest } from "../../utils/utils.ts";
import {
  ACCOUNT_SOURCE_ROOT,
  type CustomRoleRecord,
  extractTeamMaintainerIds,
  fetchTeamMemberIds,
  isUserCreatedRole,
  paginateLdCollection,
  type TeamRecord,
} from "../../utils/account_iam.ts";

interface RoleSummary {
  key: string;
  _presetBundleVersion?: number;
}

interface TeamSummary {
  key: string;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
}

async function fetchRoleDetail(
  apiKey: string,
  domain: string,
  roleKey: string,
): Promise<CustomRoleRecord> {
  const req = ldAPIRequest(apiKey, domain, `roles/${roleKey}`);
  const response = await rateLimitRequest(req, "roles");
  if (!response.ok) {
    throw new Error(`Failed to fetch role ${roleKey}: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as CustomRoleRecord;
}

async function fetchTeamDetail(
  apiKey: string,
  domain: string,
  teamKey: string,
): Promise<TeamRecord> {
  const path = `teams/${teamKey}?expand=members,maintainers,roles`;
  const req = ldAPIRequest(apiKey, domain, path);
  const response = await rateLimitRequest(req, "teams");
  if (!response.ok) {
    throw new Error(`Failed to fetch team ${teamKey}: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TeamRecord;
}

async function extractRoles(
  apiKey: string,
  domain: string,
  rolesDir: string,
): Promise<void> {
  console.log(Colors.cyan("\nExtracting custom roles..."));
  const summaries = await paginateLdCollection<RoleSummary>(
    apiKey,
    domain,
    "roles?limit=100",
    "roles",
  );

  const userRoles = summaries.filter(isUserCreatedRole);
  console.log(
    `Found ${summaries.length} roles (${userRoles.length} user-created, ${
      summaries.length - userRoles.length
    } presets skipped)`,
  );

  let written = 0;
  for (const summary of userRoles) {
    const detail = await fetchRoleDetail(apiKey, domain, summary.key);
    await writeJson(`${rolesDir}/${summary.key}.json`, detail);
    written++;
    console.log(Colors.gray(`  ✓ ${summary.key}`));
  }
  console.log(Colors.green(`Wrote ${written} role file(s) to ${rolesDir}`));
}

async function extractTeams(
  apiKey: string,
  domain: string,
  teamsDir: string,
): Promise<void> {
  console.log(Colors.cyan("\nExtracting teams..."));
  const summaries = await paginateLdCollection<TeamSummary>(
    apiKey,
    domain,
    "teams?limit=100",
    "teams",
  );

  console.log(`Found ${summaries.length} team(s)`);

  let written = 0;
  for (const summary of summaries) {
    const detail = await fetchTeamDetail(apiKey, domain, summary.key);
    const memberIds = await fetchTeamMemberIds(apiKey, domain, summary.key);
    const maintainerIds = extractTeamMaintainerIds(detail);
    detail.memberIDs = [...new Set([...memberIds, ...maintainerIds])];
    await writeJson(`${teamsDir}/${summary.key}.json`, detail);
    written++;
    console.log(Colors.gray(`  ✓ ${summary.key} (${detail.memberIDs.length} member(s))`));
  }
  console.log(Colors.green(`Wrote ${written} team file(s) to ${teamsDir}`));
}

async function main(): Promise<void> {
  const flags = parse(Deno.args, {
    string: ["domain"],
    boolean: ["include-roles", "include-teams"],
    default: {
      "include-roles": true,
      "include-teams": true,
      domain: "app.launchdarkly.com",
    },
  });

  const domain = flags.domain as string;
  const includeRoles = flags["include-roles"] as boolean;
  const includeTeams = flags["include-teams"] as boolean;

  if (!includeRoles && !includeTeams) {
    console.error("Nothing to extract: both --include-roles and --include-teams are false");
    Deno.exit(1);
  }

  const apiKey = await getSourceApiKey();
  const rolesDir = `${ACCOUNT_SOURCE_ROOT}/roles`;
  const teamsDir = `${ACCOUNT_SOURCE_ROOT}/teams`;

  ensureDirSync(ACCOUNT_SOURCE_ROOT);
  if (includeRoles) ensureDirSync(rolesDir);
  if (includeTeams) ensureDirSync(teamsDir);

  console.log(Colors.blue(`Extracting account IAM from ${domain}`));

  if (includeRoles) await extractRoles(apiKey, domain, rolesDir);
  if (includeTeams) await extractTeams(apiKey, domain, teamsDir);

  console.log(Colors.green("\nAccount extraction completed"));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(Colors.red(err instanceof Error ? err.message : String(err)));
    Deno.exit(1);
  });
}
