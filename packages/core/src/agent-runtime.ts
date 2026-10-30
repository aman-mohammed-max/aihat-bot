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
  readonly tools?: AgentToolRegistry;
  readonly toolCalling?: boolean;
  readonly timeoutMs?: number;
}): AgentOrchestrator {
  const origins = normalizeAllowedOrigins(input.allowedOrigins);
  const providers = new ModelProviderRegistry();
  providers.register(
    new OpenAICompatibleProvider({
      id: "openai-compatible",
      defaultEndpoint: "https://api.openai.com/v1",
      allowedOrigins: origins,
      secrets: input.secrets,
      toolCalling: input.toolCalling ?? false,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }),
  );
  const tools = input.tools ?? new ToolRegistry({ isAllowed: async () => false });
  return new AgentOrchestrator({ providers, tools, conversations: input.conversations });
}

function normalizeAllowedOrigins(configured: ReadonlySet<string>): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const candidate of configured) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", "MODEL_ALLOWED_ORIGINS contains an invalid origin.", 400, { cause });
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new AppError("VALIDATION_ERROR", "MODEL_ALLOWED_ORIGINS must contain HTTPS origins only.", 400);
    }
    origins.add(url.origin);
  }
  return origins;
}
