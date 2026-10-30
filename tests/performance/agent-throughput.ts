import { AgentOrchestrator } from "../../packages/core/src/agent.js";
import { ModelProviderRegistry, type ModelProvider } from "../../packages/core/src/model.js";
import { ToolRegistry } from "../../packages/core/src/tools.js";
import type { ConversationRepository } from "../../packages/core/src/ports.js";
import type {
  AgentRequest,
  BotDefinition,
  ConversationId,
  ConversationMessage,
  TenantId,
  UserId,
} from "../../packages/core/src/types.js";

const tenantId = "tenant_benchmark" as TenantId;
const actorId = "user_benchmark" as UserId;
const bot: BotDefinition = {
  id: "bot_benchmark" as BotDefinition["id"],
  tenantId,
  ownerId: actorId,
  name: "Benchmark bot",
  description: "In-process orchestration benchmark.",
  systemPrompt: "Answer briefly.",
  model: { providerId: "benchmark", model: "static" },
  visibility: "private",
  status: "published",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

class StaticProvider implements ModelProvider {
  readonly id = "benchmark";

  capabilities() {
    return { toolCalling: false, streaming: false, structuredOutput: false };
  }

  async complete() {
    return { message: { role: "assistant" as const, content: "ok" }, toolCalls: [] };
  }
}

class MemoryConversations implements ConversationRepository {
  readonly #messages = new Map<ConversationId, ConversationMessage[]>();

  async load(_tenant: TenantId, conversationId: ConversationId): Promise<readonly ConversationMessage[]> {
    return this.#messages.get(conversationId) ?? [];
  }

  async append(_tenant: TenantId, conversationId: ConversationId, messages: readonly ConversationMessage[]) {
    this.#messages.set(conversationId, [...(this.#messages.get(conversationId) ?? []), ...messages]);
  }
}

const providers = new ModelProviderRegistry();
providers.register(new StaticProvider());
const conversations = new MemoryConversations();
const engine = new AgentOrchestrator({
  providers,
  tools: new ToolRegistry({ isAllowed: async () => false }),
  conversations,
});

const request = (index: number): AgentRequest => ({
  bot,
  conversationId: `conversation_${index}` as ConversationId,
  executionId: `request_${index}`,
  messages: [{ role: "user", content: `Benchmark request ${index}` }],
  actorId,
});

async function benchmark(total: number, concurrency: number): Promise<void> {
  const durations = new Array<number>(total);
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        if (index >= total) return;
        const callStarted = performance.now();
        const response = await engine.respond(request(index));
        if (response.message.content !== "ok") throw new Error("Agent benchmark returned an unexpected reply.");
        durations[index] = performance.now() - callStarted;
      }
    }),
  );
  const elapsedMs = performance.now() - started;
  durations.sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))] ?? 0;
  const requestsPerSecond = (total / elapsedMs) * 1000;
  console.log(
    JSON.stringify({
      benchmark: "agent-orchestration-in-process",
      requests: total,
      concurrency,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      requestsPerSecond: Number(requestsPerSecond.toFixed(1)),
      p50Ms: Number(percentile(0.5).toFixed(3)),
      p95Ms: Number(percentile(0.95).toFixed(3)),
      externalModelAndDatabaseLatencyIncluded: false,
    }),
  );
}

await benchmark(2_000, 1);
await benchmark(2_000, 8);
await benchmark(2_000, 32);
