/**
 * Workflow YAML normalization and multi-project helpers.
 */

export interface WorkflowConfig {
  workflow?: {
    steps?: string[];
    ignoreCertificateErrors?: boolean;
  };
  source: {
    projectKey?: string;
    projectKeys?: string[];
    domain?: string;
  };
  destination?: {
    projectKey?: string;
    domain?: string;
  };
  extraction?: {
    includeSegments?: boolean;
  };
  memberMapping?: {
    outputFile?: string;
  };
  accountMigration?: {
    includeRoles?: boolean;
    includeTeams?: boolean;
    conflictPrefix?: string;
    includeRolesKeys?: string[];
    excludeRolesKeys?: string[];
    includeTeamsKeys?: string[];
    excludeTeamsKeys?: string[];
    projectKeyMapping?: Record<string, string>;
    dryRun?: boolean;
  };
  migration?: {
    assignMaintainerIds?: boolean;
    migrateSegments?: boolean;
    conflictPrefix?: string;
    targetView?: string;
    environments?: string[];
    environmentMapping?: Record<string, string>;
    dryRun?: boolean;
    incremental?: boolean;
    since?: string;
    includeFlags?: string[];
    excludeFlags?: string[];
    concurrency?: number;
    ruleValueReplacements?: { attribute?: string; match: string; replace: string }[];
  };
  thirdPartyImport?: {
    inputFile: string;
    targetProject: string;
    dryRun?: boolean;
    upsert?: boolean;
    reportOutput?: string;
  };
  revert?: {
    dryRun?: boolean;
    deleteViews?: boolean;
    viewKeys?: string[];
  };
}

export type WorkflowStepName =
  | "extract-source"
  | "extract-account"
  | "map-members"
  | "migrate-roles"
  | "migrate-teams"
  | "migrate"
  | "third-party-import"
  | "revert";

export const ACCOUNT_LEVEL_STEPS = new Set<string>([
  "map-members",
  "extract-account",
  "migrate-roles",
  "migrate-teams",
  "third-party-import",
]);

export const PROJECT_LEVEL_STEPS = new Set<string>([
  "extract-source",
  "migrate",
  "revert",
]);

/** Shallow clone of workflow config (extension point for future normalization). */
export function normalizeWorkflowConfig(raw: WorkflowConfig): WorkflowConfig {
  return { ...raw };
}

/** Whether TLS certificate validation should be skipped for child Deno processes. */
export function shouldIgnoreCertificateErrors(config: WorkflowConfig): boolean {
  return config.workflow?.ignoreCertificateErrors === true;
}

/** Builds `deno run` prefix args including optional TLS ignore flag. */
export function buildDenoRunArgs(
  scriptPath: string,
  permissions: string[],
  config: WorkflowConfig,
): string[] {
  const ignoreTls = shouldIgnoreCertificateErrors(config);
  return [
    "run",
    ...(ignoreTls ? ["--unsafely-ignore-certificate-errors"] : []),
    ...permissions,
    scriptPath,
  ];
}

/**
 * Resolves the list of source project keys from config.
 * @throws Error if neither projectKey nor projectKeys is set
 */
export function resolveProjectKeys(config: WorkflowConfig): string[] {
  const fromList = config.source.projectKeys
    ?.map((k) => k.trim())
    .filter(Boolean);
  if (fromList && fromList.length > 0) {
    return [...new Set(fromList)];
  }
  const single = config.source.projectKey?.trim();
  if (single) {
    return [single];
  }
  throw new Error(
    "Workflow config must specify source.projectKey (single project) or source.projectKeys (list of projects).",
  );
}

/** True when config uses a multi-project keys list. */
export function usesProjectKeysList(config: WorkflowConfig): boolean {
  return (config.source.projectKeys?.filter((k) => k.trim()).length ?? 0) > 0;
}

/**
 * Clone config with source and destination projectKey set to the same key (same-key dest migration).
 */
export function withProjectKey(config: WorkflowConfig, projectKey: string): WorkflowConfig {
  return {
    ...config,
    workflow: config.workflow ? { ...config.workflow } : undefined,
    source: {
      ...config.source,
      projectKey,
    },
    destination: config.destination
      ? { ...config.destination, projectKey }
      : { projectKey },
  };
}

export function isAccountLevelStep(step: string): boolean {
  return ACCOUNT_LEVEL_STEPS.has(step);
}

export function isProjectLevelStep(step: string): boolean {
  return PROJECT_LEVEL_STEPS.has(step);
}

/** Split workflow steps into account-level and project-level lists (preserves order within each). */
export function partitionWorkflowSteps(steps: string[]): {
  accountSteps: string[];
  projectSteps: string[];
  unknownSteps: string[];
} {
  const accountSteps: string[] = [];
  const projectSteps: string[] = [];
  const unknownSteps: string[] = [];

  for (const step of steps) {
    if (isAccountLevelStep(step)) {
      accountSteps.push(step);
    } else if (isProjectLevelStep(step)) {
      projectSteps.push(step);
    } else {
      unknownSteps.push(step);
    }
  }

  return { accountSteps, projectSteps, unknownSteps };
}
