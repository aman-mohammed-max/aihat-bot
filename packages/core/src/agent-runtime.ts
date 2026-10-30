import { AgentOrchestrator } from "./agent.js";
import type { ApiConversationRepository, ConversationRepository, SecretStore } from "./ports.js";
import { ModelProviderRegistry, OpenAICompatibleProvider } from "./model.js";
import { ToolRegistry } from "./tools.js";
import type { AgentToolRegistry } from "./tools.js";
import { AppError } from "./errors.js";

/** Shared default composition for text-only agent calls in Bun and Workers. */
export function createOpenAICompatibleAgentEngine(input: {
  readonly conversations: ApiConversationRepository & ConversationRepository;
  readonly secrets: SecretStore;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly streamingOrigins?: ReadonlySet<string>;
  readonly structuredOutputOrigins?: ReadonlySet<string>;
  readonly tools?: AgentToolRegistry;
  readonly toolCalling?: boolean;
  readonly imageInput?: boolean;
  readonly timeoutMs?: number;
}): AgentOrchestrator {
  const origins = normalizeAllowedOrigins(input.allowedOrigins);
  const providers = new ModelProviderRegistry();
  providers.register(
    new OpenAICompatibleProvider({
      id: "openai-compatible",
      defaultEndpoint: "https://api.openai.com/v1",
      allowedOrigins: origins,
      streamingOrigins: normalizeAllowedOrigins(input.streamingOrigins ?? new Set(), "MODEL_STREAMING_ORIGINS"),
      structuredOutputOrigins: normalizeAllowedOrigins(
        input.structuredOutputOrigins ?? new Set(),
        "MODEL_STRUCTURED_OUTPUT_ORIGINS",
      ),
      secrets: input.secrets,
      toolCalling: input.toolCalling ?? false,
      imageInput: input.imageInput ?? false,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }),
  );
  const tools = input.tools ?? new ToolRegistry({ isAllowed: async () => false });
  return new AgentOrchestrator({ providers, tools, conversations: input.conversations });
}

/** Reports whether at least one egress-approved origin is verified for strict JSON-schema responses. */
export function hasVerifiedStructuredOutputOrigin(
  allowedOrigins: ReadonlySet<string>,
  structuredOutputOrigins: ReadonlySet<string>,
): boolean {
  const allowed = normalizeAllowedOrigins(allowedOrigins);
  const structured = normalizeAllowedOrigins(structuredOutputOrigins, "MODEL_STRUCTURED_OUTPUT_ORIGINS");
  return [...structured].some((origin) => allowed.has(origin));
}

/** Reports whether at least one configured origin is both egress-approved and stream-verified. */
export function hasVerifiedStreamingOrigin(
  allowedOrigins: ReadonlySet<string>,
  streamingOrigins: ReadonlySet<string>,
): boolean {
  const allowed = normalizeAllowedOrigins(allowedOrigins);
  const streaming = normalizeAllowedOrigins(streamingOrigins, "MODEL_STREAMING_ORIGINS");
  return [...streaming].some((origin) => allowed.has(origin));
}

function normalizeAllowedOrigins(
  configured: ReadonlySet<string>,
  settingName = "MODEL_ALLOWED_ORIGINS",
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const candidate of configured) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", `${settingName} contains an invalid origin.`, 400, { cause });
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new AppError("VALIDATION_ERROR", `${settingName} must contain HTTPS origins only.`, 400);
    }
    origins.add(url.origin);
  }
  return origins;
}
