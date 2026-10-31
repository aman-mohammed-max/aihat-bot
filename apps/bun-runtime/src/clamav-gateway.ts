import { AppError } from "@aihat/core";
import type { MalwareScanner } from "@aihat/core";

const SCAN_PATH = "/internal/file-scan";
const MAX_SCAN_BYTES = 25 * 1024 * 1024;
const MAX_TOKEN_BYTES = 4_096;
const MAX_CONCURRENT_SCANS = 4;

/** Exposes the Bun ClamAV scanner through the HTTPS gateway contract used by Workers. */
export function createOptionalClamDGateway(input: {
  readonly scanner?: MalwareScanner;
  readonly token?: string;
}): ((request: Request) => Promise<Response | undefined>) | undefined {
  const token = input.token ?? "";
  if (!input.scanner && !token) return undefined;
  if (!input.scanner) {
    throw new AppError("VALIDATION_ERROR", "A ClamAV scanner is required for the file-scanner gateway.", 500);
  }
  const scanner = input.scanner;
  if (!token) return undefined;
  if (token.length < 32 || token.length > MAX_TOKEN_BYTES || /[\s\r\n]/.test(token)) {
    throw new AppError("VALIDATION_ERROR", "FILE_SCANNER_GATEWAY_TOKEN must be a strong, whitespace-free token.", 500);
  }

  const expectedTokenHash = digest(token);
  let activeScans = 0;
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== SCAN_PATH) return undefined;
    if (request.method !== "POST") return jsonError("METHOD_NOT_ALLOWED", 405, { allow: "POST" });

    const authorization = request.headers.get("authorization") ?? "";
    const suppliedToken = parseBearerToken(authorization);
    if (!(await tokenMatches(suppliedToken, expectedTokenHash))) {
      return jsonError("UNAUTHORIZED", 401, { "www-authenticate": "Bearer" });
    }

    const contentType = request.headers.get("content-type") ?? "";
    const encodedFileName = request.headers.get("x-file-name-encoded") ?? "";
    const fileName = decodeFileName(encodedFileName);
    if (!isValidContentType(contentType) || !fileName) return jsonError("INVALID_SCAN_REQUEST", 400);

    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^\d{1,10}$/.test(declaredLength)) return jsonError("INVALID_SCAN_REQUEST", 400);
      if (Number(declaredLength) > MAX_SCAN_BYTES) {
        await request.body?.cancel();
        return jsonError("FILE_TOO_LARGE", 413);
      }
    }

    if (activeScans >= MAX_CONCURRENT_SCANS) {
      return jsonError("SCANNER_BUSY", 503, { "retry-after": "1" });
    }
    activeScans += 1;
    try {
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBody(request, MAX_SCAN_BYTES);
      } catch (cause) {
        if (cause instanceof AppError) return jsonError("FILE_TOO_LARGE", 413);
        return jsonError("INVALID_SCAN_REQUEST", 400);
      }
      if (bytes.byteLength === 0) return jsonError("INVALID_SCAN_REQUEST", 400);

      try {
        const result = await scanner.scan({
          fileName,
          contentType,
          bytes,
          signal: request.signal,
        });
        return Response.json(
          {
            verdict: result.verdict,
            scanner: result.scanner.replaceAll(/[^a-zA-Z0-9 ._-]/g, "_").slice(0, 80) || "ClamAV",
          },
          { headers: responseHeaders() },
        );
      } catch {
        return jsonError("SCANNER_UNAVAILABLE", 503);
      }
    } finally {
      activeScans -= 1;
    }
  };
}

function parseBearerToken(header: string): string {
  if (header.length > MAX_TOKEN_BYTES + 7) return "";
  const separator = header.indexOf(" ");
  if (separator < 1 || header.slice(0, separator).toLowerCase() !== "bearer") return "";
  const token = header.slice(separator + 1);
  return token && !/\s/.test(token) ? token : "";
}

async function tokenMatches(suppliedToken: string, expectedHash: Promise<Uint8Array>): Promise<boolean> {
  const [actual, expected] = await Promise.all([digest(suppliedToken), expectedHash]);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  return difference === 0 && suppliedToken.length > 0;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function isValidContentType(value: string): boolean {
  return value.length >= 3 && value.length <= 255 && !/[\r\n\0]/.test(value);
}

function decodeFileName(value: string): string | undefined {
  if (value.length < 1 || value.length > 2_048 || /[\r\n\0]/.test(value)) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.length < 1 ||
      decoded.length > 255 ||
      [...decoded].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

async function readBoundedBody(request: Request, maximum: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new AppError("VALIDATION_ERROR", "File scan input exceeds the supported size.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  const mergedHeaders = new Headers(responseHeaders());
  new Headers(headers).forEach((value, key) => {
    mergedHeaders.set(key, value);
  });
  return Response.json({ error }, { status, headers: mergedHeaders });
}

function responseHeaders(): HeadersInit {
  return { "cache-control": "no-store", "x-content-type-options": "nosniff" };
}
