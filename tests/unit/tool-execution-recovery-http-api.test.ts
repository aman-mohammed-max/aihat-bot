import { describe, expect, test } from "bun:test";
import type { ApiTokenAuthenticator } from "../../packages/core/src/api-auth.js";
import { createToolExecutionRecoveryApiHandler } from "../../packages/core/src/tool-execution-recovery-http-api.js";
import type { ToolExecutionRepository } from "../../packages/core/src/ports.js";
import type { BotId, TenantId, ToolExecutionRecovery, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-recovery" as TenantId;
const ownerId = "user-recovery" as UserId;
const botId = "bot_00000000-0000-4000-8000-000000000001" as BotId;
const executionKey = "a".repeat(64);

describe("tool execution recovery API", () => {
  test("lists only recovery metadata and resolves an owner-approved action", async () => {
    const recovery: ToolExecutionRecovery = {
      botId,
      executionKey,
      toolName: "send_message",
      status: "ambiguous",
      ambiguousAt: "2026-10-30T12:00:00.000Z",
      updatedAt: "2026-10-30T12:00:00.000Z",
    };
    const listed: unknown[] = [];
    const resolved: unknown[] = [];
    const handler = createHandler({
      listOwnedRecoveries: async (input) => {
        listed.push(input);
        return [recovery];
      },
      resolveOwnedRecovery: async (input) => {
        resolved.push(input);
        return input.resolution === "retry" ? "retry_approved" : "closed";
      },
    });

    const list = await handler(new Request(`https://factory.test/v1/bots/${botId}/tool-executions`));
    expect(list?.status).toBe(200);
    expect(await list?.json()).toEqual({ recoveries: [recovery] });
    expect(list?.headers.get("cache-control")).toBe("no-store");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tenantId, ownerId, botId, limit: 100 });

    const approve = await handler(
      new Request(`https://factory.test/v1/bots/${botId}/tool-executions/${executionKey}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "retry" }),
      }),
    );
    expect(approve?.status).toBe(200);
    expect(await approve?.json()).toEqual({ status: "retry_approved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ tenantId, ownerId, botId, executionKey, resolution: "retry" });
    expect(await handler(new Request("https://factory.test/v1/health"))).toBeUndefined();
  });

  test("validates resolution bodies and enforces read/write scopes", async () => {
    const calls: string[] = [];
    const handler = createHandler(
      {
        listOwnedRecoveries: async () => {
          calls.push("list");
          return [];
        },
        resolveOwnedRecovery: async () => {
          calls.push("resolve");
          return "closed";
        },
      },
      [],
    );
    const collection = `https://factory.test/v1/bots/${botId}/tool-executions`;
    const resolveUrl = `${collection}/${executionKey}/resolve`;
    const noRead = await handler(new Request(collection));
    expect(noRead?.status).toBe(403);
    const noWrite = await handler(
      new Request(resolveUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "close" }),
      }),
    );
    expect(noWrite?.status).toBe(403);

    const invalid = await createHandler({
      listOwnedRecoveries: async () => [],
      resolveOwnedRecovery: async () => {
        calls.push("invalid-resolve");
        return "closed";
      },
    })(
      new Request(resolveUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "retry", extra: true }),
      }),
    );
    expect(invalid?.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

function createHandler(
  methods: Pick<ToolExecutionRepository, "listOwnedRecoveries" | "resolveOwnedRecovery">,
  scopes: readonly string[] = ["bots:read", "bots:write"],
) {
  const authenticator = {
    authenticate: async () => ({ tenantId, ownerId, tokenId: "recovery-token", scopes: [...scopes] }),
  } as unknown as ApiTokenAuthenticator;
  return createToolExecutionRecoveryApiHandler(authenticator, methods as ToolExecutionRepository);
}
