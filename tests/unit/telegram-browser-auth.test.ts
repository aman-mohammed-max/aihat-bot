import { describe, expect, test } from "bun:test";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import { ApiTokenAuthenticator } from "../../packages/core/src/api-auth.js";
import { createTelegramBrowserAuthHandler } from "../../packages/core/src/telegram-browser-auth.js";

const fixedNow = new Date("2026-10-30T12:00:00.000Z");
const clientId = "123456789";

describe("Telegram browser authentication", () => {
  test("verifies an OIDC token, creates a personal workspace once, and issues a short-lived API token", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    const signingKeys = await createSigningKeys();
    const handler = createTelegramBrowserAuthHandler({
      clientId,
      accounts: repositories.telegramAuth,
      tokens: repositories.apiTokens,
      now: () => fixedNow,
      fetch: async () => new Response(JSON.stringify({ keys: [signingKeys.publicJwk] }), { status: 200 }),
    });

    try {
      const config = await handler(new Request("https://local.test/v1/auth/telegram/browser-config"));
      expect(await config?.json()).toEqual({ enabled: true, clientId });

      const nonceResponse = await handler(browserRequest("/v1/auth/telegram/browser-nonce", {}));
      if (!nonceResponse) throw new Error("Nonce endpoint was not handled.");
      expect(nonceResponse.status).toBe(200);
      expect(nonceResponse.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
      const cookie = nonceResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const { nonce } = (await nonceResponse.json()) as { nonce: string };
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const idToken = await createIdToken(signingKeys.privateKey, signingKeys.publicJwk.kid ?? "", nonce);
      const login = await handler(browserRequest("/v1/auth/telegram/browser", { idToken }, cookie));
      if (!login) throw new Error("Browser sign-in endpoint was not handled.");
      expect(login.status).toBe(201);
      expect(login.headers.get("cache-control")).toBe("no-store");
      expect(login.headers.get("set-cookie")).toContain("Max-Age=0");
      const session = (await login.json()) as { tokenId: string; token: string; expiresAt: string };
      expect(session.token).toMatch(/^ahf_live_[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(session.expiresAt) - fixedNow.getTime()).toBe(12 * 60 * 60 * 1000);

      const principal = await new ApiTokenAuthenticator(repositories.apiTokens, { now: () => fixedNow }).authenticate(
        new Request("https://local.test/v1/whoami", {
          headers: { authorization: `Bearer ${session.token}` },
        }),
      );
      expect(principal.tenantId).toMatch(/^ten_[a-f0-9]{32}$/);
      expect(principal.ownerId).toMatch(/^usr_[a-f0-9]{32}$/);
      expect(db.query("SELECT name FROM tenants WHERE id = ?").get(principal.tenantId)).toEqual({
        name: "Taylor's workspace",
      });

      const replay = await handler(browserRequest("/v1/auth/telegram/browser", { idToken }, cookie));
      expect(replay?.status).toBe(401);
      expect(await replay?.json()).toMatchObject({ error: "UNAUTHENTICATED" });
    } finally {
      db.close();
    }
  });

  test("rejects cross-origin sign-in and invalid token audience without creating an account", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    const signingKeys = await createSigningKeys();
    const handler = createTelegramBrowserAuthHandler({
      clientId,
      accounts: repositories.telegramAuth,
      tokens: repositories.apiTokens,
      now: () => fixedNow,
      fetch: async () => new Response(JSON.stringify({ keys: [signingKeys.publicJwk] }), { status: 200 }),
    });

    try {
      const crossOrigin = await handler(
        new Request("https://local.test/v1/auth/telegram/browser-nonce", {
          method: "POST",
          headers: { origin: "https://attacker.test", "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(crossOrigin?.status).toBe(403);

      const nonceResponse = await handler(browserRequest("/v1/auth/telegram/browser-nonce", {}));
      if (!nonceResponse) throw new Error("Nonce endpoint was not handled.");
      const cookie = nonceResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const { nonce } = (await nonceResponse.json()) as { nonce: string };
      const idToken = await createIdToken(signingKeys.privateKey, signingKeys.publicJwk.kid ?? "", nonce, {
        aud: "987654321",
      });
      const login = await handler(browserRequest("/v1/auth/telegram/browser", { idToken }, cookie));
      expect(login?.status).toBe(401);
      expect(db.query("SELECT count(*) AS count FROM users").get()).toEqual({ count: 0 });
      expect(db.query("SELECT count(*) AS count FROM api_tokens").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

function browserRequest(path: string, body: unknown, cookie?: string): Request {
  return new Request(`https://local.test${path}`, {
    method: "POST",
    headers: {
      origin: "https://local.test",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function createSigningKeys(): Promise<{
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { readonly kid: string };
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "telegram-test-key",
    alg: "RS256",
    use: "sig",
  };
  return { privateKey: pair.privateKey, publicJwk };
}

async function createIdToken(
  privateKey: CryptoKey,
  keyId: string,
  nonce: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(fixedNow.getTime() / 1000);
  const header = encodePart({ alg: "RS256", typ: "JWT", kid: keyId });
  const claims = encodePart({
    iss: "https://oauth.telegram.org",
    aud: clientId,
    sub: "712345678",
    id: 712345678,
    given_name: "Taylor",
    nonce,
    iat: now,
    exp: now + 300,
    ...overrides,
  });
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function encodePart(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
