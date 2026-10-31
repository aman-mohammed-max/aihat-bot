import { API_TOKEN_SCOPES, createApiTokenMaterial } from "./api-auth.js";
import { AppError } from "./errors.js";
import { readBoundedRequestText } from "./http-body.js";
import type { ApiTokenRepository, TelegramAuthRepository } from "./ports.js";
import { telegramAccountIds } from "./telegram-auth.js";

const CONFIG_ROUTE = "/v1/auth/telegram/browser-config";
const NONCE_ROUTE = "/v1/auth/telegram/browser-nonce";
const LOGIN_ROUTE = "/v1/auth/telegram/browser";
const NONCE_COOKIE = "aihat_telegram_login_nonce";
const TOKEN_MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;
const TOKEN_MAX_BYTES = 16_384;
const JWKS_MAX_BYTES = 32_768;
const ISSUER = "https://oauth.telegram.org";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Browser sign-in using Telegram Login's signed OIDC ID token and a browser-bound nonce. */
export function createTelegramBrowserAuthHandler(input: {
  readonly clientId: string;
  readonly accounts: TelegramAuthRepository;
  readonly tokens: ApiTokenRepository;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}): (request: Request) => Promise<Response | undefined> {
  const now = input.now ?? (() => new Date());
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const clientId = /^[0-9]{5,15}$/.test(input.clientId) ? input.clientId : "";

  return async (request) => {
    const url = new URL(request.url);
    if (![CONFIG_ROUTE, NONCE_ROUTE, LOGIN_ROUTE].includes(url.pathname)) return undefined;
    if (url.pathname === CONFIG_ROUTE) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return Response.json(
        { enabled: clientId.length > 0, ...(clientId ? { clientId } : {}) },
        { headers: noStoreHeaders() },
      );
    }

    let clearNonceCookie = false;
    try {
      if (!clientId) throw new AppError("UNSUPPORTED_CAPABILITY", "Telegram browser sign-in is not configured.", 503);
      requireSameOrigin(request);
      if (url.pathname === NONCE_ROUTE) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        await readEmptyJsonBody(request);
        const nonce = randomBase64Url(32);
        return Response.json(
          { nonce },
          { headers: { ...noStoreHeaders(), "set-cookie": nonceCookie(request.url, nonce) } },
        );
      }

      if (request.method !== "POST") return methodNotAllowed("POST");
      clearNonceCookie = true;
      const nonce = readCookie(request.headers.get("cookie") ?? "", NONCE_COOKIE);
      if (!nonce || !/^[A-Za-z0-9_-]{40,64}$/.test(nonce)) {
        throw new AppError("UNAUTHENTICATED", "Start a new Telegram sign-in and try again.", 401);
      }
      const idToken = await readIdToken(request);
      const receivedAt = now();
      const identity = await verifyIdToken({ idToken, clientId, nonce, now: receivedAt, fetch: fetcher });
      const replayHash = await sha256Hex(idToken);
      const claimed = await input.accounts.claimInitData({
        dataHash: replayHash,
        expiresAt: new Date(receivedAt.getTime() + TOKEN_MAX_AGE_SECONDS * 1000).toISOString(),
        now: receivedAt.toISOString(),
      });
      if (!claimed) throw new AppError("UNAUTHENTICATED", "This Telegram sign-in has already been used.", 401);

      const accountIds = await telegramAccountIds(identity.id);
      const account = await input.accounts.getOrCreateOwner({
        telegramUserId: identity.id,
        ownerId: accountIds.ownerId,
        tenantId: accountIds.tenantId,
        workspaceName: workspaceLabel(identity.firstName),
        now: receivedAt.toISOString(),
      });
      const material = await createApiTokenMaterial();
      const tokenId = "token_" + crypto.randomUUID();
      const expiresAt = new Date(receivedAt.getTime() + 12 * 60 * 60 * 1000).toISOString();
      await input.tokens.create({
        tokenId,
        tenantId: account.tenantId,
        ownerId: account.ownerId,
        tokenHash: material.tokenHash,
        tokenPrefix: material.tokenPrefix,
        scopes: API_TOKEN_SCOPES,
        createdAt: receivedAt.toISOString(),
        expiresAt,
      });
      return Response.json(
        { tokenId, token: material.token, expiresAt },
        { status: 201, headers: { ...noStoreHeaders(), "set-cookie": clearNonceCookieHeader(request.url) } },
      );
    } catch (cause) {
      const response = errorResponse(cause);
      if (clearNonceCookie) response.headers.set("set-cookie", clearNonceCookieHeader(request.url));
      return response;
    }
  };
}

async function verifyIdToken(input: {
  readonly idToken: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly now: Date;
  readonly fetch: FetchLike;
}): Promise<{ readonly id: number; readonly firstName: string }> {
  const parts = input.idToken.split(".");
  if (parts.length !== 3 || input.idToken.length > TOKEN_MAX_BYTES) {
    throw new AppError("UNAUTHENTICATED", "Telegram ID token is invalid.", 401);
  }
  const header = parseJwtPart(parts[0] ?? "");
  const claims = parseJwtPart(parts[1] ?? "");
  const signature = new Uint8Array(decodeBase64Url(parts[2] ?? ""));
  if (
    !isRecord(header) ||
    !isRecord(claims) ||
    header.alg !== "RS256" ||
    (header.typ !== undefined && header.typ !== "JWT") ||
    typeof header.kid !== "string" ||
    !header.kid ||
    header.kid.length > 256 ||
    header.crit !== undefined ||
    claims.iss !== ISSUER ||
    typeof claims.sub !== "string" ||
    claims.sub.length < 1 ||
    claims.sub.length > 256 ||
    typeof claims.nonce !== "string" ||
    !constantTimeEqual(claims.nonce, input.nonce)
  ) {
    throw new AppError("UNAUTHENTICATED", "Telegram ID token is invalid.", 401);
  }

  const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (
    !audiences.includes(input.clientId) ||
    audiences.some((audience) => typeof audience !== "string") ||
    (claims.azp !== undefined && claims.azp !== input.clientId) ||
    (audiences.length > 1 && claims.azp !== input.clientId)
  ) {
    throw new AppError("UNAUTHENTICATED", "Telegram ID token audience is invalid.", 401);
  }
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (
    !Number.isSafeInteger(claims.exp) ||
    !Number.isSafeInteger(claims.iat) ||
    (claims.exp as number) <= nowSeconds ||
    (claims.iat as number) > nowSeconds + CLOCK_SKEW_SECONDS ||
    nowSeconds - (claims.iat as number) > TOKEN_MAX_AGE_SECONDS ||
    (claims.exp as number) <= (claims.iat as number) ||
    (claims.exp as number) - (claims.iat as number) > 3600 + CLOCK_SKEW_SECONDS ||
    (claims.nbf !== undefined &&
      (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > nowSeconds + CLOCK_SKEW_SECONDS))
  ) {
    throw new AppError("UNAUTHENTICATED", "Telegram ID token is expired or not yet valid.", 401);
  }

  const key = await resolveSigningKey(input.fetch, header.kid);
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature,
    new TextEncoder().encode(parts[0] + "." + parts[1]),
  );
  if (!valid) throw new AppError("UNAUTHENTICATED", "Telegram ID token signature is invalid.", 401);
  const id = parseTelegramId(claims.id);
  if (id === undefined) throw new AppError("UNAUTHENTICATED", "Telegram profile is missing its user ID.", 401);
  const name = safeName(claims.given_name) ?? safeName(claims.name)?.split(/\s+/u)[0] ?? "Telegram user";
  return { id, firstName: name };
}

async function resolveSigningKey(fetcher: FetchLike, keyId: string): Promise<CryptoKey> {
  let response: Response;
  try {
    response = await fetcher(JWKS_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (cause) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram signing keys are unavailable.", 503, { cause });
  }
  if (!response.ok) throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram signing keys are unavailable.", 503);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > JWKS_MAX_BYTES) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram signing key response is too large.", 503);
  }
  let body: unknown;
  try {
    const text = await readBoundedResponseText(response, JWKS_MAX_BYTES);
    body = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram signing keys are invalid.", 503, { cause });
  }
  if (!isRecord(body) || !Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 50) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram signing keys are invalid.", 503);
  }
  const jwk = body.keys.find(
    (candidate): candidate is JsonWebKey & { readonly kid: string } =>
      isRecord(candidate) &&
      candidate.kid === keyId &&
      candidate.kty === "RSA" &&
      (candidate.alg === undefined || candidate.alg === "RS256") &&
      (candidate.use === undefined || candidate.use === "sig") &&
      (candidate.key_ops === undefined ||
        (Array.isArray(candidate.key_ops) && candidate.key_ops.every((operation) => operation === "verify"))),
  );
  if (!jwk) throw new AppError("UNAUTHENTICATED", "Telegram ID token signing key is unknown.", 401);
  try {
    return await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch (cause) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram signing key could not be imported.", 503, { cause });
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram signing key response is too large.", 503);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function requireSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new AppError("UNAUTHENTICATED", "Telegram sign-in must come from this application.", 403);
  }
}

async function readEmptyJsonBody(request: Request): Promise<void> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 1024)
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  let body: unknown;
  try {
    const text = await readBoundedRequestText(request, 1024);
    if (new TextEncoder().encode(text).byteLength > 1024) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    body = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!isRecord(body) || Object.keys(body).length !== 0) {
    throw new AppError("VALIDATION_ERROR", "Request body must be an empty JSON object.", 400);
  }
}

async function readIdToken(request: Request): Promise<string> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > TOKEN_MAX_BYTES + 1024) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let body: unknown;
  try {
    const text = await readBoundedRequestText(request, TOKEN_MAX_BYTES + 1024);
    if (new TextEncoder().encode(text).byteLength > TOKEN_MAX_BYTES + 1024) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    body = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.idToken !== "string" ||
    body.idToken.length < 1 ||
    body.idToken.length > TOKEN_MAX_BYTES
  ) {
    throw new AppError("VALIDATION_ERROR", "Telegram ID token is missing or too large.", 400);
  }
  return body.idToken;
}

function parseJwtPart(value: string): unknown {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value));
    return JSON.parse(decoded);
  } catch (cause) {
    throw new AppError("UNAUTHENTICATED", "Telegram ID token is invalid.", 401, { cause });
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError("UNAUTHENTICATED", "Telegram ID token encoding is invalid.", 401);
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (cause) {
    throw new AppError("UNAUTHENTICATED", "Telegram ID token encoding is invalid.", 401, { cause });
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function nonceCookie(requestUrl: string, nonce: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return NONCE_COOKIE + "=" + nonce + "; HttpOnly; SameSite=Strict; Path=/v1/auth/telegram; Max-Age=300" + secure;
}

function clearNonceCookieHeader(requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return NONCE_COOKIE + "=; HttpOnly; SameSite=Strict; Path=/v1/auth/telegram; Max-Age=0" + secure;
}

function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function parseTelegramId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 2 ** 52 ? id : undefined;
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = Array.from(value.trim(), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .slice(0, 80);
  return normalized || undefined;
}

function workspaceLabel(firstName: string): string {
  return (firstName || "Telegram user") + "'s workspace";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function noStoreHeaders(): HeadersInit {
  return { "cache-control": "no-store", pragma: "no-cache" };
}

function errorResponse(cause: unknown): Response {
  if (cause instanceof AppError) {
    return Response.json(
      { error: cause.code, message: cause.message },
      { status: cause.status, headers: noStoreHeaders() },
    );
  }
  return Response.json(
    { error: "INTERNAL_ERROR", message: "Telegram sign-in could not be completed." },
    { status: 500, headers: noStoreHeaders() },
  );
}

function methodNotAllowed(method: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: "Use " + method + " for this endpoint." },
    { status: 405, headers: { ...noStoreHeaders(), allow: method } },
  );
}
