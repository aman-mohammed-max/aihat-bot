import { createConnection } from "node:net";
import { AppError } from "@aihat/core";
import type { MalwareScanner } from "@aihat/core";

const DEFAULT_CLAMD_PORT = 3310;
const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
const MAX_SCAN_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4_096;
const STREAM_CHUNK_BYTES = 64 * 1024;

export interface ClamDScannerOptions {
  readonly host: string;
  readonly port?: number;
  readonly timeoutMs?: number;
}

export function createOptionalClamDScanner(input: {
  readonly host?: string;
  readonly port?: string;
  readonly timeoutMs?: string;
}): ClamDScanner | undefined {
  const host = input.host?.trim() ?? "";
  if (!host) return undefined;
  if (!isValidHost(host)) throw new AppError("VALIDATION_ERROR", "ClamAV host is invalid.", 500);

  const rawPort = input.port?.trim() || String(DEFAULT_CLAMD_PORT);
  if (!/^\d{1,5}$/.test(rawPort)) {
    throw new AppError("VALIDATION_ERROR", "CLAMAV_PORT must be an integer from 1 to 65535.", 500);
  }
  const port = Number(rawPort);
  if (port < 1 || port > 65_535) {
    throw new AppError("VALIDATION_ERROR", "CLAMAV_PORT must be an integer from 1 to 65535.", 500);
  }

  const rawTimeout = input.timeoutMs?.trim() || String(DEFAULT_SCAN_TIMEOUT_MS);
  if (!/^\d{1,6}$/.test(rawTimeout)) {
    throw new AppError("VALIDATION_ERROR", "CLAMAV_TIMEOUT_MS must be an integer from 100 to 120000.", 500);
  }
  const timeoutMs = Number(rawTimeout);
  if (timeoutMs < 100 || timeoutMs > 120_000) {
    throw new AppError("VALIDATION_ERROR", "CLAMAV_TIMEOUT_MS must be an integer from 100 to 120000.", 500);
  }

  return new ClamDScanner({ host, port, timeoutMs });
}

/** Bun-side ClamD adapter. The daemon should remain on a private container network. */
export class ClamDScanner implements MalwareScanner {
  readonly #host: string;
  readonly #port: number;
  readonly #timeoutMs: number;

  constructor(options: ClamDScannerOptions) {
    const host = options.host.trim();
    const port = options.port ?? DEFAULT_CLAMD_PORT;
    const timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
    if (!isValidHost(host)) {
      throw new AppError("VALIDATION_ERROR", "ClamAV host is invalid.", 400);
    }
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new AppError("VALIDATION_ERROR", "ClamAV port is invalid.", 400);
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new AppError("VALIDATION_ERROR", "ClamAV scan timeout is invalid.", 400);
    }
    this.#host = host;
    this.#port = port;
    this.#timeoutMs = timeoutMs;
  }

  async scan(input: {
    readonly fileName: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly verdict: "clean" | "infected"; readonly scanner: string }> {
    void input.fileName;
    void input.contentType;
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_SCAN_BYTES) {
      throw new AppError("VALIDATION_ERROR", "File scan input exceeds the supported size.", 413);
    }

    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.#host, port: this.#port });
      let response = new Uint8Array();
      let settled = false;
      const timeout = setTimeout(() => fail("ClamAV scan timed out."), this.#timeoutMs);
      const removeAbortListener = () => input.signal?.removeEventListener("abort", onAbort);
      const cleanup = () => {
        clearTimeout(timeout);
        removeAbortListener();
      };
      const fail = (message: string, cause?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(new AppError("DEPENDENCY_UNAVAILABLE", message, 503, { ...(cause ? { cause } : {}) }));
      };
      const complete = (verdict: "clean" | "infected") => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        resolve({ verdict, scanner: "ClamAV" });
      };
      const onAbort = () => fail("ClamAV scan request was cancelled.", input.signal?.reason);

      socket.setNoDelay(true);
      socket.on("error", (cause) => fail("ClamAV scanner is unavailable.", cause));
      socket.on("data", (chunk) => {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        if (response.byteLength + bytes.byteLength > MAX_RESPONSE_BYTES) {
          fail("ClamAV scanner returned an oversized response.");
          return;
        }
        const joined = new Uint8Array(response.byteLength + bytes.byteLength);
        joined.set(response);
        joined.set(bytes, response.byteLength);
        response = joined;
      });
      socket.once("end", () => {
        const result = new TextDecoder().decode(response).replaceAll("\0", "").trim();
        if (result === "stream: OK") {
          complete("clean");
        } else if (/^stream: .+ FOUND$/.test(result)) {
          complete("infected");
        } else {
          fail("ClamAV scanner returned an invalid or unavailable verdict.");
        }
      });
      socket.once("close", () => {
        if (!settled) fail("ClamAV scanner closed the connection before returning a verdict.");
      });

      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => {
        void sendStream(socket, input.bytes).catch((cause: unknown) => fail("ClamAV scan request failed.", cause));
      });
    });
  }
}

function isValidHost(host: string): boolean {
  return (
    host.length >= 1 &&
    host.length <= 255 &&
    ![...host].some((character) => {
      const code = character.charCodeAt(0);
      return character === "/" || character === "\\" || character.trim() === "" || code < 0x20 || code === 0x7f;
    })
  );
}

async function sendStream(socket: ReturnType<typeof createConnection>, bytes: Uint8Array): Promise<void> {
  await write(socket, new TextEncoder().encode("zINSTREAM\0"));
  for (let offset = 0; offset < bytes.byteLength; offset += STREAM_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + STREAM_CHUNK_BYTES, bytes.byteLength));
    const frame = new Uint8Array(4 + chunk.byteLength);
    new DataView(frame.buffer).setUint32(0, chunk.byteLength, false);
    frame.set(chunk, 4);
    await write(socket, frame);
  }
  await write(socket, new Uint8Array(4));
  socket.end();
}

function write(socket: ReturnType<typeof createConnection>, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (cause?: Error | null) => {
      if (cause) reject(cause);
      else resolve();
    });
  });
}
