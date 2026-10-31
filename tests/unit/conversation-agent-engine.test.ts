import { describe, expect, test } from "bun:test";
import { CloudflareConversationAgentEngine } from "../../apps/cloudflare-runtime/src/conversation-agent-engine.js";
import type { ConversationCoordinator } from "../../apps/cloudflare-runtime/src/conversation-coordinator.js";
import type { AgentEngine, Logger } from "../../packages/core/src/ports.js";
import type {
  AgentRequest,
  BotDefinition,
  ConversationId,
  BotId,
  TenantId,
  UserId,
} from "../../packages/core/src/types.js";

const tenantId = "tenant-conversation-lock" as TenantId;
const botId = "bot_00000000-0000-4000-8000-000000000001" as BotId;
const ownerId = "user-conversation-lock" as UserId;
const conversationId = "conv_00000000000040008000000000000001" as ConversationId;

describe("Cloudflare per-conversation agent coordination", () => {
  test("uses a stable tenant/bot/conversation identity and releases its opaque lease", async () => {
    let objectName = "";
    let activeToken: string | undefined;
    const sentBodies: string[] = [];
    const namespace = createNamespace({
      name: (name) => (objectName = name),
      fetch: async (request) => {
        const body = await request.text();
        sentBodies.push(body);
        const payload = JSON.parse(body) as { leaseToken: string };
        if (request.url.endsWith("/turn/acquire")) {
          if (activeToken) return Response.json({ error: "conversation_busy" }, { status: 409 });
          activeToken = payload.leaseToken;
          return new Response(null, { status: 204 });
        }
        if (activeToken !== payload.leaseToken) return new Response(null, { status: 409 });
        activeToken = undefined;
        return new Response(null, { status: 204 });
      },
    });
    const engine = new CloudflareConversationAgentEngine(createAgentEngine(), namespace, silentLogger);

    const response = await engine.respond(createRequest());

    expect(response.message.content).toBe("completed");
    expect(objectName).toBe(`conversation:${tenantId}:${botId}:${conversationId}`);
    expect(activeToken).toBeUndefined();
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies.join(" ")).not.toContain("private request text");
  });

  test("rejects concurrent turns before calling the model", async () => {
    let engineCalls = 0;
    let releaseCalls = 0;
    const namespace = createNamespace({
      fetch: async (request) => {
        if (request.url.endsWith("/turn/acquire"))
          return Response.json({ error: "conversation_busy" }, { status: 409 });
        releaseCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    const engine = new CloudflareConversationAgentEngine(
      createAgentEngine(async () => {
        engineCalls += 1;
        return { message: { role: "assistant", content: "unexpected" } };
      }),
      namespace,
      silentLogger,
    );

    await expect(engine.respond(createRequest())).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(engineCalls).toBe(0);
    expect(releaseCalls).toBe(0);
  });

  test("releases the conversation after model failure", async () => {
    let activeToken: string | undefined;
    const namespace = createNamespace({
      fetch: async (request) => {
        const payload = (await request.json()) as { leaseToken: string };
        if (request.url.endsWith("/turn/acquire")) {
          activeToken = payload.leaseToken;
          return new Response(null, { status: 204 });
        }
        if (activeToken === payload.leaseToken) activeToken = undefined;
        return new Response(null, { status: 204 });
      },
    });
    const engine = new CloudflareConversationAgentEngine(
      createAgentEngine(async () => {
        throw new Error("model unavailable");
      }),
      namespace,
      silentLogger,
    );

    await expect(engine.respond(createRequest())).rejects.toThrow("model unavailable");
    expect(activeToken).toBeUndefined();
  });
});

function createAgentEngine(
  respond: AgentEngine["respond"] = async () => ({ message: { role: "assistant", content: "completed" } }),
): AgentEngine {
  return { respond };
}

function createNamespace(input: {
  readonly name?: (name: string) => void;
  readonly fetch: (request: Request) => Promise<Response>;
}): DurableObjectNamespace<ConversationCoordinator> {
  const namespace = {
    idFromName: (name: string) => {
      input.name?.(name);
      return name;
    },
    get: (_id: unknown) => ({
      fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
        const normalized = request instanceof Request ? request : new Request(request, init);
        return input.fetch(normalized);
      },
    }),
  };
  return namespace as unknown as DurableObjectNamespace<ConversationCoordinator>;
}

function createRequest(): AgentRequest {
  const bot: BotDefinition = {
    id: botId,
    tenantId,
    ownerId,
    name: "Conversation test bot",
    description: "",
    systemPrompt: "Test system prompt",
    model: { providerId: "test", model: "test" },
    visibility: "private",
    status: "published",
    version: 1,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
  };
  return {
    bot,
    conversationId,
    messages: [{ role: "user", content: "private request text" }],
    actorId: ownerId,
  };
}

const silentLogger: Pick<Logger, "warn"> = { warn: () => undefined };
