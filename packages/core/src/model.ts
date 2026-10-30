import { AppError } from "./errors.js";
import type { ModelConfig, ModelToolDefinition, ModelTurn, ConversationMessage, TenantId } from "./types.js";
import type { SecretStore } from "./ports.js";

export interface ProviderCapabilities {
  readonly toolCalling: boolean;
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
}

export interface ModelProvider {
  readonly id: string;
  capabilities(config: ModelConfig): ProviderCapabilities;
  complete(input: {
    readonly tenantId: TenantId;
    readonly config: ModelConfig;
    readonly messages: readonly ConversationMessage[];
    readonly tools?: readonly ModelToolDefinition[];
    readonly signal?: AbortSignal;
  }): Promise<ModelTurn>;
}

export class ModelProviderRegistry {
  readonly #providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    if (this.#providers.has(provider.id)) {
      throw new AppError("CONFLICT", `Model provider '${provider.id}' is already registered.`, 409);
    }
    this.#providers.set(provider.id, provider);
  }

  get(providerId: string): ModelProvider {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", `Model provider '${providerId}' is not configured.`, 503);
    }
    return provider;
  }
}

export interface OpenAICompatibleProviderOptions {
  readonly id: string;
  readonly defaultEndpoint: string;
  /** Exact origins approved by the operator. Tenant-provided arbitrary URLs are never fetched. */
  readonly allowedOrigins: ReadonlySet<string>;
  readonly secrets: SecretStore;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  /** Set only after the endpoint has been checked for this deployment/provider. */
  readonly toolCalling?: boolean;
}

interface OpenAIResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly role?: unknown;
      readonly content?: unknown;
      readonly tool_calls?: readonly {
        readonly id?: unknown;
        readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
      }[];
    };
  }[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
}

/** OpenAI chat-completions adapter with strict egress, timeout, and redirect controls. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly #defaultEndpoint: string;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #secrets: SecretStore;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #timeoutMs: number;
  readonly #capabilities: ProviderCapabilities;

  constructor(options: OpenAICompatibleProviderOptions) {
    if (!Number.isInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1) {
      throw new AppError("VALIDATION_ERROR", "Model request timeout must be a positive integer.", 400);
    }
    this.id = options.id;
    this.#defaultEndpoint = options.defaultEndpoint;
    this.#allowedOrigins = new Set([...options.allowedOrigins].map((origin) => new URL(origin).origin));
    this.#secrets = options.secrets;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#capabilities = {
      toolCalling: options.toolCalling ?? false,
      streaming: false,
      structuredOutput: false,
    };
  }

  capabilities(_config: ModelConfig): ProviderCapabilities {
    return this.#capabilities;
  }

  async complete(input: {
    readonly tenantId: TenantId;
    readonly config: ModelConfig;
    readonly messages: readonly ConversationMessage[];
    readonly tools?: readonly ModelToolDefinition[];
    readonly signal?: AbortSignal;
  }): Promise<ModelTurn> {
    const credentialRef = input.config.credentialRef;
    if (!credentialRef) {
      throw new AppError("VALIDATION_ERROR", "A model credential reference is required.", 400);
    }
    if (input.tools?.length && !this.#capabilities.toolCalling) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "This model endpoint is not configured for tool calling.", 501);
    }

    const endpoint = input.config.endpoint ?? this.#defaultEndpoint;
    const target = this.#completionUrl(endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Model request timed out")), this.#timeoutMs);
    const abortFromCaller = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (input.signal?.aborted) abortFromCaller();

    try {
      const apiKey = await this.#secrets.resolve(input.tenantId, credentialRef, controller.signal);
      if (!apiKey.trim()) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "The configured model credential is unavailable.", 503);
      }
      const parameters = input.config.parameters ?? {};
      const body: Record<string, unknown> = {
        model: input.config.model,
        messages: input.messages.map(toOpenAIMessage),
      };
      const allowedParameters = new Set([
        "temperature",
        "top_p",
        "max_tokens",
        "max_completion_tokens",
        "presence_penalty",
        "frequency_penalty",
        "seed",
      ]);
      for (const [key, value] of Object.entries(parameters)) {
        if (!allowedParameters.has(key)) {
          throw new AppError("VALIDATION_ERROR", `Unsupported model parameter '${key}'.`, 400);
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new AppError("VALIDATION_ERROR", `Model parameter '${key}' must be a finite number.`, 400);
        }
        if ((key === "max_tokens" || key === "max_completion_tokens") && (!Number.isSafeInteger(value) || value < 1)) {
          throw new AppError("VALIDATION_ERROR", `Model parameter '${key}' must be a positive integer.`, 400);
        }
        if (key === "temperature" && (value < 0 || value > 2)) {
          throw new AppError("VALIDATION_ERROR", "Model temperature must be between 0 and 2.", 400);
        }
        if (key === "top_p" && (value < 0 || value > 1)) {
          throw new AppError("VALIDATION_ERROR", "Model top_p must be between 0 and 1.", 400);
        }
        body[key] = value;
      }
      if (input.tools?.length) {
        body.tools = input.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        }));
      }

      const response = await this.#fetch(target, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", `Model provider returned HTTP ${response.status}.`, 502);
      }

      let payload: OpenAIResponse;
      try {
        payload = (await response.json()) as OpenAIResponse;
      } catch (cause) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned invalid JSON.", 502, { cause });
      }

      const choice = payload.choices?.[0]?.message;
      if (!choice || (typeof choice.content !== "string" && choice.content !== null && choice.content !== undefined)) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an invalid completion.", 502);
      }
      const toolCalls = (choice.tool_calls ?? []).map((call) => {
        if (
          typeof call.id !== "string" ||
          typeof call.function?.name !== "string" ||
          typeof call.function.arguments !== "string"
        ) {
          throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an invalid tool call.", 502);
        }
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments);
        } catch (cause) {
          throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned malformed tool arguments.", 502, {
            cause,
          });
        }
        return { id: call.id, name: call.function.name, arguments: args };
      });
      if (toolCalls.length && !this.#capabilities.toolCalling) {
        throw new AppError(
          "DEPENDENCY_UNAVAILABLE",
          "Model returned tool calls despite tool calling being disabled.",
          502,
        );
      }

      const promptTokens = payload.usage?.prompt_tokens;
      const completionTokens = payload.usage?.completion_tokens;
      return {
        message: { role: "assistant", content: typeof choice.content === "string" ? choice.content : "" },
        toolCalls,
        ...(typeof promptTokens === "number" &&
        Number.isSafeInteger(promptTokens) &&
        promptTokens >= 0 &&
        typeof completionTokens === "number" &&
        Number.isSafeInteger(completionTokens) &&
        completionTokens >= 0
          ? { usage: { inputTokens: promptTokens, outputTokens: completionTokens } }
          : {}),
      };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider request failed.", 502, { cause });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  #completionUrl(endpoint: string): string {
    let base: URL;
    try {
      base = new URL(endpoint);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", "Model endpoint must be an absolute URL.", 400, { cause });
    }
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Model endpoint must use HTTPS and cannot contain credentials, query, or fragment.",
        400,
      );
    }
    if (!this.#allowedOrigins.has(base.origin)) {
      throw new AppError("FORBIDDEN", "Model endpoint origin is not approved by the deployment network policy.", 403);
    }
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/chat/completions`;
    return base.toString();
  }
}

function toOpenAIMessage(message: ConversationMessage): Record<string, unknown> {
  const result: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.name) result.name = message.name;
  if (message.toolCallId) result.tool_call_id = message.toolCallId;
  if (message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return result;
}
