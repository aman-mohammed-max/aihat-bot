import { AppError } from "./errors.js";
import type { InstalledSkill, SkillDefinition, TenantId, UserId } from "./types.js";

export interface StoredSkillDefinition {
  readonly id: string;
  readonly tenantId: string | null;
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly category: string;
  readonly description: string;
  readonly executionType: string;
  readonly inputSchemaJson: string;
  readonly outputSchemaJson: string;
  readonly permissionsJson: string;
  readonly definitionJson: string;
  readonly enabled: number;
}

export function parseStoredSkillDefinition(row: StoredSkillDefinition): SkillDefinition {
  const raw = parseRecord(row.definitionJson, "skill definition");
  const configuration = asRecord(raw.configuration) ?? raw;
  const rate = asRecord(raw.rateLimit) ?? {};
  const retry = asRecord(raw.retryPolicy) ?? {};
  const permissions = parseStringList(row.permissionsJson, "skill permissions");
  const retryableStatusCodes = retry.retryableStatusCodes ?? [429, 500, 502, 503, 504];
  const definition: SkillDefinition = {
    id: row.id,
    tenantId: row.tenantId as TenantId | null,
    name: row.name,
    version: row.version,
    author: row.author,
    category: row.category,
    description: row.description,
    executionType: row.executionType as SkillDefinition["executionType"],
    inputSchema: parseRecord(row.inputSchemaJson, "skill input schema"),
    outputSchema: parseRecord(row.outputSchemaJson, "skill output schema"),
    requiredPermissions: permissions,
    configuration,
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 30_000,
    rateLimit: {
      maxRequests: typeof rate.maxRequests === "number" ? rate.maxRequests : 30,
      windowSeconds: typeof rate.windowSeconds === "number" ? rate.windowSeconds : 60,
    },
    retryPolicy: {
      maxAttempts: typeof retry.maxAttempts === "number" ? retry.maxAttempts : 1,
      backoffMs: typeof retry.backoffMs === "number" ? retry.backoffMs : 250,
      idempotent: retry.idempotent === true,
      retryableStatusCodes: Array.isArray(retryableStatusCodes)
        ? retryableStatusCodes.filter((status): status is number => typeof status === "number")
        : [],
    },
    enabled: row.enabled === 1,
  };
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(definition.id) ||
    !["prompt", "http", "mcp", "native", "workflow", "sandbox"].includes(definition.executionType) ||
    !Number.isSafeInteger(definition.timeoutMs) ||
    definition.timeoutMs < 1 ||
    definition.timeoutMs > 120_000 ||
    !Number.isSafeInteger(definition.rateLimit.maxRequests) ||
    definition.rateLimit.maxRequests < 1 ||
    definition.rateLimit.maxRequests > 100_000 ||
    !Number.isSafeInteger(definition.rateLimit.windowSeconds) ||
    definition.rateLimit.windowSeconds < 1 ||
    definition.rateLimit.windowSeconds > 86_400 ||
    !Number.isSafeInteger(definition.retryPolicy.maxAttempts) ||
    definition.retryPolicy.maxAttempts < 1 ||
    definition.retryPolicy.maxAttempts > 4 ||
    !Number.isSafeInteger(definition.retryPolicy.backoffMs) ||
    definition.retryPolicy.backoffMs < 0 ||
    definition.retryPolicy.backoffMs > 5_000 ||
    definition.retryPolicy.retryableStatusCodes.some(
      (status) => !Number.isInteger(status) || status < 400 || status > 599,
    )
  ) {
    throw new AppError("INTERNAL_ERROR", "Stored skill runtime policy is invalid.", 500);
  }
  return definition;
}

export function parseStoredSkillInstallation(
  row: StoredSkillDefinition & {
    readonly installedEnabled: number;
    readonly installedBy: string;
    readonly installationJson: string;
  },
): InstalledSkill {
  const definition = parseStoredSkillDefinition(row);
  const data = parseRecord(row.installationJson, "skill installation");
  const permissions = data.grantedPermissions;
  if (
    !Array.isArray(permissions) ||
    permissions.some((permission) => typeof permission !== "string") ||
    permissions.some((permission) => !definition.requiredPermissions.includes(permission)) ||
    permissions.length !== definition.requiredPermissions.length ||
    new Set(permissions).size !== permissions.length
  ) {
    throw new AppError("INTERNAL_ERROR", "Stored skill permission grants are invalid.", 500);
  }
  const configuration = { ...data };
  delete configuration.grantedPermissions;
  if (Object.keys(configuration).some((key) => key !== "credentialRef")) {
    throw new AppError("INTERNAL_ERROR", "Stored skill installation configuration is invalid.", 500);
  }
  if (
    configuration.credentialRef !== undefined &&
    (typeof configuration.credentialRef !== "string" || !/^secret_[a-f0-9]{32}$/.test(configuration.credentialRef))
  ) {
    throw new AppError("INTERNAL_ERROR", "Stored skill credential reference is invalid.", 500);
  }
  return {
    definition,
    enabled: row.installedEnabled === 1,
    installedBy: row.installedBy as UserId,
    configuration,
    grantedPermissions: permissions as string[],
  };
}

export function validateSkillInstallation(
  definition: SkillDefinition,
  configuration: Readonly<Record<string, unknown>>,
  grantedPermissions: readonly string[],
): {
  readonly configuration: Readonly<{ credentialRef?: string }>;
  readonly grantedPermissions: readonly string[];
} {
  if (
    Object.keys(configuration).some((key) => key !== "credentialRef") ||
    grantedPermissions.length !== definition.requiredPermissions.length ||
    new Set(grantedPermissions).size !== grantedPermissions.length ||
    definition.requiredPermissions.some((permission) => !grantedPermissions.includes(permission))
  ) {
    throw new AppError("VALIDATION_ERROR", "Skill configuration or explicit permissions are invalid.", 400);
  }
  const credentialRef = configuration.credentialRef;
  if (
    credentialRef !== undefined &&
    (typeof credentialRef !== "string" || !/^secret_[a-f0-9]{32}$/.test(credentialRef))
  ) {
    throw new AppError("VALIDATION_ERROR", "Skill credential reference is invalid.", 400);
  }
  return {
    configuration: credentialRef === undefined ? {} : { credentialRef: credentialRef as string },
    grantedPermissions,
  };
}

export function validateSkillRateLimitInput(maxRequests: number, windowSeconds: number, now: number): void {
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 100_000 ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 86_400 ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new AppError("VALIDATION_ERROR", "Skill rate-limit configuration is invalid.", 400);
  }
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", `Stored ${label} is invalid JSON.`, 500, { cause });
  }
  const record = asRecord(parsed);
  if (!record) throw new AppError("INTERNAL_ERROR", `Stored ${label} is not an object.`, 500);
  return record;
}

function parseStringList(value: string, label: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", `Stored ${label} is invalid JSON.`, 500, { cause });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new AppError("INTERNAL_ERROR", `Stored ${label} is invalid.`, 500);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
