import { describe, expect, test } from "bun:test";
import { ApiTokenAuthenticator, createApiTokenMaterial } from "../../packages/core/src/api-auth.js";
import { createAuditLogApiHandler } from "../../packages/core/src/audit-http-api.js";
import type { AuditLogRepository } from "../../packages/core/src/ports.js";
import type { TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-audit" as TenantId;
const ownerId = "user-audit" as UserId;

describe("owner audit-log API", () => {
  test("returns a bounded, owner-scoped event page without caching", async () => {
    const material = await createApiTokenMaterial();
    let requested: unknown;
    const logs: AuditLogRepository = {
      recordPermissionDecision: async () => {},
      listOwnedAuditLogs: async (input) => {
        requested = input;
        return [
          {
            id: "audit_test",
            action: "api.mutation_attempt",
            resourceType: "http_api",
            resourceId: "PATCH /v1/bots/bot_test",
            metadata: { tokenId: "token-test", method: "PATCH", path: "/v1/bots/bot_test" },
            createdAt: "2026-10-30T12:00:00.000Z",
          },
        ];
      },
    };
    const handler = createAuditLogApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => ({ tenantId, ownerId, tokenId: "token-test", scopes: ["bots:read"] }),
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      }),
      logs,
    );
    const response = await handler(
      new Request("https://factory.test/v1/audit-logs?limit=25", {
        headers: { authorization: `Bearer ${material.token}` },
      }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toMatchObject({ items: [{ action: "api.mutation_attempt" }] });
    expect(requested).toEqual({ tenantId, ownerId, limit: 25 });

    const invalidLimit = await handler(
      new Request("https://factory.test/v1/audit-logs?limit=101", {
        headers: { authorization: `Bearer ${material.token}` },
      }),
    );
    expect(invalidLimit?.status).toBe(400);
  });
});
