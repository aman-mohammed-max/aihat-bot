import { describe, expect, test } from "bun:test";
import { ApiTokenAuthenticator, createApiTokenMaterial, hashApiToken } from "../../packages/core/src/api-auth.js";
import { createWorkspacesApiHandler } from "../../packages/core/src/workspaces-http-api.js";
import type { ApiTokenRecord, TenantMembershipRepository } from "../../packages/core/src/ports.js";
import type { TenantId, UserId } from "../../packages/core/src/types.js";

const homeTenantId = "tenant-home" as TenantId;
const teamTenantId = "tenant-team" as TenantId;
const userId = "user-workspace" as UserId;
const now = new Date("2026-10-30T12:00:00.000Z");
const rawScopes = [
  "factory:read",
  "factory:write",
  "bots:read",
  "bots:write",
  "skills:publish",
  "agent:run",
  "tokens:manage",
  "members:manage",
];

describe("workspace HTTP API", () => {
  test("lists the caller's active workspaces without caching", async () => {
    const material = await createApiTokenMaterial();
    const memberships = createMemberships({
      listWorkspacesForUser: async (requestedUserId) => {
        expect(requestedUserId).toBe(userId);
        return [
          { tenantId: homeTenantId, name: "Personal", role: "owner", createdAt: now.toISOString() },
          { tenantId: teamTenantId, name: "Team", role: "member", createdAt: now.toISOString() },
        ];
      },
    });
    const handler = createWorkspacesApiHandler(createAuthenticator(material.token), createTokens(), memberships);

    const response = await handler(
      new Request("https://factory.test/v1/workspaces", { headers: authHeaders(material.token) }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({
      items: [
        { tenantId: homeTenantId, name: "Personal", role: "owner", createdAt: now.toISOString() },
        { tenantId: teamTenantId, name: "Team", role: "member", createdAt: now.toISOString() },
      ],
    });
  });

  test("switches only to an active membership and keeps role-limited scopes and source expiry", async () => {
    const material = await createApiTokenMaterial();
    const expiresAt = "2026-10-30T12:30:00.000Z";
    const created: ApiTokenRecord[] = [];
    const tokens = createTokens(created);
    const memberships = createMemberships({
      getActiveRole: async ({ tenantId: requestedTenant, userId: requestedUser }) => {
        expect(requestedTenant).toBe(teamTenantId);
        expect(requestedUser).toBe(userId);
        return "member";
      },
    });
    const handler = createWorkspacesApiHandler(
      createAuthenticator(material.token, { expiresAt }),
      tokens,
      memberships,
      () => now,
    );

    const response = await handler(
      new Request("https://factory.test/v1/workspaces/switch", {
        method: "POST",
        headers: authHeaders(material.token),
        body: JSON.stringify({ tenantId: teamTenantId }),
      }),
    );
    const body = (await response?.json()) as {
      tenantId: string;
      role: string;
      tokenId: string;
      token: string;
      scopes: string[];
      expiresAt: string;
    };

    expect(response?.status).toBe(201);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      tenantId: teamTenantId,
      role: "member",
      scopes: ["factory:read", "factory:write", "bots:read", "bots:write", "agent:run", "tokens:manage"],
      expiresAt,
    });
    expect(body.token).toMatch(/^ahf_live_[A-Za-z0-9_-]{43}$/);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tenantId: teamTenantId,
      ownerId: userId,
      scopes: rawScopes,
      expiresAt,
    });
    expect(created[0]).not.toHaveProperty("token");
    expect(created[0]?.tokenHash).not.toBe(body.token);
  });

  test("rejects inactive, current, and malformed workspace switches without creating tokens", async () => {
    const material = await createApiTokenMaterial();
    const created: ApiTokenRecord[] = [];
    const tokens = createTokens(created);
    const inactiveMemberships = createMemberships({ getActiveRole: async () => undefined });
    const handler = createWorkspacesApiHandler(
      createAuthenticator(material.token),
      tokens,
      inactiveMemberships,
      () => now,
    );
    const request = (body: string) =>
      new Request("https://factory.test/v1/workspaces/switch", {
        method: "POST",
        headers: authHeaders(material.token),
        body,
      });

    expect((await handler(request(JSON.stringify({ tenantId: teamTenantId }))))?.status).toBe(404);
    expect((await handler(request(JSON.stringify({ tenantId: homeTenantId }))))?.status).toBe(409);
    expect((await handler(request(JSON.stringify({ tenantId: teamTenantId, role: "owner" }))))?.status).toBe(400);
    expect((await handler(request("{")))?.status).toBe(400);
    expect(created).toHaveLength(0);
  });
});

function createAuthenticator(token: string, options: { readonly expiresAt?: string } = {}): ApiTokenAuthenticator {
  return new ApiTokenAuthenticator({
    findActive: async (tokenHash) => {
      expect(tokenHash).toBe(await hashApiToken(token));
      return {
        tokenId: "token-source",
        tenantId: homeTenantId,
        ownerId: userId,
        scopes: rawScopes,
        tenantRole: "owner",
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      };
    },
    create: async () => {},
    revoke: async () => {},
    consumeApiRequest: async () => true,
    recordApiMutation: async () => {},
  });
}

function createTokens(created: ApiTokenRecord[] = []) {
  return {
    findActive: async () => undefined,
    create: async (record: ApiTokenRecord) => {
      created.push(record);
    },
    revoke: async () => {},
    consumeApiRequest: async () => true,
    recordApiMutation: async () => {},
  };
}

function createMemberships(overrides: Partial<TenantMembershipRepository> = {}): TenantMembershipRepository {
  return {
    listMembers: async () => [],
    addMember: async () => {
      throw new Error("not used");
    },
    changeMemberRole: async () => {
      throw new Error("not used");
    },
    deactivateMember: async () => {
      throw new Error("not used");
    },
    listWorkspacesForUser: async () => [],
    getActiveRole: async () => undefined,
    ...overrides,
  };
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}
