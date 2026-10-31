import { describe, expect, test } from "bun:test";
import { CloudflareD1Repositories } from "../../apps/cloudflare-runtime/src/d1-repositories.js";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import { createNetworkAbuseGuard } from "../../packages/core/src/network-abuse.js";
import type { NetworkRequestRateLimiter, SecretKeyring } from "../../packages/core/src/ports.js";
import { SqliteD1 } from "../helpers/sqlite-d1.js";

const fixedNow = new Date("2026-10-31T12:00:00.000Z");

describe("network abuse rate limit parity", () => {
  test("Bun SQLite applies one atomic address limit across unrelated API paths", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      await assertNetworkLimit(repositories.networkRateLimiter, db);
    } finally {
      db.close();
    }
  });

  test("Cloudflare D1 applies the same atomic address limit across unrelated API paths", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    try {
      await assertNetworkLimit(repositories.networkRateLimiter, db);
    } finally {
      db.close();
    }
  });

  test("fails closed when address hashing key material is unavailable", async () => {
    let consumed = false;
    const guard = createNetworkAbuseGuard({
      limiter: {
        consume: async () => {
          consumed = true;
          return true;
        },
      },
      requestsPerMinute: 600,
      keyring: {
        activeKey: async () => {
          throw new Error("missing keyring");
        },
        getKey: async () => undefined,
      },
    });
    const response = await guard(new Request("https://local.test/v1/whoami"), "203.0.113.40");
    expect(response?.status).toBe(503);
    expect(consumed).toBe(false);
  });
});

async function assertNetworkLimit(limiter: NetworkRequestRateLimiter, db: ReturnType<typeof openSqliteDatabase>) {
  let now = fixedNow;
  const keyring: SecretKeyring = {
    activeKey: async () => ({ id: "rate-limit-key", material: new Uint8Array(32).fill(51) }),
    getKey: async () => undefined,
  };
  const guard = createNetworkAbuseGuard({ limiter, keyring, requestsPerMinute: 10, now: () => now });
  const requests = Array.from(
    { length: 20 },
    (_, index) => new Request(`https://local.test/${index < 10 ? "v1/whoami" : "v1/auth/telegram/browser-config"}`),
  );
  const decisions = await Promise.all(requests.map((request) => guard(request, "203.0.113.40")));
  expect(decisions.filter((response) => response === undefined)).toHaveLength(10);
  expect(decisions.filter((response) => response?.status === 429)).toHaveLength(10);
  expect(decisions.find((response) => response?.status === 429)?.headers.get("retry-after")).toBe("60");

  const stored = db
    .query<{ client_hash: string; request_count: number }, []>(
      "SELECT client_hash, request_count FROM network_request_usage",
    )
    .get();
  expect(stored?.client_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(stored?.client_hash).not.toBe("203.0.113.40");
  expect(stored?.request_count).toBe(10);

  const differentAddress = await guard(new Request("https://local.test/v1/whoami"), "203.0.113.41");
  expect(differentAddress).toBeUndefined();

  const health = await guard(new Request("https://local.test/health"), "203.0.113.40");
  expect(health).toBeUndefined();
  const webhook = await guard(
    new Request("https://local.test/webhooks/telegram/dep_12345678-1234-1234-1234-123456789abc"),
    "203.0.113.40",
  );
  expect(webhook).toBeUndefined();
  const invalidWebhook = await guard(new Request("https://local.test/webhooks/telegram/master"), "203.0.113.40", true);
  expect(invalidWebhook?.status).toBe(429);

  now = new Date(fixedNow.getTime() + 60_000);
  const nextWindow = await guard(new Request("https://local.test/v1/whoami"), "203.0.113.40");
  expect(nextWindow).toBeUndefined();
}
