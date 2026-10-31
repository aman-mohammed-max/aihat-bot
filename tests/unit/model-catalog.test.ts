import { describe, expect, test } from "bun:test";
import { fetchModelCatalog } from "../../packages/core/src/model-catalog.js";

describe("provider model catalog", () => {
  test("fetches bounded OpenAI-compatible model metadata and filters by role", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({
        data: [
          { id: "chat-model", name: "Chat model", type: "chat" },
          { id: "gpt-image-1", name: "Image model", type: "image" },
          { id: "whisper-1", name: "Transcription model", type: "audio" },
          { id: "embedding-model", name: "Embedding model", type: "embedding" },
        ],
      });
    };
    const input = {
      endpoint: "https://provider.example.test/v1/",
      apiKey: "provider-secret",
      allowedOrigins: new Set(["https://provider.example.test"]),
      fetch: fetcher,
    };

    const chat = await fetchModelCatalog({ ...input, role: "chat" });
    const image = await fetchModelCatalog({ ...input, role: "image" });
    const search = await fetchModelCatalog({ ...input, role: "search" });
    const audio = await fetchModelCatalog({ ...input, role: "audio" });

    expect(chat.map((model) => model.id)).toEqual(["chat-model", "embedding-model"]);
    expect(image.map((model) => model.id)).toEqual(["gpt-image-1"]);
    expect(search).toHaveLength(4);
    expect(audio.map((model) => model.id)).toEqual(["whisper-1"]);
    expect(calls[0]?.url).toBe("https://provider.example.test/v1/models");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer provider-secret");
  });

  test("rejects an unapproved origin before sending the credential", async () => {
    let called = false;
    await expect(
      fetchModelCatalog({
        endpoint: "https://unapproved.example.test/v1",
        apiKey: "provider-secret",
        role: "chat",
        allowedOrigins: new Set(["https://provider.example.test"]),
        fetch: async () => {
          called = true;
          return Response.json({ data: [] });
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(called).toBe(false);
  });

  test("accepts a raw list and hides upstream error bodies", async () => {
    const models = await fetchModelCatalog({
      endpoint: "https://provider.example.test/v1",
      apiKey: "provider-secret",
      role: "search",
      allowedOrigins: new Set(["https://provider.example.test"]),
      fetch: async () => Response.json(["model-a", { id: "model-b", name: "Model B" }]),
    });
    expect(models.map((model) => model.id)).toEqual(["model-a", "model-b"]);

    await expect(
      fetchModelCatalog({
        endpoint: "https://provider.example.test/v1",
        apiKey: "provider-secret",
        role: "chat",
        allowedOrigins: new Set(["https://provider.example.test"]),
        fetch: async () => new Response("provider-secret", { status: 401 }),
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", message: "Model provider returned HTTP 401." });
  });
});
