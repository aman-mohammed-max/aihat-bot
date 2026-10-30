import { API_TOKEN_SCOPES, createApiTokenMaterial } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { ApiTokenRepository, TelegramAuthRepository } from "./ports.js";
import type { TenantId, UserId } from "./types.js";

const ROUTE = "/v1/auth/telegram";
const MAX_INIT_DATA_AGE_SECONDS = 300;
const MAX_FUTURE_SKEW_SECONDS = 60;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** Verify Telegram Mini App initData and exchange it for a short-lived owner API token. */
export function createTelegramWebAppAuthHandler(input: {
  readonly botToken: string;
  readonly accounts: TelegramAuthRepository;
  readonly tokens: ApiTokenRepository;
  readonly now?: () => Date;
}): (request: Request) => Promise<Response | undefined> {
  const now = input.now ?? (() => new Date());
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE) return undefined;
    try {
      if (request.method !== "POST") return methodNotAllowed();
      if (!input.botToken.trim()) {
        throw new AppError("UNSUPPORTED_CAPABILITY", "Telegram Mini App sign-in is not configured.", 503);
      }
      const initData = await readInitData(request);
      const receivedAt = now();
      const identity = await verifyTelegramInitData(input.botToken, initData, receivedAt);
      const accountIds = await telegramAccountIds(identity.id);
      const workspaceName = workspaceLabel(identity.firstName);
      const account = await input.accounts.getOrCreateOwner({
        telegramUserId: identity.id,
        ownerId: accountIds.ownerId,
        tenantId: accountIds.tenantId,
        workspaceName,
        now: receivedAt.toISOString(),
      });
      const dataHash = await sha256Hex(initData);
      const expiresAt = new Date(receivedAt.getTime() + SESSION_LIFETIME_MS).toISOString();
      const claimed = await input.accounts.claimInitData({
        dataHash,
        expiresAt: new Date(receivedAt.getTime() + MAX_INIT_DATA_AGE_SECONDS * 1000).toISOString(),
        now: receivedAt.toISOString(),
      });
      if (!claimed) throw new AppError("UNAUTHENTICATED", "This Telegram sign-in has already been used.", 401);

      const material = await createApiTokenMaterial();
      const tokenId = `token_${crypto.randomUUID()}`;
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
        { status: 201, headers: { "cache-control": "no-store", pragma: "no-cache" } },
      );
    } catch (cause) {
      if (cause instanceof AppError) {
        return Response.json(
          { error: cause.code, message: cause.message },
          {
            status: cause.status,
            headers: { "cache-control": "no-store", pragma: "no-cache" },
          },
        );
      }
      return Response.json(
        { error: "INTERNAL_ERROR", message: "Telegram sign-in could not be completed." },
        { status: 500, headers: { "cache-control": "no-store", pragma: "no-cache" } },
      );
    }
  };
}

export async function verifyTelegramInitData(
  botToken: string,
  initData: string,
  now = new Date(),
): Promise<{ readonly id: number; readonly firstName: string }> {
  if (!botToken || botToken.length > 512 || /\s/.test(botToken) || initData.length > 4096) {
    throw new AppError("UNAUTHENTICATED", "Telegram sign-in data is invalid or expired.", 401);
  }
  const fields = new URLSearchParams(initData);
  const entries = [...fields.entries()];
  const keys = entries.map(([key]) => key);
  if (
    entries.length < 3 ||
    new Set(keys).size !== keys.length ||
    fields.getAll("hash").length !== 1 ||
    fields.getAll("auth_date").length !== 1
  ) {
    throw new AppError("UNAUTHENTICATED", "Telegram sign-in data is invalid or expired.", 401);
  }
  const suppliedHash = fields.get("hash") ?? "";
  const authDateRaw = fields.get("auth_date") ?? "";
  if (!/^[a-f0-9]{64}$/.test(suppliedHash) || !/^\d{1,12}$/.test(authDateRaw)) {
    throw new AppError("UNAUTHENTICATED", "Telegram sign-in data is invalid or expired.", 401);
  }
  const authDate = Number(authDateRaw);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate > nowSeconds + MAX_FUTURE_SKEW_SECONDS ||
    nowSeconds - authDate > MAX_INIT_DATA_AGE_SECONDS
  ) {
    throw new AppError("UNAUTHENTICATED", "Telegram sign-in data is invalid or expired.", 401);
  }

  const dataCheckString = entries
    .filter(([key]) => key !== "hash" && key !== "signature")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const encoder = new TextEncoder();
  const telegramKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", telegramKey, encoder.encode(botToken));
  const verificationKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", verificationKey, encoder.encode(dataCheckString)));
  if (!constantTimeEqual(hex(signature), suppliedHash)) {
    throw new AppError("UNAUTHENTICATED", "Telegram sign-in data is invalid or expired.", 401);
  }

  let user: unknown;
  try {
    user = JSON.parse(fields.get("user") ?? "null");
  } catch (cause) {
    throw new AppError("UNAUTHENTICATED", "Telegram user identity is invalid.", 401, { cause });
  }
  if (!isRecord(user) || !Number.isSafeInteger(user.id) || (user.id as number) < 1 || (user.id as number) > 2 ** 52) {
    throw new AppError("UNAUTHENTICATED", "Telegram user identity is invalid.", 401);
  }
  const firstName = typeof user.first_name === "string" ? user.first_name.trim() : "";
  return { id: user.id as number, firstName: firstName.slice(0, 80) || "Telegram user" };
}

export async function telegramAccountIds(telegramUserId: number): Promise<{ ownerId: UserId; tenantId: TenantId }> {
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId < 1) {
    throw new AppError("VALIDATION_ERROR", "Telegram user ID is invalid.", 400);
  }
  const digest = await sha256Hex(`aihat-telegram-owner:${telegramUserId}`);
  return {
    ownerId: `usr_${digest.slice(0, 32)}` as UserId,
    tenantId: `ten_${digest.slice(32)}` as TenantId,
  };
}

function workspaceLabel(firstName: string): string {
  const safeName = Array.from(firstName, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${safeName || "Telegram user"}'s workspace`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return hex(digest);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function readInitData(request: Request): Promise<string> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 8192) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 8192) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    body = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!isRecord(body) || typeof body.initData !== "string" || body.initData.length < 1 || body.initData.length > 4096) {
    throw new AppError("VALIDATION_ERROR", "Telegram initData is missing or too large.", 400);
  }
  return body.initData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: "Use POST for this endpoint." },
    { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
  );
}
