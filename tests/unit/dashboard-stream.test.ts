import { afterEach, describe, expect, test } from "bun:test";
import { apiStream, configureTokenReader } from "../../apps/dashboard/src/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  configureTokenReader(() => "");
});

describe("dashboard streaming API client", () => {
  test("sends the owner token and parses fragmented SSE text and completion events", async () => {
    const captured: { authorization: string | null; body?: Record<string, unknown> } = { authorization: null };
    const events = [
      'event: delta\ndata: {"delta":"Hel"}\n\n',
      'event: delta\ndata: {"delta":"lo"}\n\n',
      'event: done\ndata: {"conversationId":"conv_123","message":"Hello"}\n\n',
    ].join("");
    const encoded = new TextEncoder().encode(events);
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      captured.authorization = headers.get("authorization");
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < encoded.length; offset += 11) {
            controller.enqueue(encoded.slice(offset, offset + 11));
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    }) as typeof fetch;
    configureTokenReader(() => "owner-api-token");
    const deltas: string[] = [];
    const result = await apiStream<{ conversationId: string; message: string }>(
      "/v1/bots/bot-test/messages",
      { message: "Hello", stream: true },
      (delta) => deltas.push(delta),
    );
    expect(captured.authorization).toBe("Bearer owner-api-token");
    expect(captured.body).toEqual({ message: "Hello", stream: true });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result).toEqual({ conversationId: "conv_123", message: "Hello" });
  });
});
