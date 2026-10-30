import { describe, expect, test } from "bun:test";
import { ApiTokenAuthenticator, createApiTokenMaterial } from "../../packages/core/src/api-auth.js";
import { createTenantMembersApiHandler } from "../../packages/core/src/tenant-members-http-api.js";
import type { TenantMembershipRepository } from "../../packages/core/src/ports.js";
import type { TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-team" as TenantId;
const ownerId = "user-owner" as UserId;
const memberId = "user-member" as UserId;

describe("tenant member HTTP API", () => {
  test("requires the dedicated scope and delegates bounded, tenant-scoped member operations", async () => {
    const material = await createApiTokenMaterial();
    const calls: unknown[] = [];
    const members: TenantMembershipRepository = {
      listMembers: async (input) => {
        calls.push({ operation: "list", input });
        return [
          { userId: ownerId, role: "owner", status: "active", createdAt: "2026-10-30T00:00:00.000Z", ownedBotCount: 1 },
        ];
      },
      addMember: async (input) => {
        calls.push({ operation: "add", input });
        return { userId: input.memberId, role: input.role, status: "active", createdAt: input.now, ownedBotCount: 0 };
      },
      changeMemberRole: async (input) => {
        calls.push({ operation: "role", input });
        return { userId: input.memberId, role: input.role, status: "active", createdAt: input.now, ownedBotCount: 0 };
      },
      deactivateMember: async (input) => {
        calls.push({ operation: "deactivate", input });
        return { userId: input.memberId, role: "member", status: "inactive", createdAt: input.now, ownedBotCount: 0 };
      },
      listWorkspacesForUser: async () => [],
      getActiveRole: async () => undefined,
    };
    const authenticator = new ApiTokenAuthenticator({
      findActive: async () => ({ tenantId, ownerId, tokenId: "token-owner", scopes: ["members:manage"] }),
      create: async () => {},
      revoke: async () => {},
      consumeApiRequest: async () => true,
      recordApiMutation: async () => {},
    });
    const handler = createTenantMembersApiHandler(authenticator, members, () => new Date("2026-10-30T12:00:00.000Z"));
    const headers = { authorization: `Bearer ${material.token}`, "content-type": "application/json" };

    const listed = await handler(new Request("https://factory.test/v1/members", { headers }));
    expect(listed?.status).toBe(200);
    expect(listed?.headers.get("cache-control")).toBe("no-store");
    expect(await listed?.json()).toMatchObject({ items: [{ userId: ownerId, role: "owner" }] });

    const added = await handler(
      new Request("https://factory.test/v1/members", {
        method: "POST",
        headers,
        body: JSON.stringify({ userId: memberId, role: "member" }),
      }),
    );
    expect(added?.status).toBe(201);
    expect(await added?.json()).toMatchObject({ item: { userId: memberId, role: "member" } });

    const roleChanged = await handler(
      new Request(`https://factory.test/v1/members/${memberId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ role: "admin" }),
      }),
    );
    expect(roleChanged?.status).toBe(200);

    const deactivated = await handler(
      new Request(`https://factory.test/v1/members/${memberId}`, { method: "DELETE", headers }),
    );
    expect(await deactivated?.json()).toMatchObject({ item: { status: "inactive" } });
    expect(calls.map((call) => (call as { operation: string }).operation)).toEqual([
      "list",
      "add",
      "role",
      "deactivate",
    ]);
  });

  test("rejects missing scope, owner assignment during add, and malformed user IDs", async () => {
    const material = await createApiTokenMaterial();
    const members: TenantMembershipRepository = {
      listMembers: async () => [],
      addMember: async () => {
        throw new Error("must not be called");
      },
      changeMemberRole: async () => {
        throw new Error("must not be called");
      },
      deactivateMember: async () => {
        throw new Error("must not be called");
      },
      listWorkspacesForUser: async () => [],
      getActiveRole: async () => undefined,
    };
    const makeAuthenticator = (scopes: readonly string[]) =>
      new ApiTokenAuthenticator({
        findActive: async () => ({ tenantId, ownerId, tokenId: "token-test", scopes }),
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      });
    const request = (body: string) =>
      new Request("https://factory.test/v1/members", {
        method: "POST",
        headers: { authorization: `Bearer ${material.token}`, "content-type": "application/json" },
        body,
      });

    const noScope = await createTenantMembersApiHandler(makeAuthenticator(["tokens:manage"]), members)(request("{}"));
    expect(noScope?.status).toBe(403);
    const ownerRole = await createTenantMembersApiHandler(
      makeAuthenticator(["members:manage"]),
      members,
    )(request(JSON.stringify({ userId: memberId, role: "owner" })));
    expect(ownerRole?.status).toBe(400);
    const invalidId = await createTenantMembersApiHandler(
      makeAuthenticator(["members:manage"]),
      members,
    )(request(JSON.stringify({ userId: "../../tenant-other", role: "member" })));
    expect(invalidId?.status).toBe(400);
  });
});
