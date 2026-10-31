import { describe, expect, test } from "bun:test";
import { OpenAICompatibleAudioTranscriber } from "../../packages/core/src/audio-transcription.js";
import type { TenantId } from "../../packages/core/src/types.js";

const tenantId = "tenant-audio" as TenantId;

function model(audioModel = "whisper-1") {
  return {
    providerId: "openai-compatible",
    model: "chat-model",
    audioModel,
    endpoint: "https://provider.example.test/v1",
    credentialRef: "secret_audio",
  };
}

describe("OpenAI-compatible audio transcription", () => {
  test("sends bounded audio as multipart to the allowlisted transcription route", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transcriber = new OpenAICompatibleAudioTranscriber({
      allowedOrigins: new Set(["https://provider.example.test"]),
      secrets: { resolve: async () => "provider-secret" },
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init as RequestInit });
        return Response.json({ text: "Turn left at the next street." });
      },
    });

    const result = await transcriber.transcribe({
      tenantId,
      model: model(),
      fileName: "telegram-audio.ogg",
      contentType: "audio/ogg",
      bytes: new TextEncoder().encode("fake-ogg-audio"),
    });

    expect(result).toBe("Turn left at the next street.");
    expect(calls[0]?.url).toBe("https://provider.example.test/v1/audio/transcriptions");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer provider-secret");
    const form = calls[0]?.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    const file = form.get("file") as File;
    expect(file.name).toBe("telegram-audio.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(await file.text()).toBe("fake-ogg-audio");
  });

  test("blocks unapproved origins before resolving the bot credential", async () => {
    let resolved = false;
    let fetched = false;
    const transcriber = new OpenAICompatibleAudioTranscriber({
      allowedOrigins: new Set(["https://approved.example.test"]),
      secrets: {
        resolve: async () => {
          resolved = true;
          return "provider-secret";
        },
      },
      fetch: async () => {
        fetched = true;
        return Response.json({ text: "unexpected" });
      },
    });

    await expect(
      transcriber.transcribe({
        tenantId,
        model: { ...model(), endpoint: "https://blocked.example.test/v1" },
        fileName: "telegram-audio.ogg",
        contentType: "audio/ogg",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(resolved).toBe(false);
    expect(fetched).toBe(false);
  });

  test("requires an explicit transcription model and rejects unsupported content types", async () => {
    const transcriber = new OpenAICompatibleAudioTranscriber({
      allowedOrigins: new Set(["https://provider.example.test"]),
      secrets: { resolve: async () => "provider-secret" },
      fetch: async () => Response.json({ text: "unexpected" }),
    });
    const input = {
      tenantId,
      fileName: "telegram-audio.ogg",
      contentType: "audio/ogg",
      bytes: new Uint8Array([1]),
    };
    await expect(transcriber.transcribe({ ...input, model: model("") })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    await expect(
      transcriber.transcribe({ ...input, model: model(), contentType: "application/octet-stream" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("sanitizes provider errors and rejects empty, oversized, or control-bearing transcripts", async () => {
    const create = (fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
      new OpenAICompatibleAudioTranscriber({
        allowedOrigins: new Set(["https://provider.example.test"]),
        secrets: { resolve: async () => "provider-secret" },
        fetch,
      });
    const input = {
      tenantId,
      model: model(),
      fileName: "telegram-audio.wav",
      contentType: "audio/wav",
      bytes: new Uint8Array([1]),
    };

    await expect(
      create(async () => new Response("provider-secret", { status: 401 })).transcribe(input),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Audio transcription provider returned HTTP 401.",
    });
    await expect(create(async () => Response.json({ text: "" })).transcribe(input)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    await expect(
      create(async () => Response.json({ text: `x${"a".repeat(60_000)}` })).transcribe(input),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    await expect(create(async () => Response.json({ text: "bad\u0000text" })).transcribe(input)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
  });
});
