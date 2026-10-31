import { describe, expect, test } from "bun:test";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import { ApiTokenAuthenticator } from "../../packages/core/src/api-auth.js";
import { createTelegramWebAppAuthHandler } from "../../packages/core/src/telegram-auth.js";

const botToken = "123456789:master-bot-test-token";
const fixedNow = new Date("2026-10-30T12:00:00.000Z");

describe("Telegram Mini App authentication", () => {
  test("verifies signed launch data, creates a personal owner workspace, and issues a short-lived token once", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    const initData = await signedInitData({
      auth_date: String(Math.floor(fixedNow.getTime() / 1000)),
      query_id: "AAE-test-query",
      user: JSON.stringify({ id: 712345678, first_name: "Taylor" }),
    });
    const handler = createTelegramWebAppAuthHandler({
      botToken,
      accounts: repositories.telegramAuth,
      tokens: repositories.apiTokens,
      now: () => fixedNow,
    });
    try {
      const response = await handler(authRequest(initData));
      expect(response?.status).toBe(201);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      const session = (await response?.json()) as { tokenId: string; token: string; expiresAt: string };
      expect(session.token).toMatch(/^ahf_live_[A-Za-z0-9_-]{43}$/);
      expect(session.tokenId).toMatch(/^token_[a-f0-9-]{36}$/);
      expect(Date.parse(session.expiresAt) - fixedNow.getTime()).toBe(12 * 60 * 60 * 1000);

      const principal = await new ApiTokenAuthenticator(repositories.apiTokens, { now: () => fixedNow }).authenticate(
        new Request("https://local.test/v1/whoami", {
          headers: { authorization: `Bearer ${session.token}` },
        }),
      );
      expect(principal.tenantId).toMatch(/^ten_[a-f0-9]{32}$/);
      expect(principal.ownerId).toMatch(/^usr_[a-f0-9]{32}$/);
      expect(principal.scopes).toContain("bots:write");
      expect(db.query("SELECT name FROM tenants WHERE id = ?").get(principal.tenantId)).toEqual({
        name: "Taylor's workspace",
      });

      const replay = await handler(authRequest(initData));
      expect(replay?.status).toBe(401);
      expect(await replay?.json()).toMatchObject({ error: "UNAUTHENTICATED" });
    } finally {
      db.close();
    }
  });

  test("rejects forged and stale launch data without creating an account", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    const handler = createTelegramWebAppAuthHandler({
      botToken,
      accounts: repositories.telegramAuth,
      tokens: repositories.apiTokens,
      now: () => fixedNow,
    });
    try {
      const forged = await signedInitData({
        auth_date: String(Math.floor(fixedNow.getTime() / 1000)),
        query_id: "forged-query",
        user: JSON.stringify({ id: 712345678, first_name: "Taylor" }),
      });
      const forgedParams = new URLSearchParams(forged);
      forgedParams.set("user", JSON.stringify({ id: 987654321, first_name: "Mallory" }));
      const forgedResponse = await handler(authRequest(forgedParams.toString()));
      expect(forgedResponse?.status).toBe(401);

      const stale = await signedInitData({
        auth_date: String(Math.floor(fixedNow.getTime() / 1000) - 301),
        query_id: "stale-query",
        user: JSON.stringify({ id: 712345678, first_name: "Taylor" }),
      });
      expect((await handler(authRequest(stale)))?.status).toBe(401);
      expect(db.query("SELECT count(*) AS count FROM users").get()).toEqual({ count: 0 });
      expect(db.query("SELECT count(*) AS count FROM api_tokens").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test("fails closed when the master bot token is not configured", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      const handler = createTelegramWebAppAuthHandler({
        botToken: "",
        accounts: repositories.telegramAuth,
        tokens: repositories.apiTokens,
        now: () => fixedNow,
      });
      const response = await handler(authRequest("unused"));
      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({ error: "UNSUPPORTED_CAPABILITY" });
    } finally {
      db.close();
    }
  });
});

function authRequest(initData: string): Request {
  return new Request("https://local.test/v1/auth/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  });
}

async function signedInitData(fields: Record<string, string>): Promise<string> {
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const encoder = new TextEncoder();
  const outerKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", outerKey, encoder.encode(botToken));
  const innerKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", innerKey, encoder.encode(dataCheckString)));
  const hash = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams([...Object.entries(fields), ["hash", hash]]).toString();
}
