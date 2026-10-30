import { describe, expect, test } from "bun:test";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import {
  ApiTokenAuthenticator,
  createApiTokenMaterial,
  hashApiToken,
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
      });
      expect(() => requireApiScope(principal, "factory:write")).not.toThrow();
      expect(() => requireApiScope(principal, "bots:write")).toThrow(
        expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
      );
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
