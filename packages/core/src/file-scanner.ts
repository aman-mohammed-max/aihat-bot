import { AppError } from "./errors.js";
import type { MalwareScanner } from "./ports.js";

const MAX_SCAN_RESPONSE_BYTES = 4_096;
type ScannerFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpMalwareScannerOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly fetch?: ScannerFetch;
  readonly timeoutMs?: number;
}

export function createOptionalHttpMalwareScanner(input: {
  readonly endpoint?: string;
  readonly token?: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly fetch?: ScannerFetch;
}): HttpMalwareScanner | undefined {
  const endpoint = input.endpoint?.trim() ?? "";
  const token = input.token?.trim() ?? "";
  if (!endpoint && !token && input.allowedOrigins.size === 0) return undefined;
  if (!endpoint || !token || input.allowedOrigins.size === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "File scanner endpoint, credential, and allowed origin must be configured together.",
      500,
    );
  }
  return new HttpMalwareScanner({
    endpoint,
    token,
    allowedOrigins: input.allowedOrigins,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

/** Streams bounded upload bytes to an operator-managed scanning gateway over an explicitly approved HTTPS origin. */
export class HttpMalwareScanner implements MalwareScanner {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: ScannerFetch;
  readonly #timeoutMs: number;

  constructor(options: HttpMalwareScannerOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", "File scanner endpoint is invalid.", 400, { cause });
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.href.length > 2_048 ||
      !options.allowedOrigins.has(endpoint.origin)
    ) {
      throw new AppError("VALIDATION_ERROR", "File scanner endpoint origin is not approved.", 400);
    }
    if (options.token.trim().length < 16 || options.token.length > 4_096 || /[\r\n]/.test(options.token)) {
      throw new AppError("VALIDATION_ERROR", "File scanner credential is invalid.", 400);
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new AppError("VALIDATION_ERROR", "File scanner timeout is invalid.", 400);
    }
    this.#endpoint = endpoint.toString();
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = timeoutMs;
  }

  async scan(input: {
    readonly fileName: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly verdict: "clean" | "infected"; readonly scanner: string }> {
    if (
      !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > 25 * 1024 * 1024
    ) {
      throw new AppError("VALIDATION_ERROR", "File scan input exceeds the supported size.", 413);
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) abortFromCaller();
    else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("File scanner timed out")), this.#timeoutMs);
    try {
      const body = new ArrayBuffer(input.bytes.byteLength);
      new Uint8Array(body).set(input.bytes);
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
          "content-type": input.contentType,
          "x-file-name-encoded": encodeURIComponent(input.fileName),
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", "File scanner rejected the scan request.", 503);
      }
      const responseBody = await readBoundedText(response);
      let result: unknown;
      try {
        result = JSON.parse(responseBody);
      } catch (cause) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "File scanner returned an invalid response.", 502, { cause });
      }
      if (!isScannerResult(result)) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "File scanner returned an invalid verdict.", 502);
      }
      return {
        verdict: result.verdict,
        scanner: safeScannerName(result.scanner),
      };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (controller.signal.aborted) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "File scanner timed out or the request was cancelled.", 503, {
          cause,
        });
      }
      throw new AppError("DEPENDENCY_UNAVAILABLE", "File scanner is unavailable.", 503, { cause });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_SCAN_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new AppError("DEPENDENCY_UNAVAILABLE", "File scanner response is too large.", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SCAN_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", "File scanner response is too large.", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isScannerResult(value: unknown): value is { verdict: "clean" | "infected"; scanner: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.verdict === "clean" || record.verdict === "infected") &&
    typeof record.scanner === "string" &&
    record.scanner.length >= 1 &&
    record.scanner.length <= 80 &&
    /^[a-zA-Z0-9 ._-]+$/.test(record.scanner)
  );
}

function safeScannerName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9 ._-]/g, "_").slice(0, 80);
}
