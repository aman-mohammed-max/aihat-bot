import { AppError } from "./errors.js";
import type { NetworkRequestRateLimiter, SecretKeyring } from "./ports.js";

export const DEFAULT_NETWORK_REQUESTS_PER_MINUTE = 600;
const WEBHOOK_PATH = /^\/webhooks\/telegram\/(?:master|dep_[0-9a-f-]{36})$/u;

/** Apply one persistent, cross-account limit per network address without retaining raw addresses. */
export function createNetworkAbuseGuard(input: {
  readonly limiter: NetworkRequestRateLimiter;
  readonly keyring: SecretKeyring;
  readonly requestsPerMinute: number;
  readonly now?: () => Date;
}): (
  request: Request,
  clientAddress: string | null | undefined,
  forceWebhookCheck?: boolean,
) => Promise<Response | undefined> {
  const now = input.now ?? (() => new Date());
  if (
    !Number.isSafeInteger(input.requestsPerMinute) ||
    input.requestsPerMinute < 10 ||
    input.requestsPerMinute > 10_000
  ) {
    throw new AppError("VALIDATION_ERROR", "Network request limit must be between 10 and 10000 per minute.", 400);
  }
  let keyPromise: Promise<CryptoKey> | undefined;

  return async (request, clientAddress, forceWebhookCheck = false) => {
    const path = new URL(request.url).pathname;
    if (isHealthRequest(request) || (WEBHOOK_PATH.test(path) && !forceWebhookCheck)) return undefined;

    try {
      if (forceWebhookCheck && !WEBHOOK_PATH.test(path)) {
        throw new AppError("INTERNAL_ERROR", "Invalid network limiter webhook override.", 500);
      }
      keyPromise ??= importHmacKey(input.keyring);
      const key = await keyPromise;
      const address = normalizeClientAddress(clientAddress);
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`aihat-network-limit-v1\u0000${address}`),
      );
      const clientHash = toHex(new Uint8Array(signature));
      const current = now();
      const allowed = await input.limiter.consume({
        clientHash,
        now: current.toISOString(),
        limitPerMinute: input.requestsPerMinute,
      });
      if (allowed) return undefined;
      return Response.json(
        { error: "RATE_LIMITED", message: "This network has reached its request limit." },
        {
          status: 429,
          headers: { "cache-control": "no-store", "retry-after": "60" },
        },
      );
    } catch {
      return Response.json(
        { error: "DEPENDENCY_UNAVAILABLE", message: "Network abuse protection is unavailable." },
        { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
      );
    }
  };
}

async function importHmacKey(keyring: SecretKeyring): Promise<CryptoKey> {
  const active = await keyring.activeKey();
  if (active.material.byteLength !== 32) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Network abuse protection key is invalid.", 503);
  }
  const material = new Uint8Array(active.material.byteLength);
  material.set(active.material);
  return crypto.subtle.importKey("raw", material.buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function isHealthRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const path = new URL(request.url).pathname;
  return path === "/health" || path === "/ready" || path === "/capabilities";
}

function normalizeClientAddress(value: string | null | undefined): string {
  const address = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    !address ||
    address.length > 64 ||
    Array.from(address).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f;
    })
  ) {
    return "unknown";
  }
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
