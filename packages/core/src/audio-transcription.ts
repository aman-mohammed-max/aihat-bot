import { AppError } from "./errors.js";
import type { SecretStore } from "./ports.js";
import type { ModelConfig, TenantId } from "./types.js";

export const TELEGRAM_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
export const TRANSCRIBED_AUDIO_MAX_CHARS = 60_000;

const MAX_RESPONSE_BYTES = 128 * 1024;

export function isTelegramAudioTranscriptionAvailable(input: {
  readonly telegramWebhookConfigured: boolean;
  readonly malwareScannerConfigured: boolean;
  readonly allowedProviderOrigins: ReadonlySet<string>;
}): boolean {
  if (!input.telegramWebhookConfigured || !input.malwareScannerConfigured) return false;
  return [...input.allowedProviderOrigins].some((origin) => {
    try {
      const url = new URL(origin);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  });
}

export interface AudioTranscriber {
  transcribe(input: {
    readonly tenantId: TenantId;
    readonly model: ModelConfig;
    readonly fileName: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

/** OpenAI-compatible audio transcription with exact-origin egress, secret references and bounded I/O. */
export class OpenAICompatibleAudioTranscriber implements AudioTranscriber {
  readonly #defaultEndpoint: string;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #secrets: SecretStore;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #timeoutMs: number;

  constructor(input: {
    readonly defaultEndpoint?: string;
    readonly allowedOrigins: ReadonlySet<string>;
    readonly secrets: SecretStore;
    readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    readonly timeoutMs?: number;
  }) {
    const timeoutMs = input.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new AppError("VALIDATION_ERROR", "Audio transcription timeout is invalid.", 500);
    }
    this.#defaultEndpoint = input.defaultEndpoint ?? "https://api.openai.com/v1";
    this.#allowedOrigins = new Set([...input.allowedOrigins].map((origin) => new URL(origin).origin));
    this.#secrets = input.secrets;
    this.#fetch = input.fetch ?? fetch;
    this.#timeoutMs = timeoutMs;
  }

  async transcribe(input: {
    readonly tenantId: TenantId;
    readonly model: ModelConfig;
    readonly fileName: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    if (!input.model.audioModel) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "This bot has no audio transcription model configured.", 501);
    }
    if (!input.model.credentialRef) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "This bot's model credential is unavailable.", 503);
    }
    if (
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > TELEGRAM_AUDIO_MAX_BYTES ||
      !isSupportedAudioType(input.contentType) ||
      !isSafeFileName(input.fileName)
    ) {
      throw new AppError("VALIDATION_ERROR", "Audio attachment is invalid or exceeds the supported size.", 413);
    }
    const target = this.#transcriptionUrl(input.model.endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Audio transcription request timed out")),
      this.#timeoutMs,
    );
    const abortFromCaller = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (input.signal?.aborted) abortFromCaller();

    try {
      const token = await this.#secrets.resolve(input.tenantId, input.model.credentialRef, controller.signal);
      if (!token.trim()) throw new AppError("DEPENDENCY_UNAVAILABLE", "The model credential is unavailable.", 503);
      const form = new FormData();
      form.set("model", input.model.audioModel);
      form.set(
        "file",
        new Blob([input.bytes.slice().buffer as ArrayBuffer], { type: input.contentType }),
        input.fileName,
      );
      const response = await this.#fetch(target, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        body: form,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AppError(
          "DEPENDENCY_UNAVAILABLE",
          `Audio transcription provider returned HTTP ${response.status}.`,
          502,
        );
      }
      const payload = parseJson(await readBoundedText(response));
      const transcript = isRecord(payload) && typeof payload.text === "string" ? payload.text.trim() : "";
      if (!transcript || transcript.length > TRANSCRIBED_AUDIO_MAX_CHARS || hasUnsafeControls(transcript)) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "Audio transcription provider returned invalid text.", 502);
      }
      return transcript;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (controller.signal.aborted) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "Audio transcription did not finish in time.", 504, { cause });
      }
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Audio transcription provider returned an invalid response.", 502, {
        cause,
      });
    } finally {
      input.signal?.removeEventListener("abort", abortFromCaller);
      clearTimeout(timeout);
    }
  }

  #transcriptionUrl(endpoint?: string): URL {
    let target: URL;
    try {
      target = new URL(endpoint ?? this.#defaultEndpoint);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", "Model endpoint must be an absolute HTTPS URL.", 400, { cause });
    }
    if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) {
      throw new AppError("VALIDATION_ERROR", "Model endpoint must use HTTPS without credentials or query values.", 400);
    }
    if (!this.#allowedOrigins.has(target.origin)) {
      throw new AppError("FORBIDDEN", "Model endpoint origin is not approved by the deployment network policy.", 403);
    }
    target.pathname = `${target.pathname.replace(/\/+$/, "")}/audio/transcriptions`;
    return target;
  }
}

function isSupportedAudioType(value: string): boolean {
  return new Set([
    "audio/aac",
    "audio/flac",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/opus",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
    "audio/x-wav",
  ]).has(value.toLowerCase().split(";")[0]?.trim() ?? "");
}

function isSafeFileName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Audio transcription provider returned an oversized response.", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError(
          "DEPENDENCY_UNAVAILABLE",
          "Audio transcription provider returned an oversized response.",
          502,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Audio transcription provider returned invalid UTF-8.", 502, {
      cause,
    });
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Audio transcription provider returned invalid JSON.", 502, {
      cause,
    });
  }
}

function hasUnsafeControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
