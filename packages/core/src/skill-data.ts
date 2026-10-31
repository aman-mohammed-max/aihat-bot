import { AppError } from "./errors.js";
import type { InstalledSkill, SkillCatalogPublication, SkillDefinition, TenantId, UserId } from "./types.js";

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

const PUBLISHABLE_EXECUTION_TYPES = new Set(["prompt", "http", "workflow"]);
const SKILL_SCHEMA_KEYS = new Set([
  "type",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Parse the intentionally limited definition format accepted by owner catalog publishing. */
export function validateSkillCatalogPublication(
  value: unknown,
  options: { readonly allowNative?: boolean } = {},
): SkillCatalogPublication {
  const raw = asRecord(value);
  const allowedKeys = new Set([
    "id",
    "name",
    "version",
    "author",
    "category",
    "description",
    "executionType",
    "inputSchema",
    "outputSchema",
    "requiredPermissions",
    "configuration",
    "timeoutMs",
    "rateLimit",
    "retryPolicy",
  ]);
  if (!raw || Object.keys(raw).some((key) => !allowedKeys.has(key))) {
    throw new AppError("VALIDATION_ERROR", "Skill definition has invalid fields.", 400);
  }

  const id = requiredText(raw.id, "id", 128, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const name = requiredText(raw.name, "name", 120);
  const version = requiredText(raw.version, "version", 64, /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/);
  const author = requiredText(raw.author, "author", 120);
  const category = requiredText(raw.category, "category", 80);
  const description = requiredText(raw.description, "description", 2000);
  if (
    typeof raw.executionType !== "string" ||
    (!PUBLISHABLE_EXECUTION_TYPES.has(raw.executionType) && !(options.allowNative && raw.executionType === "native"))
  ) {
    throw new AppError("VALIDATION_ERROR", "Only prompt, HTTPS, and workflow skills can be published.", 400);
  }
  const inputSchema = asRecord(raw.inputSchema);
  const outputSchema = asRecord(raw.outputSchema);
  if (!inputSchema || !outputSchema) {
    throw new AppError("VALIDATION_ERROR", "Skill inputSchema and outputSchema must be objects.", 400);
  }
  validateSkillSchema(inputSchema, "inputSchema");
  validateSkillSchema(outputSchema, "outputSchema");

  if (
    !Array.isArray(raw.requiredPermissions) ||
    raw.requiredPermissions.length > 32 ||
    raw.requiredPermissions.some(
      (permission) => typeof permission !== "string" || !/^[A-Za-z][A-Za-z0-9:._-]{0,63}$/.test(permission),
    ) ||
    new Set(raw.requiredPermissions).size !== raw.requiredPermissions.length
  ) {
    throw new AppError("VALIDATION_ERROR", "Skill requiredPermissions must be unique permission names.", 400);
  }
  const configuration = asRecord(raw.configuration);
  if (!configuration) throw new AppError("VALIDATION_ERROR", "Skill configuration must be an object.", 400);
  validatePublicationConfiguration(raw.executionType, configuration);

  const timeoutMs = optionalInteger(raw.timeoutMs, 30_000, 1, 120_000, "timeoutMs");
  const rateLimit = parsePublicationRateLimit(raw.rateLimit);
  const retryPolicy = parsePublicationRetryPolicy(raw.retryPolicy);
  return {
    id,
    name,
    version,
    author,
    category,
    description,
    executionType: raw.executionType as SkillDefinition["executionType"],
    inputSchema,
    outputSchema,
    requiredPermissions: raw.requiredPermissions as string[],
    configuration,
    timeoutMs,
    rateLimit,
    retryPolicy,
  };
}

function validatePublicationConfiguration(executionType: string, configuration: Record<string, unknown>): void {
  if (executionType === "prompt") {
    const instructions = configuration.instructions;
    if (
      Object.keys(configuration).some((key) => key !== "instructions") ||
      typeof instructions !== "string" ||
      instructions.trim().length === 0 ||
      instructions.length > 12_000
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Prompt skills need one instruction string of at most 12000 characters.",
        400,
      );
    }
  } else if (executionType === "http") {
    if (Object.keys(configuration).some((key) => key !== "http") || !asRecord(configuration.http)) {
      throw new AppError("VALIDATION_ERROR", "HTTP skills need an http configuration object.", 400);
    }
  } else if (executionType === "native") {
    if (Object.keys(configuration).length > 0) {
      throw new AppError("VALIDATION_ERROR", "Native skills do not accept runtime configuration.", 400);
    }
  } else if (Object.keys(configuration).some((key) => key !== "workflow") || !asRecord(configuration.workflow)) {
    throw new AppError("VALIDATION_ERROR", "Workflow skills need a workflow configuration object.", 400);
  }
}

function validateSkillSchema(schema: Record<string, unknown>, label: string): void {
  let visited = 0;
  const visit = (node: unknown, depth: number): void => {
    visited += 1;
    const shape = asRecord(node);
    if (!shape || visited > 1000 || depth > 16 || Object.keys(shape).some((key) => !SKILL_SCHEMA_KEYS.has(key))) {
      throw new AppError("VALIDATION_ERROR", `Skill ${label} uses an invalid or unsupported schema.`, 400);
    }
    if (
      shape.type !== undefined &&
      !["object", "array", "string", "boolean", "integer", "number", "null"].includes(String(shape.type))
    ) {
      throw new AppError("VALIDATION_ERROR", `Skill ${label} has an unsupported schema type.`, 400);
    }
    if (
      shape.enum !== undefined &&
      (!Array.isArray(shape.enum) || shape.enum.length === 0 || shape.enum.length > 100)
    ) {
      throw new AppError("VALIDATION_ERROR", `Skill ${label} has an invalid enum.`, 400);
    }
    for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
      if (shape[key] !== undefined && (!Number.isSafeInteger(shape[key]) || (shape[key] as number) < 0)) {
        throw new AppError("VALIDATION_ERROR", `Skill ${label} has an invalid ${key} constraint.`, 400);
      }
    }
    for (const key of ["minimum", "maximum"]) {
      if (shape[key] !== undefined && (typeof shape[key] !== "number" || !Number.isFinite(shape[key]))) {
        throw new AppError("VALIDATION_ERROR", `Skill ${label} has an invalid ${key} constraint.`, 400);
      }
    }
    if (
      (typeof shape.minLength === "number" &&
        typeof shape.maxLength === "number" &&
        shape.minLength > shape.maxLength) ||
      (typeof shape.minItems === "number" && typeof shape.maxItems === "number" && shape.minItems > shape.maxItems) ||
      (typeof shape.minimum === "number" && typeof shape.maximum === "number" && shape.minimum > shape.maximum)
    ) {
      throw new AppError("VALIDATION_ERROR", `Skill ${label} has conflicting schema constraints.`, 400);
    }
    if (shape.additionalProperties !== undefined && typeof shape.additionalProperties !== "boolean") {
      throw new AppError("VALIDATION_ERROR", `Skill ${label} additionalProperties must be a boolean.`, 400);
    }
    if (shape.items !== undefined) visit(shape.items, depth + 1);
    if (shape.properties !== undefined) {
      const properties = asRecord(shape.properties);
      if (!properties || Object.keys(properties).some((key) => UNSAFE_OBJECT_KEYS.has(key))) {
        throw new AppError("VALIDATION_ERROR", `Skill ${label} properties are invalid.`, 400);
      }
      for (const child of Object.values(properties)) visit(child, depth + 1);
    }
    if (shape.required !== undefined) {
      if (
        !Array.isArray(shape.required) ||
        shape.required.some((key) => typeof key !== "string" || UNSAFE_OBJECT_KEYS.has(key)) ||
        new Set(shape.required).size !== shape.required.length ||
        (shape.properties !== undefined &&
          shape.required.some((key) => !Object.hasOwn(shape.properties as object, key)))
      ) {
        throw new AppError("VALIDATION_ERROR", `Skill ${label} required keys are invalid.`, 400);
      }
    }
  };
  visit(schema, 0);
}

function parsePublicationRateLimit(value: unknown): SkillDefinition["rateLimit"] {
  const raw = value === undefined ? {} : asRecord(value);
  if (!raw || Object.keys(raw).some((key) => key !== "maxRequests" && key !== "windowSeconds")) {
    throw new AppError("VALIDATION_ERROR", "Skill rateLimit settings are invalid.", 400);
  }
  return {
    maxRequests: optionalInteger(raw.maxRequests, 30, 1, 100_000, "rateLimit.maxRequests"),
    windowSeconds: optionalInteger(raw.windowSeconds, 60, 1, 86_400, "rateLimit.windowSeconds"),
  };
}

function parsePublicationRetryPolicy(value: unknown): SkillDefinition["retryPolicy"] {
  const raw = value === undefined ? {} : asRecord(value);
  if (
    !raw ||
    Object.keys(raw).some((key) => !["maxAttempts", "backoffMs", "idempotent", "retryableStatusCodes"].includes(key))
  ) {
    throw new AppError("VALIDATION_ERROR", "Skill retryPolicy settings are invalid.", 400);
  }
  const retryableStatusCodes = raw.retryableStatusCodes ?? [429, 500, 502, 503, 504];
  if (
    !Array.isArray(retryableStatusCodes) ||
    retryableStatusCodes.length > 50 ||
    retryableStatusCodes.some(
      (status) => !Number.isSafeInteger(status) || (status as number) < 400 || (status as number) > 599,
    ) ||
    new Set(retryableStatusCodes).size !== retryableStatusCodes.length ||
    (raw.idempotent !== undefined && typeof raw.idempotent !== "boolean")
  ) {
    throw new AppError("VALIDATION_ERROR", "Skill retry status codes or idempotency are invalid.", 400);
  }
  return {
    maxAttempts: optionalInteger(raw.maxAttempts, 1, 1, 4, "retryPolicy.maxAttempts"),
    backoffMs: optionalInteger(raw.backoffMs, 250, 0, 5_000, "retryPolicy.backoffMs"),
    idempotent: raw.idempotent === true,
    retryableStatusCodes: retryableStatusCodes as number[],
  };
}

function optionalInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AppError("VALIDATION_ERROR", `Skill ${label} is outside the allowed range.`, 400);
  }
  return value as number;
}

function requiredText(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    (pattern && !pattern.test(value))
  ) {
    throw new AppError("VALIDATION_ERROR", `Skill ${label} is invalid.`, 400);
  }
  return value.trim();
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
