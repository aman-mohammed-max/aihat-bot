import { AppError } from "./errors.js";
import { validateStructuredOutputSchema, validateStructuredOutputValue } from "./structured-output.js";
import type {
  JsonSchema,
  ModelConfig,
  ModelToolDefinition,
  ModelTurn,
  ConversationMessage,
  TenantId,
} from "./types.js";
import type { SecretStore } from "./ports.js";

export interface ProviderCapabilities {
  readonly toolCalling: boolean;
  readonly imageInput?: boolean;
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
    readonly responseSchema?: JsonSchema;
    readonly signal?: AbortSignal;
    readonly onTextDelta?: (delta: string) => void;
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
  /** Origins whose OpenAI-compatible SSE endpoint was verified by the operator. */
  readonly streamingOrigins?: ReadonlySet<string>;
  /** Origins whose strict JSON-schema response format was verified by the operator. */
  readonly structuredOutputOrigins?: ReadonlySet<string>;
  readonly secrets: SecretStore;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  readonly retryPolicy?: ModelRetryPolicy;
  /** Set only after the endpoint has been checked for this deployment/provider. */
  readonly toolCalling?: boolean;
  readonly imageInput?: boolean;
}

export interface ModelRetryPolicy {
  /** Includes the initial request; bounded to avoid retry storms. */
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly maxRetryAfterMs: number;
  readonly retryableStatusCodes: readonly number[];
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

const MAX_STRUCTURED_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_RETRY_POLICY: ModelRetryPolicy = {
  maxAttempts: 2,
  backoffMs: 250,
  maxRetryAfterMs: 3_000,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

/** OpenAI chat-completions adapter with strict egress, timeout, and redirect controls. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly #defaultEndpoint: string;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #streamingOrigins: ReadonlySet<string>;
  readonly #structuredOutputOrigins: ReadonlySet<string>;
  readonly #secrets: SecretStore;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #timeoutMs: number;
  readonly #retryPolicy: ModelRetryPolicy;
  readonly #capabilities: ProviderCapabilities;

  constructor(options: OpenAICompatibleProviderOptions) {
    if (!Number.isInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1) {
      throw new AppError("VALIDATION_ERROR", "Model request timeout must be a positive integer.", 400);
    }
    this.#retryPolicy = validateRetryPolicy(options.retryPolicy ?? DEFAULT_RETRY_POLICY);
    this.id = options.id;
    this.#defaultEndpoint = options.defaultEndpoint;
    this.#allowedOrigins = new Set([...options.allowedOrigins].map((origin) => new URL(origin).origin));
    this.#streamingOrigins = new Set([...(options.streamingOrigins ?? [])].map((origin) => new URL(origin).origin));
    this.#structuredOutputOrigins = new Set(
      [...(options.structuredOutputOrigins ?? [])].map((origin) => new URL(origin).origin),
    );
    this.#secrets = options.secrets;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#capabilities = {
      toolCalling: options.toolCalling ?? false,
      imageInput: options.imageInput ?? false,
      streaming: false,
      structuredOutput: false,
    };
  }

  capabilities(config: ModelConfig): ProviderCapabilities {
    let origin = "";
    try {
      origin = new URL(config.endpoint ?? this.#defaultEndpoint).origin;
    } catch {
      // Invalid endpoints are rejected before a request; they cannot advertise optional features.
    }
    const approved = this.#allowedOrigins.has(origin);
    return {
      ...this.#capabilities,
      streaming: approved && this.#streamingOrigins.has(origin),
      structuredOutput: approved && this.#structuredOutputOrigins.has(origin),
    };
  }

  async complete(input: {
    readonly tenantId: TenantId;
    readonly config: ModelConfig;
    readonly messages: readonly ConversationMessage[];
    readonly tools?: readonly ModelToolDefinition[];
    readonly responseSchema?: JsonSchema;
    readonly signal?: AbortSignal;
    readonly onTextDelta?: (delta: string) => void;
  }): Promise<ModelTurn> {
    if (input.signal?.aborted) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Model request was cancelled.", 504);
    }
    const credentialRef = input.config.credentialRef;
    if (!credentialRef) {
      throw new AppError("VALIDATION_ERROR", "A model credential reference is required.", 400);
    }
    if (input.tools?.length && !this.#capabilities.toolCalling) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "This model endpoint is not configured for tool calling.", 501);
    }

    const endpoint = input.config.endpoint ?? this.#defaultEndpoint;
    const target = this.#completionUrl(endpoint);
    const streaming = input.onTextDelta !== undefined;
    if (streaming && !this.capabilities(input.config).streaming) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "Streaming is not verified for this model endpoint.", 501);
    }
    const responseSchema = input.responseSchema ? validateStructuredOutputSchema(input.responseSchema) : undefined;
    if (responseSchema && streaming) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "Structured output is not supported for streaming requests.", 501);
    }
    if (responseSchema && !this.capabilities(input.config).structuredOutput) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "Structured output is not verified for this model endpoint.", 501);
    }
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
        ...(streaming ? { stream: true } : {}),
        ...(responseSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "agent_response", strict: true, schema: responseSchema },
              },
            }
          : {}),
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

      let response: Response;
      for (let attempt = 1; ; attempt += 1) {
        try {
          response = await this.#fetch(target, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (cause) {
          // A lost connection can happen after a provider accepts and bills the request.
          // Retry only explicit HTTP responses with a configured transient status.
          if (controller.signal.aborted) {
            throw new AppError("DEPENDENCY_UNAVAILABLE", "Model request was cancelled or timed out.", 504, {
              cause,
            });
          }
          throw cause;
        }
        if (
          !streaming &&
          !response.ok &&
          this.#retryPolicy.retryableStatusCodes.includes(response.status) &&
          attempt < this.#retryPolicy.maxAttempts
        ) {
          const waitMs = getModelRetryDelay(response.headers.get("retry-after"), attempt, this.#retryPolicy);
          if (waitMs !== undefined) {
            await cancelResponseBody(response);
            await waitForRetry(waitMs, controller.signal);
            continue;
          }
        }
        break;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new AppError("DEPENDENCY_UNAVAILABLE", `Model provider returned HTTP ${response.status}.`, 502);
      }

      let payload: OpenAIResponse;
      if (streaming) {
        payload = await readOpenAIEventStream(response, input.onTextDelta as (delta: string) => void);
      } else {
        try {
          payload = (await response.json()) as OpenAIResponse;
        } catch (cause) {
          throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned invalid JSON.", 502, { cause });
        }
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

      let structuredOutput: unknown;
      let content = typeof choice.content === "string" ? choice.content : "";
      if (responseSchema && toolCalls.length === 0) {
        try {
          if (new TextEncoder().encode(content).byteLength > MAX_STRUCTURED_OUTPUT_BYTES) {
            throw new Error("Structured output exceeded the response size limit.");
          }
          structuredOutput = JSON.parse(content) as unknown;
          validateStructuredOutputValue(structuredOutput, responseSchema);
          content = JSON.stringify(structuredOutput);
        } catch (cause) {
          throw new AppError(
            "DEPENDENCY_UNAVAILABLE",
            "Model provider returned output that did not match the requested schema.",
            502,
            { cause },
          );
        }
      }

      const promptTokens = payload.usage?.prompt_tokens;
      const completionTokens = payload.usage?.completion_tokens;
      return {
        message: { role: "assistant", content },
        toolCalls,
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
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

function validateRetryPolicy(policy: ModelRetryPolicy): ModelRetryPolicy {
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 3 ||
    !Number.isSafeInteger(policy.backoffMs) ||
    policy.backoffMs < 0 ||
    policy.backoffMs > 5_000 ||
    !Number.isSafeInteger(policy.maxRetryAfterMs) ||
    policy.maxRetryAfterMs < 0 ||
    policy.maxRetryAfterMs > 5_000 ||
    policy.retryableStatusCodes.length > 12 ||
    policy.retryableStatusCodes.some((status) => !Number.isSafeInteger(status) || status < 400 || status > 599) ||
    new Set(policy.retryableStatusCodes).size !== policy.retryableStatusCodes.length
  ) {
    throw new AppError("VALIDATION_ERROR", "Model retry policy is invalid.", 400);
  }
  return {
    maxAttempts: policy.maxAttempts,
    backoffMs: policy.backoffMs,
    maxRetryAfterMs: policy.maxRetryAfterMs,
    retryableStatusCodes: [...policy.retryableStatusCodes],
  };
}

function getModelRetryDelay(header: string | null, attempt: number, policy: ModelRetryPolicy): number | undefined {
  let requestedDelay: number | undefined;
  if (header !== null) {
    const value = header.trim();
    if (/^\d+$/.test(value)) requestedDelay = Number(value) * 1000;
    else if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
      const retryAt = Date.parse(value);
      if (Number.isFinite(retryAt)) requestedDelay = Math.max(0, retryAt - Date.now());
    }
  }
  const delay = requestedDelay ?? policy.backoffMs * 2 ** (attempt - 1);
  return Number.isFinite(delay) && delay <= policy.maxRetryAfterMs ? delay : undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The failed response is discarded regardless of connection cancellation support.
  }
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new AppError("DEPENDENCY_UNAVAILABLE", "Model request was cancelled.", 504));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new AppError("DEPENDENCY_UNAVAILABLE", "Model request was cancelled.", 504));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}

async function readOpenAIEventStream(
  response: Response,
  onTextDelta: (delta: string) => void,
): Promise<OpenAIResponse> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "text/event-stream" || !response.body) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an invalid streaming response.", 502);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, StreamedToolCall>();
  const eventData: string[] = [];
  let buffer = "";
  let content = "";
  let usage: OpenAIResponse["usage"];
  let sawPayload = false;
  let sawFinishReason = false;
  let finished = false;

  const processEvent = (): void => {
    if (eventData.length === 0 || finished) {
      eventData.length = 0;
      return;
    }
    const data = eventData.join("\n");
    eventData.length = 0;
    if (data.trim() === "[DONE]") {
      finished = true;
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an invalid stream event.", 502, {
        cause,
      });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an invalid stream event.", 502);
    }
    const event = payload as {
      readonly error?: unknown;
      readonly choices?: readonly {
        readonly delta?: {
          readonly content?: unknown;
          readonly tool_calls?: readonly {
            readonly index?: unknown;
            readonly id?: unknown;
            readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
          }[];
        };
        readonly finish_reason?: unknown;
      }[];
      readonly usage?: OpenAIResponse["usage"];
    };
    if (event.error !== undefined) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider stream failed.", 502);
    }
    sawPayload = true;
    if (event.usage) usage = event.usage;
    if (event.choices?.some((choice) => choice.finish_reason !== undefined && choice.finish_reason !== null)) {
      sawFinishReason = true;
    }
    const delta = event.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content.length > 0) {
      content += delta.content;
      onTextDelta(delta.content);
    }
    for (const part of delta?.tool_calls ?? []) {
      if (!Number.isSafeInteger(part.index) || (part.index as number) < 0) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an invalid tool-call stream.", 502);
      }
      const index = part.index as number;
      const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof part.id === "string") current.id = part.id;
      if (typeof part.function?.name === "string") current.name += part.function.name;
      if (typeof part.function?.arguments === "string") current.arguments += part.function.arguments;
      toolCalls.set(index, current);
    }
  };

  const processLine = (line: string): void => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized === "") {
      processEvent();
    } else if (normalized.startsWith("data:")) {
      eventData.push(normalized.slice(5).replace(/^ /, ""));
    }
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (done) {
        if (buffer.length > 0) processLine(buffer);
        processEvent();
        break;
      }
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    if (cause instanceof AppError) throw cause;
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider stream could not be read.", 502, { cause });
  } finally {
    reader.releaseLock();
  }
  if (!sawPayload) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an empty completion stream.", 502);
  }
  if (!finished && !sawFinishReason) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider stream ended before completion.", 502);
  }
  const calls = [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
  const messageToolCalls = calls.map((call) => ({
    id: call.id,
    function: { name: call.name, arguments: call.arguments },
  }));
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: content || null,
          ...(messageToolCalls.length ? { tool_calls: messageToolCalls } : {}),
        },
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

function toOpenAIMessage(message: ConversationMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.images?.length
      ? [
          { type: "text", text: message.content },
          ...message.images.map((image) => ({
            type: "image_url",
            image_url: { url: image.dataUrl, detail: image.detail ?? "auto" },
          })),
        ]
      : message.content,
  };
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
