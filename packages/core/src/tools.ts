import { AppError } from "./errors.js";
import type { AgentActorContext, AgentImageAttachment, ModelToolDefinition, TenantId, BotId, UserId } from "./types.js";

const toolResultAttachments = new WeakMap<object, readonly AgentImageAttachment[]>();

/** Mark trusted tool output for delivery beside the assistant message without serializing URLs into model context. */
export function withToolAttachments<T extends object>(result: T, attachments: readonly AgentImageAttachment[]): T {
  const bounded = attachments.slice(0, 4).map((attachment) => Object.freeze({ ...attachment }));
  toolResultAttachments.set(result, Object.freeze(bounded));
  return result;
}

export function getToolAttachments(result: unknown): readonly AgentImageAttachment[] {
  return result !== null && typeof result === "object" ? (toolResultAttachments.get(result) ?? []) : [];
}

export interface ToolContext extends AgentActorContext {
  readonly tenantId: TenantId;
  readonly botId: BotId;
  readonly actorId: UserId;
  readonly signal?: AbortSignal;
  /** Stable for one model-issued tool call and reused when an API request or webhook is retried. */
  readonly executionKey?: string;
}

export interface ToolPermissionChecker {
  isAllowed(context: ToolContext, permission: string): Promise<boolean>;
}

export interface ToolDefinition extends ModelToolDefinition {
  readonly requiredPermissions: readonly string[];
  readonly timeoutMs: number;
  readonly parseInput: (input: unknown) => unknown;
  readonly execute: (context: ToolContext, input: unknown, signal: AbortSignal) => Promise<unknown>;
}

export interface AgentToolRegistry {
  available(context: ToolContext): Promise<readonly ModelToolDefinition[]>;
  execute(context: ToolContext, name: string, input: unknown): Promise<unknown>;
  promptInstructions?(context: ToolContext): Promise<readonly string[]>;
}

/** Combines independent tool backends while rejecting ambiguous model tool names. */
export class CombinedToolRegistry implements AgentToolRegistry {
  readonly #registries: readonly AgentToolRegistry[];

  constructor(registries: readonly AgentToolRegistry[]) {
    this.#registries = registries;
  }

  async available(context: ToolContext): Promise<readonly ModelToolDefinition[]> {
    const byName = new Map<string, ModelToolDefinition>();
    for (const registry of this.#registries) {
      for (const tool of await registry.available(context)) {
        if (byName.has(tool.name)) {
          throw new AppError("CONFLICT", `Tool '${tool.name}' is registered by more than one backend.`, 500);
        }
        byName.set(tool.name, tool);
      }
    }
    return [...byName.values()];
  }

  async execute(context: ToolContext, name: string, input: unknown): Promise<unknown> {
    const providers = [];
    for (const registry of this.#registries) {
      if ((await registry.available(context)).some((tool) => tool.name === name)) providers.push(registry);
    }
    if (providers.length !== 1) {
      throw new AppError(
        providers.length === 0 ? "FORBIDDEN" : "CONFLICT",
        "The requested tool is unavailable.",
        providers.length === 0 ? 403 : 500,
      );
    }
    const [provider] = providers;
    if (!provider) throw new AppError("FORBIDDEN", "The requested tool is unavailable.", 403);
    return provider.execute(context, name, input);
  }

  async promptInstructions(context: ToolContext): Promise<readonly string[]> {
    const instructions: string[] = [];
    for (const registry of this.#registries) {
      if (registry.promptInstructions) instructions.push(...(await registry.promptInstructions(context)));
    }
    return instructions;
  }
}

export class ToolRegistry implements AgentToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #permissions: ToolPermissionChecker;

  constructor(permissions: ToolPermissionChecker) {
    this.#permissions = permissions;
  }

  register(tool: ToolDefinition): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name)) {
      throw new AppError("VALIDATION_ERROR", "Tool names must be 1–64 safe identifier characters.", 400);
    }
    if (!Number.isSafeInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 120_000) {
      throw new AppError("VALIDATION_ERROR", "Tool timeout must be between 1 and 120000 milliseconds.", 400);
    }
    if (this.#tools.has(tool.name)) {
      throw new AppError("CONFLICT", `Tool '${tool.name}' is already registered.`, 409);
    }
    this.#tools.set(tool.name, tool);
  }

  async available(context: ToolContext): Promise<readonly ModelToolDefinition[]> {
    const result: ModelToolDefinition[] = [];
    for (const tool of this.#tools.values()) {
      if (await this.#hasPermissions(context, tool)) {
        result.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      }
    }
    return result;
  }

  async promptInstructions(_context: ToolContext): Promise<readonly string[]> {
    return [];
  }

  async execute(context: ToolContext, name: string, input: unknown): Promise<unknown> {
    const tool = this.#tools.get(name);
    if (!tool) throw new AppError("FORBIDDEN", "The requested tool is not installed for this bot.", 403);
    if (!(await this.#hasPermissions(context, tool))) {
      throw new AppError("FORBIDDEN", "The actor is not authorized to use this tool.", 403);
    }

    let parsed: unknown;
    try {
      parsed = tool.parseInput(input);
    } catch {
      throw new AppError("VALIDATION_ERROR", "Tool input did not match its schema.", 400);
    }

    const controller = new AbortController();
    const abortFromContext = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", abortFromContext, { once: true });
    if (context.signal?.aborted) abortFromContext();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled: (() => void) | undefined;
    const cancelled = context.signal
      ? new Promise<never>((_, reject) => {
          rejectCancelled = () => reject(new AppError("DEPENDENCY_UNAVAILABLE", "Tool execution was cancelled.", 504));
          if (context.signal?.aborted) rejectCancelled();
          else context.signal?.addEventListener("abort", rejectCancelled, { once: true });
        })
      : new Promise<never>(() => undefined);
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort(new Error("Tool execution timed out"));
          reject(new AppError("DEPENDENCY_UNAVAILABLE", "Tool execution timed out.", 504));
        }, tool.timeoutMs);
      });
      return await Promise.race([tool.execute(context, parsed, controller.signal), timeout, cancelled]);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Tool execution failed.", 502, { cause });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      context.signal?.removeEventListener("abort", abortFromContext);
      if (rejectCancelled) context.signal?.removeEventListener("abort", rejectCancelled);
    }
  }

  async #hasPermissions(context: ToolContext, tool: ToolDefinition): Promise<boolean> {
    for (const permission of tool.requiredPermissions) {
      if (!(await this.#permissions.isAllowed(context, permission))) return false;
    }
    return true;
  }
}
