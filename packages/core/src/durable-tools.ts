import { AppError } from "./errors.js";
import { decodeGeneratedImageDataUrl, isGeneratedImageDataUrl } from "./image-data.js";
import type { SecretStore, SecretWriter, ToolExecutionRepository } from "./ports.js";
import { getToolAttachments, withToolAttachments, type AgentToolRegistry, type ToolContext } from "./tools.js";
import type { AgentImageAttachment, ModelToolDefinition } from "./types.js";

const MAX_RESULT_BYTES = 16_384;
const MAX_ATTACHMENT_URL_LENGTH = 4_096;
const MAX_DURABLE_RESULT_BYTES = 1_050_000;
const MAX_EXECUTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_DURATION_MS = 150_000;

interface StoredToolResult {
  readonly version: 1;
  readonly value: unknown;
  readonly attachments: readonly AgentImageAttachment[];
}

export interface DurableToolRegistryOptions {
  readonly registry: AgentToolRegistry;
  readonly executions: ToolExecutionRepository;
  readonly secrets: SecretStore;
  readonly secretWriter: SecretWriter;
  readonly now?: () => Date;
}

/** Persists successful tool results encrypted so retries of the same request do not repeat completed effects. */
export class DurableToolRegistry implements AgentToolRegistry {
  readonly #registry: AgentToolRegistry;
  readonly #executions: ToolExecutionRepository;
  readonly #secrets: SecretStore;
  readonly #secretWriter: SecretWriter;
  readonly #now: () => Date;

  constructor(options: DurableToolRegistryOptions) {
    this.#registry = options.registry;
    this.#executions = options.executions;
    this.#secrets = options.secrets;
    this.#secretWriter = options.secretWriter;
    this.#now = options.now ?? (() => new Date());
  }

  available(context: ToolContext): Promise<readonly ModelToolDefinition[]> {
    return this.#registry.available(context);
  }

  promptInstructions(context: ToolContext): Promise<readonly string[]> {
    return this.#registry.promptInstructions?.(context) ?? Promise.resolve([]);
  }

  async execute(context: ToolContext, name: string, input: unknown): Promise<unknown> {
    const executionKey = context.executionKey;
    if (!executionKey) return this.#registry.execute(context, name, input);
    if (!/^[a-f0-9]{64}$/.test(executionKey)) {
      throw new AppError("VALIDATION_ERROR", "Tool execution identity is invalid.", 400);
    }

    const now = this.#now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + MAX_EXECUTION_AGE_MS).toISOString();
    const leaseToken = crypto.randomUUID();
    const [inputHash] = await Promise.all([hash(canonicalJson(input))]);
    const purgedRefs = await this.#executions.purgeExpired(context.tenantId, nowIso, 100);
    await this.#deleteRefs(context.tenantId, purgedRefs);

    const acquired = await this.#executions.acquire({
      tenantId: context.tenantId,
      botId: context.botId,
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      executionKey,
      toolName: name,
      inputHash,
      leaseToken,
      now: nowIso,
      leaseUntil: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
      expiresAt,
    });
    if (acquired.state === "busy") {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "This tool call is already running.", 503);
    }
    if (acquired.state === "ambiguous") {
      throw new AppError(
        "CONFLICT",
        "This tool call may already have taken effect. Review Tool recovery before retrying it.",
        409,
      );
    }
    if (acquired.state === "closed") {
      throw new AppError("CONFLICT", "This tool call was closed during recovery and cannot be retried.", 409);
    }
    if (acquired.state === "completed") {
      const stored = await this.#readResult(context.tenantId, acquired.resultRef);
      return restoreResult(stored);
    }
    let completed = false;
    let resultRef: string | undefined;
    try {
      if (acquired.replacedResultRef) await this.#secretWriter.delete(context.tenantId, acquired.replacedResultRef);
      const result = await this.#registry.execute(context, name, input);
      const stored = normalizeResult(result, getToolAttachments(result));
      const serialized = JSON.stringify(stored);
      if (stored.attachments.some((attachment) => isGeneratedImageDataUrl(attachment.url))) {
        if (!this.#secretWriter.putLarge) {
          throw new AppError("UNSUPPORTED_CAPABILITY", "Encrypted image attachment storage is unavailable.", 501);
        }
        resultRef = await this.#secretWriter.putLarge(context.tenantId, serialized);
      } else {
        resultRef = await this.#secretWriter.put(context.tenantId, serialized);
      }
      const saved = await this.#executions.complete({
        tenantId: context.tenantId,
        botId: context.botId,
        executionKey,
        leaseToken,
        resultRef,
        now: this.#now().toISOString(),
        expiresAt,
      });
      if (!saved) {
        await this.#secretWriter.delete(context.tenantId, resultRef);
        resultRef = undefined;
        throw new AppError("CONFLICT", "Tool execution lease was lost before its result was saved.", 409);
      }
      completed = true;
      return restoreResult(stored);
    } finally {
      if (!completed) {
        if (resultRef) await this.#secretWriter.delete(context.tenantId, resultRef);
        await this.#executions.release({
          tenantId: context.tenantId,
          botId: context.botId,
          executionKey,
          leaseToken,
          now: this.#now().toISOString(),
        });
      }
    }
  }

  async #readResult(tenantId: ToolContext["tenantId"], reference: string): Promise<StoredToolResult> {
    const serialized = await this.#secrets.resolve(tenantId, reference);
    try {
      const value: unknown = JSON.parse(serialized);
      if (!isStoredToolResult(value)) throw new Error("Invalid stored result envelope");
      return value;
    } catch (cause) {
      throw new AppError("INTERNAL_ERROR", "Stored tool result could not be read.", 500, { cause });
    }
  }

  async #deleteRefs(tenantId: ToolContext["tenantId"], refs: readonly string[]): Promise<void> {
    for (const ref of refs) await this.#secretWriter.delete(tenantId, ref);
  }
}

function normalizeResult(result: unknown, attachments: readonly AgentImageAttachment[]): StoredToolResult {
  let value: unknown;
  let boundedAttachments = attachments.slice(0, 4).map(validateAttachment);
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) value = null;
    else if (new TextEncoder().encode(serialized).byteLength > MAX_RESULT_BYTES) {
      value = { error: "RESULT_TOO_LARGE" };
      boundedAttachments = [];
    } else value = JSON.parse(serialized);
  } catch {
    value = { error: "RESULT_NOT_SERIALIZABLE" };
    boundedAttachments = [];
  }
  if (boundedAttachments.length && (value === null || typeof value !== "object")) {
    throw new AppError("INTERNAL_ERROR", "Tool attachments require an object result.", 500);
  }
  const stored = { version: 1 as const, value, attachments: boundedAttachments };
  if (new TextEncoder().encode(JSON.stringify(stored)).byteLength > MAX_DURABLE_RESULT_BYTES) {
    return { version: 1, value: { error: "RESULT_TOO_LARGE" }, attachments: [] };
  }
  return stored;
}

function restoreResult(stored: StoredToolResult): unknown {
  if (stored.attachments.length && stored.value !== null && typeof stored.value === "object") {
    return withToolAttachments(stored.value, stored.attachments);
  }
  return stored.value;
}

function validateAttachment(attachment: AgentImageAttachment): AgentImageAttachment {
  const isHttpImage =
    typeof attachment.url === "string" &&
    attachment.url.length <= MAX_ATTACHMENT_URL_LENGTH &&
    isHttpsUrl(attachment.url);
  if (
    attachment.kind !== "image" ||
    typeof attachment.url !== "string" ||
    attachment.url.length > MAX_DURABLE_RESULT_BYTES ||
    (!isHttpImage && !decodeGeneratedImageDataUrl(attachment.url)) ||
    (attachment.alt !== undefined && (typeof attachment.alt !== "string" || attachment.alt.length > 500))
  ) {
    throw new AppError("VALIDATION_ERROR", "Tool returned an invalid attachment.", 502);
  }
  return { kind: "image", url: attachment.url, ...(attachment.alt === undefined ? {} : { alt: attachment.alt }) };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isStoredToolResult(value: unknown): value is StoredToolResult {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Object.hasOwn(record, "value") ||
    !Array.isArray(record.attachments) ||
    record.attachments.length > 4
  )
    return false;
  try {
    for (const attachment of record.attachments) validateAttachment(attachment as AgentImageAttachment);
    return true;
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AppError("VALIDATION_ERROR", "Tool input contains an invalid number.", 400);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new AppError("VALIDATION_ERROR", "Tool input is not JSON serializable.", 400);
}

async function hash(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
