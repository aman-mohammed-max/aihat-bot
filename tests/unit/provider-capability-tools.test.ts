import { describe, expect, test } from "bun:test";
import { ProviderCapabilityTools } from "../../packages/core/src/provider-capability-tools.js";
import type { BotDefinition, BotId, TenantId, UserId } from "../../packages/core/src/types.js";
import { getToolAttachments, type ToolContext } from "../../packages/core/src/tools.js";

const tenantId = "tenant-provider-capability" as TenantId;
const ownerId = "owner-provider-capability" as UserId;
const botId = "bot-provider-capability" as BotId;
const bot: BotDefinition = {
  id: botId,
  tenantId,
  ownerId,
  name: "Creative assistant",
  description: "Generates images and searches.",
  systemPrompt: "Be helpful.",
  model: {
    providerId: "openai-compatible",
    model: "chat-model",
    imageModel: "image-model",
    searchModel: "search-model",
    endpoint: "https://provider.example.test/v1",
    credentialRef: "secret_provider",
  },
  visibility: "private",
  status: "published",
  version: 1,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};
const context: ToolContext = { tenantId, botId, actorId: ownerId };

describe("configured image and search model tools", () => {
  test("exposes only configured capabilities and sends role-specific requests", async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const registry = new ProviderCapabilityTools({
      bots: { get: async () => bot, saveDraft: async () => {} },
      secrets: { resolve: async () => "model-secret" },
      allowedOrigins: new Set(["https://provider.example.test"]),
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return String(input).endsWith("/search")
          ? Response.json({
              web: {
                results: [
                  { title: "Result one", url: "https://news.example.test/one", description: "Useful source." },
                  { title: "Result two", url: "https://news.example.test/two", snippet: "Another source." },
                ],
              },
            })
          : Response.json({ data: [{ url: "https://images.example.test/generated.png" }] });
      },
    });

    expect((await registry.available(context)).map((tool) => tool.name)).toEqual(["generate_image", "search_web"]);
    const image = await registry.execute(context, "generate_image", { prompt: "A blue bot mascot" });
    const search = await registry.execute(context, "search_web", { query: "Current weather in Oslo", maxResults: 2 });

    expect(image).toEqual({ status: "generated", model: "image-model" });
    expect(getToolAttachments(image)).toEqual([
      { kind: "image", url: "https://images.example.test/generated.png", alt: "A blue bot mascot" },
    ]);
    expect(JSON.stringify(image)).not.toContain("images.example.test");
    expect(search).toEqual({
      model: "search-model",
      results: [
        { title: "Result one", url: "https://news.example.test/one", snippet: "Useful source." },
        { title: "Result two", url: "https://news.example.test/two", snippet: "Another source." },
      ],
    });
    expect(calls[0]?.url).toBe("https://provider.example.test/v1/images/generations");
    expect(calls[0]?.authorization).toBe("Bearer model-secret");
    expect(calls[0]?.body).toMatchObject({ model: "image-model", prompt: "A blue bot mascot", n: 1 });
    expect(calls[1]?.url).toBe("https://provider.example.test/v1/search");
    expect(calls[1]?.body).toMatchObject({ model: "search-model", query: "Current weather in Oslo", max_results: 2 });
  });

  test("does not expose or resolve credentials for unapproved provider origins", async () => {
    let resolveCount = 0;
    let fetchCount = 0;
    const unapprovedBot = {
      ...bot,
      model: { ...bot.model, endpoint: "https://unapproved.example.test/v1" },
    };
    const registry = new ProviderCapabilityTools({
      bots: { get: async () => unapprovedBot, saveDraft: async () => {} },
      secrets: {
        resolve: async () => {
          resolveCount += 1;
          return "model-secret";
        },
      },
      allowedOrigins: new Set(["https://provider.example.test"]),
      fetch: async () => {
        fetchCount += 1;
        return Response.json({});
      },
    });

    expect(await registry.available(context)).toEqual([]);
    await expect(registry.execute(context, "generate_image", { prompt: "A blue bot" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(resolveCount).toBe(0);
    expect(fetchCount).toBe(0);
  });

  test("reports when the configured image provider returns inline data instead of a delivery URL", async () => {
    const registry = new ProviderCapabilityTools({
      bots: { get: async () => bot, saveDraft: async () => {} },
      secrets: { resolve: async () => "model-secret" },
      allowedOrigins: new Set(["https://provider.example.test"]),
      fetch: async () => Response.json({ data: [{ b64_json: "aW1hZ2U=" }] }),
    });

    await expect(registry.execute(context, "generate_image", { prompt: "A blue bot" })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      status: 501,
    });
  });
});
