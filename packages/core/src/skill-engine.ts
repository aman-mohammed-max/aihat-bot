import { AppError, unsupportedCapability } from "./errors.js";
import type { SecretStore, SkillRateLimiter, SkillRepository } from "./ports.js";
import type { InstalledSkill, ModelToolDefinition, SkillDefinition } from "./types.js";
import type { AgentToolRegistry, ToolContext } from "./tools.js";

const MAX_HTTP_RESPONSE_BYTES = 1_048_576;
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "set-cookie",
]);

export type NativeSkillHandler = (
  context: ToolContext,
  input: unknown,
  signal: AbortSignal,
  installation: InstalledSkill,
) => Promise<unknown>;

export interface SkillEngineOptions {
  readonly skills: SkillRepository;
  readonly rateLimiter: SkillRateLimiter;
  readonly secrets: SecretStore;
  readonly allowedHttpOrigins: ReadonlySet<string>;
  readonly nativeHandlers?: ReadonlyMap<string, NativeSkillHandler>;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/** Tenant-scoped installed skills exposed to the agent as authorized tools or prompt additions. */
export class SkillEngine implements AgentToolRegistry {
  readonly #skills: SkillRepository;
  readonly #rateLimiter: SkillRateLimiter;
  readonly #secrets: SecretStore;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #nativeHandlers: ReadonlyMap<string, NativeSkillHandler>;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: SkillEngineOptions) {
    this.#skills = options.skills;
    this.#rateLimiter = options.rateLimiter;
    this.#secrets = options.secrets;
    this.#allowedOrigins = normalizeAllowedOrigins(options.allowedHttpOrigins);
    this.#nativeHandlers = options.nativeHandlers ?? new Map();
    this.#fetch = options.fetch ?? fetch;
  }

  async available(context: ToolContext): Promise<readonly ModelToolDefinition[]> {
    const installed = await this.#skills.listInstalled(context.tenantId, context.botId);
    const result: ModelToolDefinition[] = [];
    const names = new Set<string>();
    for (const skill of installed) {
      if (!canUse(skill, context) || skill.definition.executionType === "prompt") continue;
      if (!isSupported(skill.definition, this.#nativeHandlers)) continue;
      if (skill.definition.executionType === "http" && !this.#isHttpAllowed(skill)) continue;
      const name = await toolName(skill.definition.id);
      if (names.has(name)) throw new AppError("CONFLICT", "Installed skills have colliding tool identifiers.", 409);
      names.add(name);
      result.push({ name, description: skill.definition.description, inputSchema: skill.definition.inputSchema });
    }
    return result;
  }

  async promptInstructions(context: ToolContext): Promise<readonly string[]> {
    const installed = await this.#skills.listInstalled(context.tenantId, context.botId);
    return installed
      .filter((item) => item.definition.executionType === "prompt" && canUse(item, context))
      .map((item) => item.definition.configuration.instructions)
      .filter(
        (instruction): instruction is string =>
          typeof instruction === "string" && instruction.length > 0 && instruction.length <= 12_000,
      );
  }

  async execute(context: ToolContext, name: string, input: unknown): Promise<unknown> {
    const installed = await this.#skills.listInstalled(context.tenantId, context.botId);
    let skill: InstalledSkill | undefined;
    for (const candidate of installed) {
      if ((await toolName(candidate.definition.id)) === name) {
        skill = candidate;
        break;
      }
    }
    if (!skill || !canUse(skill, context) || skill.definition.executionType === "prompt") {
      throw new AppError("FORBIDDEN", "The requested skill is not installed or authorized for this actor.", 403);
    }
    if (!isSupported(skill.definition, this.#nativeHandlers)) {
      throw unsupportedCapability(skill.definition.executionType, "current runtime");
    }
    if (skill.definition.executionType === "http" && !this.#isHttpAllowed(skill)) {
      throw new AppError("FORBIDDEN", "HTTP skill endpoint origin is not approved by the deployment.", 403);
    }
    const parsedInput = validateJsonSchema(input, skill.definition.inputSchema, "input", true);
    const allowed = await this.#rateLimiter.consume({
      tenantId: context.tenantId,
      botId: context.botId,
      skillId: skill.definition.id,
      now: Date.now(),
      maxRequests: skill.definition.rateLimit.maxRequests,
      windowSeconds: skill.definition.rateLimit.windowSeconds,
    });
    if (!allowed) throw new AppError("RATE_LIMITED", "Skill request rate limit was reached.", 429);

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const handler = this.#nativeHandlers.get(skill.definition.id);
      const execution = handler
        ? handler(context, parsedInput, controller.signal, skill)
        : this.#executeHttp(skill, context, parsedInput, controller.signal);
      const timeoutResult = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error("Skill execution timed out."));
          reject(new AppError("DEPENDENCY_UNAVAILABLE", "Skill execution timed out.", 504));
        }, skill.definition.timeoutMs);
      });
      const result = await Promise.race([execution, timeoutResult]);
      return validateJsonSchema(result, skill.definition.outputSchema, "output", false);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (controller.signal.aborted) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill execution timed out or was cancelled.", 504);
      }
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill execution failed.", 502, { cause });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async #executeHttp(
    skill: InstalledSkill,
    context: ToolContext,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const config = this.#httpConfiguration(skill);
    const endpoint = new URL(config.endpoint);
    if (!this.#allowedOrigins.has(endpoint.origin)) {
      throw new AppError("FORBIDDEN", "HTTP skill endpoint origin is not approved by the deployment.", 403);
    }
    const method = config.method;
    const record = input as Record<string, unknown>;
    if (method === "GET" || method === "DELETE") {
      for (const [key, value] of Object.entries(record)) {
        endpoint.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }

    const headers = new Headers();
    const staticHeaders = config.headers ?? {};
    for (const [name, value] of Object.entries(staticHeaders)) {
      validateHeader(name, value);
      headers.set(name, value);
    }
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (method !== "GET" && method !== "DELETE" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const secretRef = skill.configuration.credentialRef;
    const authentication = config.authentication;
    if (authentication.required && !secretRef) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill requires an encrypted credential reference.", 400);
    }
    if (secretRef !== undefined) {
      if (typeof secretRef !== "string" || !/^secret_[a-f0-9]{32}$/.test(secretRef)) {
        throw new AppError("VALIDATION_ERROR", "Installed skill credential reference is invalid.", 400);
      }
      const credential = await this.#secrets.resolve(context.tenantId, secretRef, signal);
      validateCredentialValue(credential);
      if (authentication.type === "none") {
        throw new AppError("VALIDATION_ERROR", "HTTP skill does not accept a credential reference.", 400);
      }
      if (authentication.type === "bearer") {
        headers.set("authorization", `Bearer ${credential}`);
      } else if (authentication.type === "header") {
        headers.set(authentication.header, credential);
      }
    }

    const retry = skill.definition.retryPolicy;
    if (!retry.idempotent && retry.maxAttempts > 1 && !config.idempotencyKeyHeader) {
      throw new AppError("VALIDATION_ERROR", "Non-idempotent HTTP skill retries need an idempotency-key header.", 400);
    }
    const idempotencyKey = retry.maxAttempts > 1 ? crypto.randomUUID() : undefined;
    if (idempotencyKey && config.idempotencyKeyHeader) {
      validateHeader(config.idempotencyKeyHeader, idempotencyKey);
      headers.set(config.idempotencyKeyHeader, idempotencyKey);
    }

    let lastStatus = 0;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      if (signal.aborted) throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill request was cancelled.", 504);
      let response: Response;
      try {
        response = await this.#fetch(endpoint, {
          method,
          headers,
          redirect: "error",
          signal,
          ...("GET" === method || "DELETE" === method ? {} : { body: JSON.stringify(input) }),
        });
      } catch (cause) {
        if (signal.aborted) throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill request timed out.", 504);
        if (attempt === retry.maxAttempts) {
          throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill request failed.", 502, { cause });
        }
        await delay(retry.backoffMs * 2 ** (attempt - 1), signal);
        continue;
      }

      lastStatus = response.status;
      if (retry.retryableStatusCodes.includes(response.status) && attempt < retry.maxAttempts) {
        await response.body?.cancel();
        await delay(retry.backoffMs * 2 ** (attempt - 1), signal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", `HTTP skill returned status ${response.status}.`, 502);
      }
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "application/json" && !contentType.endsWith("+json")) {
        await response.body?.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill returned a non-JSON response.", 502);
      }
      return await readBoundedJson(response);
    }
    throw new AppError("DEPENDENCY_UNAVAILABLE", `HTTP skill retries ended at status ${lastStatus}.`, 502);
  }

  #httpConfiguration(skill: InstalledSkill): HttpSkillConfiguration {
    if (skill.definition.executionType !== "http") {
      throw new AppError("VALIDATION_ERROR", "Skill is not configured for HTTP execution.", 400);
    }
    const raw = skill.definition.configuration.http;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill configuration is invalid.", 400);
    }
    const config = raw as Record<string, unknown>;
    if (
      typeof config.endpoint !== "string" ||
      typeof config.method !== "string" ||
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(config.method)
    ) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill endpoint or method is invalid.", 400);
    }
    let endpoint: URL;
    try {
      endpoint = new URL(config.endpoint);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill endpoint must be an absolute URL.", 400, { cause });
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill endpoints must use HTTPS without query or credentials.", 400);
    }
    const headers = config.headers;
    if (headers !== undefined && (!headers || typeof headers !== "object" || Array.isArray(headers))) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill headers are invalid.", 400);
    }
    if (headers !== undefined) {
      if (Object.keys(headers).length > 64) {
        throw new AppError("VALIDATION_ERROR", "HTTP skill has too many static headers.", 400);
      }
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== "string") {
          throw new AppError("VALIDATION_ERROR", "HTTP skill header values must be strings.", 400);
        }
        validateHeader(name, value);
      }
    }
    const rawAuthentication = config.authentication;
    let authentication: HttpSkillAuthentication = { type: "bearer", required: false };
    if (rawAuthentication !== undefined) {
      if (!rawAuthentication || typeof rawAuthentication !== "object" || Array.isArray(rawAuthentication)) {
        throw new AppError("VALIDATION_ERROR", "HTTP skill authentication settings are invalid.", 400);
      }
      const auth = rawAuthentication as Record<string, unknown>;
      if (
        !(["none", "bearer", "header"] as unknown[]).includes(auth.type) ||
        (auth.required !== undefined && typeof auth.required !== "boolean")
      ) {
        throw new AppError("VALIDATION_ERROR", "HTTP skill authentication settings are invalid.", 400);
      }
      if (auth.type === "header") {
        if (typeof auth.header !== "string") {
          throw new AppError("VALIDATION_ERROR", "HTTP skill credential header is invalid.", 400);
        }
        validateCredentialHeaderName(auth.header);
        authentication = { type: "header", header: auth.header, required: auth.required === true };
      } else {
        if (auth.header !== undefined) {
          throw new AppError("VALIDATION_ERROR", "HTTP skill authentication header is not applicable.", 400);
        }
        if (auth.type === "none" && auth.required === true) {
          throw new AppError("VALIDATION_ERROR", "Unauthenticated HTTP skills cannot require credentials.", 400);
        }
        authentication = { type: auth.type as "none" | "bearer", required: auth.required === true };
      }
    }
    const idempotencyKeyHeader = config.idempotencyKeyHeader;
    if (idempotencyKeyHeader !== undefined && typeof idempotencyKeyHeader !== "string") {
      throw new AppError("VALIDATION_ERROR", "HTTP skill idempotency header is invalid.", 400);
    }
    if (typeof idempotencyKeyHeader === "string") validateHeader(idempotencyKeyHeader, "idempotency-check");
    return {
      endpoint: endpoint.toString(),
      method: config.method as HttpSkillConfiguration["method"],
      authentication,
      ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
      ...(idempotencyKeyHeader === undefined ? {} : { idempotencyKeyHeader }),
    };
  }

  #isHttpAllowed(skill: InstalledSkill): boolean {
    const config = this.#httpConfiguration(skill);
    return this.#allowedOrigins.has(new URL(config.endpoint).origin);
  }
}

interface HttpSkillConfiguration {
  readonly endpoint: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly authentication: HttpSkillAuthentication;
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKeyHeader?: string;
}

type HttpSkillAuthentication =
  | { readonly type: "none" | "bearer"; readonly required: boolean }
  | { readonly type: "header"; readonly header: string; readonly required: boolean };

function canUse(skill: InstalledSkill, context: ToolContext): boolean {
  if (
    !skill.enabled ||
    !skill.definition.enabled ||
    (skill.definition.tenantId !== null && skill.definition.tenantId !== context.tenantId)
  ) {
    return false;
  }
  return skill.definition.requiredPermissions.every((permission) => skill.grantedPermissions.includes(permission));
}

function isSupported(definition: SkillDefinition, handlers: ReadonlyMap<string, NativeSkillHandler>): boolean {
  if (definition.executionType === "http") return true;
  if (definition.executionType === "native") return handlers.has(definition.id);
  return false;
}

async function toolName(skillId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(skillId)));
  const suffix = Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const prefix = skillId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "installed";
  return `skill_${prefix}_${suffix}`;
}

export function validateJsonSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  strict: boolean,
): unknown {
  let visited = 0;
  const visit = (current: unknown, currentSchema: unknown, currentPath: string, depth: number): void => {
    visited += 1;
    if (
      visited > 1000 ||
      depth > 16 ||
      !currentSchema ||
      typeof currentSchema !== "object" ||
      Array.isArray(currentSchema)
    ) {
      throw new AppError("VALIDATION_ERROR", `Skill ${path} schema is invalid or too complex.`, 400);
    }
    const shape = currentSchema as Record<string, unknown>;
    const type = shape.type;
    const validType =
      type === undefined ||
      (type === "object" && current !== null && typeof current === "object" && !Array.isArray(current)) ||
      (type === "array" && Array.isArray(current)) ||
      (type === "string" && typeof current === "string") ||
      (type === "boolean" && typeof current === "boolean") ||
      (type === "integer" && typeof current === "number" && Number.isSafeInteger(current)) ||
      (type === "number" && typeof current === "number" && Number.isFinite(current)) ||
      (type === "null" && current === null);
    if (!validType)
      throw new AppError("VALIDATION_ERROR", `Skill ${path} did not match its schema at ${currentPath}.`, 400);
    if (Array.isArray(shape.enum) && !shape.enum.some((item) => JSON.stringify(item) === JSON.stringify(current))) {
      throw new AppError("VALIDATION_ERROR", `Skill ${path} did not match its schema at ${currentPath}.`, 400);
    }
    if (typeof current === "string") {
      if (typeof shape.minLength === "number" && current.length < shape.minLength)
        throw invalidSchemaValue(path, currentPath);
      if (typeof shape.maxLength === "number" && current.length > shape.maxLength)
        throw invalidSchemaValue(path, currentPath);
    }
    if (typeof current === "number") {
      if (typeof shape.minimum === "number" && current < shape.minimum) throw invalidSchemaValue(path, currentPath);
      if (typeof shape.maximum === "number" && current > shape.maximum) throw invalidSchemaValue(path, currentPath);
    }
    if (Array.isArray(current)) {
      if (typeof shape.minItems === "number" && current.length < shape.minItems)
        throw invalidSchemaValue(path, currentPath);
      if (typeof shape.maxItems === "number" && current.length > shape.maxItems)
        throw invalidSchemaValue(path, currentPath);
      if (shape.items !== undefined) {
        current.forEach((item, index) => {
          visit(item, shape.items, `${currentPath}[${index}]`, depth + 1);
        });
      }
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      const properties = shape.properties;
      if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) {
        throw new AppError("VALIDATION_ERROR", `Skill ${path} schema has invalid properties.`, 400);
      }
      const propertySchemas = (properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(shape.required) ? shape.required : [];
      for (const key of required) {
        if (typeof key !== "string" || !(key in current))
          throw invalidSchemaValue(path, `${currentPath}.${String(key)}`);
      }
      for (const [key, item] of Object.entries(current)) {
        const propertySchema = propertySchemas[key];
        if (propertySchema === undefined) {
          if (strict && shape.additionalProperties !== true) throw invalidSchemaValue(path, `${currentPath}.${key}`);
        } else {
          visit(item, propertySchema, `${currentPath}.${key}`, depth + 1);
        }
      }
    }
  };
  visit(value, schema, "$", 0);
  return value;
}

function invalidSchemaValue(kind: string, path: string): AppError {
  return new AppError("VALIDATION_ERROR", `Skill ${kind} did not match its schema at ${path}.`, 400);
}

function normalizeAllowedOrigins(values: ReadonlySet<string>): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", "HTTP_SKILL_ALLOWED_ORIGINS contains an invalid origin.", 400, {
        cause,
      });
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill allowlist must contain HTTPS origins only.", 400);
    }
    origins.add(url.origin);
  }
  return origins;
}

function validateHeader(name: string, value: string): void {
  const lowerName = name.toLowerCase();
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
    FORBIDDEN_HEADERS.has(lowerName) ||
    /(?:^|[-_])(api[-_]?key|token|secret|password|authorization|auth)(?:$|[-_])/.test(lowerName) ||
    hasControlCharacters(value) ||
    value.length > 4096
  ) {
    throw new AppError("VALIDATION_ERROR", "HTTP skill contains an invalid or restricted header.", 400);
  }
}

function validateCredentialHeaderName(name: string): void {
  const lowerName = name.toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || FORBIDDEN_HEADERS.has(lowerName)) {
    throw new AppError("VALIDATION_ERROR", "HTTP skill credential header name is invalid.", 400);
  }
}

function validateCredentialValue(value: string): void {
  if (!value || value.length > 4096 || hasControlCharacters(value)) {
    throw new AppError("VALIDATION_ERROR", "Resolved HTTP skill credential is invalid.", 400);
  }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill response exceeded the size limit.", 502);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill response exceeded the size limit.", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill returned invalid JSON.", 502, { cause });
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill retry was cancelled.", 504);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new AppError("DEPENDENCY_UNAVAILABLE", "Skill retry was cancelled.", 504));
    };
    const timeout = setTimeout(finish, Math.min(milliseconds, 5_000));
    signal.addEventListener("abort", abort, { once: true });
  });
}
