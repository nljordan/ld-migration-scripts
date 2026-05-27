import { ldAPIRequest, rateLimitRequest } from "./utils.ts";

/** Root directory for extracted account-level IAM data */
export const ACCOUNT_SOURCE_ROOT = "data/launchdarkly-migrations/source/account";

export const DEFAULT_MEMBER_MAPPING_PATH =
  "data/launchdarkly-migrations/mappings/maintainer_mapping.json";

export interface PaginatedResponse<T> {
  items: T[];
  totalCount?: number;
  _links?: {
    next?: { href: string };
  };
}

export interface PolicyStatement {
  effect: string;
  actions?: string[];
  notActions?: string[];
  resources?: string[];
  notResources?: string[];
  [key: string]: unknown;
}

export interface CustomRoleRecord {
  key: string;
  name: string;
  policy: PolicyStatement[];
  description?: string;
  basePermissions?: string;
  resourceCategory?: string;
  _presetBundleVersion?: number;
  _presetStatements?: PolicyStatement[];
  _id?: string;
  _links?: unknown;
  _access?: unknown;
  assignedTo?: unknown;
  [key: string]: unknown;
}

export interface TeamMemberRef {
  _id: string;
  email?: string;
  [key: string]: unknown;
}

interface MemberListItem {
  _id: string;
  email?: string;
}

export interface TeamRoleRef {
  key: string;
  name?: string;
  [key: string]: unknown;
}

export interface TeamRecord {
  key: string;
  name: string;
  description?: string;
  customRoleKeys?: string[];
  memberIDs?: string[];
  permissionGrants?: unknown[];
  roleAttributes?: Record<string, string[]>;
  members?: { items?: TeamMemberRef[]; totalCount?: number };
  maintainers?: { items?: TeamMemberRef[]; totalCount?: number };
  roles?: { items?: TeamRoleRef[]; totalCount?: number };
  [key: string]: unknown;
}

export type MemberMapping = Record<string, string | null>;

const READ_ONLY_ROLE_FIELDS = new Set([
  "_id",
  "_links",
  "_access",
  "assignedTo",
  "_presetBundleVersion",
  "_presetStatements",
]);

/**
 * Paginates a LaunchDarkly collection endpoint using _links.next.
 */
export async function paginateLdCollection<T>(
  apiKey: string,
  domain: string,
  initialPath: string,
  routeName: string,
): Promise<T[]> {
  const all: T[] = [];
  let nextUrl: string | null = initialPath;

  while (nextUrl) {
    const req = ldAPIRequest(apiKey, domain, nextUrl);
    const response = await rateLimitRequest(req, routeName);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${routeName} (${response.status}): ${await response.text()}`,
      );
    }

    const data = (await response.json()) as PaginatedResponse<T>;
    all.push(...(data.items ?? []));

    const nextHref = data._links?.next?.href;
    nextUrl = nextHref ? nextHref.split("/api/v2/")[1] ?? null : null;
  }

  return all;
}

/** True when the role is user-created (not from an LD preset bundle). */
export function isUserCreatedRole(role: { _presetBundleVersion?: number }): boolean {
  return role._presetBundleVersion == null;
}

/** Rewrites proj/<sourceKey> prefixes in a single resource string. */
export function remapResourceString(
  resource: string,
  mapping: Record<string, string>,
): string {
  for (const [src, dest] of Object.entries(mapping)) {
    if (!src || src === dest) continue;
    const prefix = `proj/${src}`;
    const newPrefix = `proj/${dest}`;
    if (resource === prefix || resource.startsWith(`${prefix}:`)) {
      return newPrefix + resource.slice(prefix.length);
    }
  }
  return resource;
}

/** Deep-copies policy statements with project keys remapped in resources / notResources. */
export function remapPolicyResources(
  policy: PolicyStatement[],
  mapping: Record<string, string>,
): PolicyStatement[] {
  if (Object.keys(mapping).length === 0) {
    return policy.map((s) => ({ ...s }));
  }

  return policy.map((statement) => {
    const next: PolicyStatement = { ...statement };
    if (statement.resources) {
      next.resources = statement.resources.map((r) => remapResourceString(r, mapping));
    }
    if (statement.notResources) {
      next.notResources = statement.notResources.map((r) =>
        remapResourceString(r, mapping)
      );
    }
    return next;
  });
}

/**
 * Builds project key mapping from explicit map plus optional source→dest pair.
 */
export function buildProjectKeyMapping(
  explicit?: Record<string, string>,
  sourceProjectKey?: string,
  destProjectKey?: string,
): Record<string, string> {
  const mapping: Record<string, string> = { ...explicit };
  if (sourceProjectKey && destProjectKey && sourceProjectKey !== destProjectKey) {
    mapping[sourceProjectKey] = destProjectKey;
  }
  return mapping;
}

/** Parses "a:b,c:d" into a project key mapping record. */
export function parseProjectKeyMapArg(arg: string): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const part of arg.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [src, dest] = part.split(":").map((s) => s.trim());
    if (src && dest) mapping[src] = dest;
  }
  return mapping;
}

/** Include list empty = all; exclude wins over include. */
export function shouldIncludeKey(
  key: string,
  include?: string[],
  exclude?: string[],
): boolean {
  if (exclude?.includes(key)) return false;
  if (include && include.length > 0 && !include.includes(key)) return false;
  return true;
}

/** Strips read-only API fields before POST/PATCH. */
export function stripRoleForWrite(role: CustomRoleRecord): Record<string, unknown> {
  const body: Record<string, unknown> = {
    key: role.key,
    name: role.name,
    policy: role.policy,
  };
  if (role.description != null) body.description = role.description;
  if (role.basePermissions != null) body.basePermissions = role.basePermissions;
  if (role.resourceCategory != null) body.resourceCategory = role.resourceCategory;
  return body;
}

/** Removes read-only fields from a role object (mutates copy). */
export function sanitizeRolePayload(role: CustomRoleRecord): CustomRoleRecord {
  const copy = { ...role };
  for (const field of READ_ONLY_ROLE_FIELDS) {
    delete copy[field];
  }
  return copy;
}

/**
 * Fetches all member IDs for a team via GET /members?filter=team:{teamKey}.
 * Required because expand=members on GET team only returns totalCount, not member IDs.
 */
export async function fetchTeamMemberIds(
  apiKey: string,
  domain: string,
  teamKey: string,
): Promise<string[]> {
  const filter = `team:${teamKey}`;
  const members = await paginateLdCollection<MemberListItem>(
    apiKey,
    domain,
    `members?filter=${encodeURIComponent(filter)}&limit=100`,
    "members",
  );
  return members.map((m) => m._id).filter(Boolean);
}

/** Collects member _id values from a team record (denormalized memberIDs or expanded items). */
export function extractTeamMemberIds(team: TeamRecord): string[] {
  if (team.memberIDs?.length) return [...team.memberIDs];
  const fromMembers = team.members?.items?.map((m) => m._id).filter(Boolean) ?? [];
  return fromMembers as string[];
}

/** True when extracted team JSON is missing member IDs but reports members exist. */
export function teamNeedsMemberIdBackfill(team: TeamRecord): boolean {
  return extractTeamMemberIds(team).length === 0 && (team.members?.totalCount ?? 0) > 0;
}

/** Collects maintainer _id values from expanded team data. */
export function extractTeamMaintainerIds(team: TeamRecord): string[] {
  return (team.maintainers?.items?.map((m) => m._id).filter(Boolean) ?? []) as string[];
}

/** Collects custom role keys assigned to a team. */
export function extractTeamCustomRoleKeys(team: TeamRecord): string[] {
  if (team.customRoleKeys?.length) return [...team.customRoleKeys];
  return (team.roles?.items?.map((r) => r.key).filter(Boolean) ?? []) as string[];
}

/**
 * Maps source member IDs to destination via maintainer mapping.
 * Unmapped IDs are omitted; returns count of skipped members.
 */
export function mapMemberIds(
  sourceIds: string[],
  mapping: MemberMapping,
): { mapped: string[]; skipped: number } {
  const mapped: string[] = [];
  let skipped = 0;
  for (const id of sourceIds) {
    const destId = mapping[id];
    if (destId) {
      mapped.push(destId);
    } else {
      skipped++;
    }
  }
  return { mapped, skipped };
}

/** Remaps memberIDs inside team permissionGrants for destination account. */
export function remapTeamPermissionGrants(
  grants: unknown[] | undefined,
  mapping: MemberMapping,
): unknown[] | undefined {
  if (!grants?.length) return grants;
  return grants.map((grant) => {
    if (!grant || typeof grant !== "object") return grant;
    const g = { ...(grant as Record<string, unknown>) };
    const raw = g.memberIDs;
    if (Array.isArray(raw)) {
      const { mapped } = mapMemberIds(raw as string[], mapping);
      g.memberIDs = mapped;
    }
    return g;
  });
}

/** Lists `.json` file paths in a directory (non-recursive). */
export async function listJsonFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        files.push(`${dir}/${entry.name}`);
      }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  return files.sort();
}

/** Role key from filename `my-role.json` → `my-role`. */
export function keyFromJsonFilename(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.json$/i, "");
}
