import { describe, expect, test } from "bun:test";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import {
  ApiTokenAuthenticator,
  createApiTokenMaterial,
  hashApiToken,
  recordApiAuthorizationDenial,
  requireApiScope,
} from "../../packages/core/src/api-auth.js";
import { AppError } from "../../packages/core/src/errors.js";
import { createManagementApiHandler } from "../../packages/core/src/http-api.js";
import type { TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-api-auth" as TenantId;
const ownerId = "user-api-auth" as UserId;

describe("opaque API-token authentication", () => {
  test("hashes tokens, binds the principal to a live tenant membership, and supports revocation", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedOwner(db);
      const material = await createApiTokenMaterial();
      expect(material.token).toMatch(/^ahf_live_[A-Za-z0-9_-]{43}$/);
      expect(material.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(await hashApiToken(material.token)).toBe(material.tokenHash);
      expect(material.tokenPrefix).toBe(material.token.slice(0, 16));

      await repositories.apiTokens.create({
        tokenId: "token-auth-1",
        tenantId,
        ownerId,
        tokenHash: material.tokenHash,
        tokenPrefix: material.tokenPrefix,
        scopes: ["factory:read", "factory:write", "tokens:manage"],
        createdAt: "2026-10-30T00:00:00.000Z",
      });
      const authenticator = new ApiTokenAuthenticator(repositories.apiTokens);
      const request = authenticatedRequest(material.token);
      const principal = await authenticator.authenticate(request);
      expect(principal).toEqual({
        tokenId: "token-auth-1",
        tenantId,
        ownerId,
        scopes: ["factory:read", "factory:write", "tokens:manage"],
        tenantRole: "owner",
        delegableScopes: ["factory:read", "factory:write", "tokens:manage"],
      });
      await expect(requireApiScope(principal, "factory:write")).resolves.toBeUndefined();
      await expect(requireApiScope(principal, "bots:write")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      const managementApi = createManagementApiHandler(authenticator, repositories.apiTokens);
      const whoami = await managementApi(request);
      expect(whoami?.status).toBe(200);
      expect(await whoami?.json()).toEqual({
        tenantId,
        userId: ownerId,
        tokenId: "token-auth-1",
        scopes: ["factory:read", "factory:write", "tokens:manage"],
      });

      const issueResponse = await managementApi(
        new Request("https://local.test/v1/tokens", {
          method: "POST",
          headers: {
            authorization: `Bearer ${material.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ scopes: ["agent:run"] }),
        }),
      );
      expect(issueResponse?.status).toBe(403);

      const scopedIssueResponse = await managementApi(
        new Request("https://local.test/v1/tokens", {
          method: "POST",
          headers: {
            authorization: `Bearer ${material.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ scopes: ["factory:read"] }),
        }),
      );
      expect(scopedIssueResponse?.status).toBe(201);
      expect(scopedIssueResponse?.headers.get("cache-control")).toBe("no-store");
      const issued = (await scopedIssueResponse?.json()) as {
        token: string;
        tokenId: string;
        scopes: string[];
        expiresAt: string;
      };
      expect(issued.token).toMatch(/^ahf_live_[A-Za-z0-9_-]{43}$/);
      expect(issued.scopes).toEqual(["factory:read"]);
      expect(Number.isFinite(Date.parse(issued.expiresAt))).toBe(true);
      const issuedRequest = authenticatedRequest(issued.token);
      expect((await authenticator.authenticate(issuedRequest)).tokenId).toBe(issued.tokenId);

      const revokeResponse = await managementApi(
        new Request(`https://local.test/v1/tokens/${issued.tokenId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${material.token}` },
        }),
      );
      expect(revokeResponse?.status).toBe(204);
      await expect(authenticator.authenticate(issuedRequest)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401,
      });

      await repositories.apiTokens.revoke(tenantId, ownerId, principal.tokenId, "2026-10-30T01:00:00.000Z");
      await expect(authenticator.authenticate(request)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401,
      });
    } finally {
      db.close();
    }
  });

  test("rejects malformed, missing, and expired credentials without revealing token state", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedOwner(db);
      const material = await createApiTokenMaterial();
      await repositories.apiTokens.create({
        tokenId: "token-auth-expired",
        tenantId,
        ownerId,
        tokenHash: material.tokenHash,
        tokenPrefix: material.tokenPrefix,
        scopes: ["factory:read"],
        createdAt: "2026-10-30T00:00:00.000Z",
        expiresAt: "2026-10-30T00:00:00.000Z",
      });
      const authenticator = new ApiTokenAuthenticator(repositories.apiTokens);
      const identityApi = createManagementApiHandler(authenticator, repositories.apiTokens);

      const unauthorized = await identityApi(new Request("https://local.test/v1/whoami"));
      expect(unauthorized?.status).toBe(401);
      expect(unauthorized?.headers.get("www-authenticate")).toBe("Bearer");
      await expect(authenticator.authenticate(new Request("https://local.test"))).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401,
      });
      await expect(authenticator.authenticate(authenticatedRequest("not-a-token"))).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401,
      });
      await expect(authenticator.authenticate(authenticatedRequest(material.token))).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401,
      });
      await expect(hashApiToken("invalid")).rejects.toBeInstanceOf(AppError);
    } finally {
      db.close();
    }
  });

  test("limits member scopes by workspace role while preserving the original scope ceiling", async () => {
    const material = await createApiTokenMaterial();
    const rawScopes = ["factory:read", "bots:read", "skills:publish", "members:manage"];
    const authenticator = new ApiTokenAuthenticator({
      findActive: async () => ({
        tokenId: "token-member-role",
        tenantId,
        ownerId,
        scopes: rawScopes,
        tenantRole: "member",
      }),
      create: async () => {},
      revoke: async () => {},
      consumeApiRequest: async () => true,
      recordApiMutation: async () => {},
    });

    const principal = await authenticator.authenticate(authenticatedRequest(material.token));

    expect(principal.scopes).toEqual(["factory:read", "bots:read"]);
    expect(principal.delegableScopes).toEqual(rawScopes);
  });

  test("records an authenticated scope denial without storing query values", async () => {
    const material = await createApiTokenMaterial();
    let recorded: unknown;
    const authenticator = new ApiTokenAuthenticator(
      {
        findActive: async () => ({
          tokenId: "token-limited",
          tenantId,
          ownerId,
          scopes: ["bots:read"],
          tenantRole: "member",
        }),
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      },
      {
        now: () => new Date("2026-10-30T12:00:00.000Z"),
        authorizationAudit: {
          recordApiAuthorizationDenial: async (event) => {
            recorded = event;
          },
        },
      },
    );
    const request = new Request("https://local.test/v1/bots?providerKey=must-not-be-recorded", {
      method: "POST",
      headers: { authorization: `Bearer ${material.token}` },
    });
    const principal = await authenticator.authenticate(request);

    await expect(requireApiScope(principal, "bots:write")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(recorded).toEqual({
      tenantId,
      ownerId,
      tokenId: "token-limited",
      method: "POST",
      pathname: "/v1/bots",
      denialType: "scope",
      errorCode: "FORBIDDEN",
      requiredScope: "bots:write",
      createdAt: "2026-10-30T12:00:00.000Z",
    });
  });

  test("records authenticated resource denials without storing query values", async () => {
    const material = await createApiTokenMaterial();
    let recorded: unknown;
    const request = new Request("https://local.test/v1/bots/bot_private?debug=secret-value", {
      headers: { authorization: `Bearer ${material.token}` },
    });
    const authenticator = new ApiTokenAuthenticator(
      {
        findActive: async () => ({
          tokenId: "token-resource-denial",
          tenantId,
          ownerId,
          scopes: ["bots:read"],
          tenantRole: "member",
        }),
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      },
      {
        authorizationAudit: {
          recordApiAuthorizationDenial: async (event) => {
            recorded = event;
          },
        },
      },
    );
    await authenticator.authenticate(request);

    await recordApiAuthorizationDenial(request, new AppError("NOT_FOUND", "Bot was not found.", 404));

    expect(recorded).toEqual({
      tenantId,
      ownerId,
      tokenId: "token-resource-denial",
      method: "GET",
      pathname: "/v1/bots/bot_private",
      denialType: "resource",
      errorCode: "NOT_FOUND",
      createdAt: expect.any(String),
    });
  });

  test("limits authenticated API calls across every token owned by the same account", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedOwner(db);
      const firstToken = await createApiTokenMaterial();
      const secondToken = await createApiTokenMaterial();
      for (const [index, material] of [firstToken, secondToken].entries()) {
        await repositories.apiTokens.create({
          tokenId: `token-rate-${index}`,
          tenantId,
          ownerId,
          tokenHash: material.tokenHash,
          tokenPrefix: material.tokenPrefix,
          scopes: ["factory:read"],
          createdAt: "2026-10-30T12:00:00.000Z",
        });
      }
      let now = new Date("2026-10-30T12:00:00.000Z");
      const authenticator = new ApiTokenAuthenticator(repositories.apiTokens, {
        requestsPerMinute: 2,
        now: () => now,
      });

      expect((await authenticator.authenticate(authenticatedRequest(firstToken.token))).tokenId).toBe("token-rate-0");
      expect((await authenticator.authenticate(authenticatedRequest(secondToken.token))).tokenId).toBe("token-rate-1");
      await expect(authenticator.authenticate(authenticatedRequest(firstToken.token))).rejects.toMatchObject({
        code: "RATE_LIMITED",
        status: 429,
      });

      now = new Date("2026-10-30T12:01:00.000Z");
      expect((await authenticator.authenticate(authenticatedRequest(firstToken.token))).tokenId).toBe("token-rate-0");
    } finally {
      db.close();
    }
  });

  test("records authenticated writes without storing request bodies or query strings", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedOwner(db);
      const material = await createApiTokenMaterial();
      const now = "2026-10-30T12:00:00.000Z";
      await repositories.apiTokens.create({
        tokenId: "token-audit",
        tenantId,
        ownerId,
        tokenHash: material.tokenHash,
        tokenPrefix: material.tokenPrefix,
        scopes: ["bots:read", "bots:write", "agent:run"],
        createdAt: now,
      });
      const authenticator = new ApiTokenAuthenticator(repositories.apiTokens, { now: () => new Date(now) });
      const authorization = { authorization: `Bearer ${material.token}`, "content-type": "application/json" };
      await authenticator.authenticate(
        new Request("https://local.test/v1/bots/bot_private?api_key=query-secret", {
          method: "PATCH",
          headers: authorization,
          body: JSON.stringify({ prompt: "body-secret" }),
        }),
      );
      await authenticator.authenticate(
        new Request("https://local.test/v1/bots/bot_00000000-0000-0000-0000-000000000000/messages", {
          method: "POST",
          headers: authorization,
          body: JSON.stringify({ prompt: "chat messages are not mutation audit events" }),
        }),
      );
      await authenticator.authenticate(new Request("https://local.test/v1/bots", { headers: authorization }));

      const events = await repositories.listOwnedAuditLogs({ tenantId, ownerId, limit: 10 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "api.mutation_attempt",
        resourceType: "http_api",
        resourceId: "PATCH /v1/bots/bot_private",
        metadata: { tokenId: "token-audit", method: "PATCH", path: "/v1/bots/bot_private" },
        createdAt: now,
      });
      expect(JSON.stringify(events)).not.toContain("query-secret");
      expect(JSON.stringify(events)).not.toContain("body-secret");
      expect(
        await repositories.listOwnedAuditLogs({ tenantId, ownerId: "another-owner" as UserId, limit: 10 }),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function authenticatedRequest(token: string): Request {
  return new Request("https://local.test/v1/whoami", { headers: { authorization: `Bearer ${token}` } });
}

function seedOwner(db: ReturnType<typeof openSqliteDatabase>): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Auth test tenant', ?)").run(
    tenantId,
    "2026-10-30T00:00:00.000Z",
  );
  db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
    ownerId,
    ownerId,
    "2026-10-30T00:00:00.000Z",
  );
  db.query(`
    INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)
  `).run(tenantId, ownerId, "2026-10-30T00:00:00.000Z");
}
