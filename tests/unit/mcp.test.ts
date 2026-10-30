import { describe, expect, test } from "bun:test";
import { McpManager, MCP_INVOKE_PERMISSION, exposedToolName } from "../../packages/core/src/mcp-manager.js";
import { AppError } from "../../packages/core/src/errors.js";
import { ApiTokenAuthenticator, createApiTokenMaterial } from "../../packages/core/src/api-auth.js";
import { createMcpApiHandler } from "../../packages/core/src/mcp-http-api.js";
import type { McpRepository, SecretStore } from "../../packages/core/src/ports.js";
import type {
  McpDiscoveredTool,
  McpServerConnection,
  TenantId,
  BotId,
  UserId,
  BotDefinition,
  TelegramDeploymentId,
} from "../../packages/core/src/types.js";

const tenantId = "tenant_test" as TenantId;
const botId = "bot_00000000-0000-4000-8000-000000000001" as BotId;
const ownerId = "user_test" as UserId;
type TestFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
const endpoint = "https://mcp.example.com/mcp";
const tool = {
  name: "lookup",
  description: "Look up one item.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string", minLength: 1, pattern: "^[a-z0-9-]+$" } },
    required: ["key"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
} as const;

describe("MCP manager", () => {
  test("rejects an unapproved endpoint before resolving its credential", async () => {
    const state = memoryRepository();
    let secretLookups = 0;
    const secrets: SecretStore = {
      resolve: async () => {
        secretLookups += 1;
        return "token";
      },
    };
    const manager = new McpManager({ repository: state.repository, secrets, allowedOrigins: new Set() });

    await expect(
      manager.addServer({
        id: "mcp_test",
        tenantId,
        botId,
        name: "Private service",
        endpoint,
        credentialRef: "secret_00000000000000000000000000000000",
        installedBy: ownerId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(secretLookups).toBe(0);
    expect(state.servers).toHaveLength(0);
  });

  test("discovers disabled tools, requires an explicit grant, validates and executes input", async () => {
    const state = memoryRepository();
    let telegramSenderGranted = false;
    const requests: { method: string; authorization: string | null }[] = [];
    const permissionDecisions: { outcome: string; permission: string }[] = [];
    const fetchMock: TestFetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({ method: request.method, authorization: request.headers.get("authorization") });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json()) as {
        id?: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test-server", version: "1" },
        };
      } else if (message.method === "tools/list") {
        result = { tools: [tool] };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: "value: found" }], structuredContent: { value: "found" } };
      } else {
        return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    };
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async () => "secret-token" },
      allowedOrigins: new Set(["https://mcp.example.com"]),
      telegramGrants: {
        isTelegramToolAllowed: async (input) =>
          telegramSenderGranted &&
          input.deploymentId === ("dep_123e4567-e89b-12d3-a456-426614174000" as TelegramDeploymentId) &&
          input.telegramUserId === 789 &&
          input.toolRef === "mcp:mcp_server_test:lookup",
      },
      authorizationAudit: {
        recordPermissionDecision: async (input) => {
          permissionDecisions.push({ outcome: input.outcome, permission: input.permission });
        },
      },
      fetch: fetchMock,
    });
    await manager.addServer({ id: "mcp_server_test", tenantId, botId, name: "Test", endpoint, installedBy: ownerId });
    const discovered = await manager.connect(tenantId, botId, "mcp_server_test");

    expect(discovered).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ enabled: false, grantedPermissions: [] });
    expect(await manager.available({ tenantId, botId, actorId: ownerId })).toHaveLength(0);
    await expect(
      manager.setToolPermission({
        tenantId,
        botId,
        serverId: "mcp_server_test",
        toolName: "lookup",
        enabled: true,
        grantedPermissions: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await manager.setToolPermission({
      tenantId,
      botId,
      serverId: "mcp_server_test",
      toolName: "lookup",
      enabled: true,
      grantedPermissions: [MCP_INVOKE_PERMISSION],
    });
    const available = await manager.available({ tenantId, botId, actorId: ownerId });
    const exposedName = exposedToolName("mcp_server_test", "lookup");
    expect(available.map(({ name }) => name)).toEqual([exposedName]);
    await expect(
      manager.execute({ tenantId, botId, actorId: ownerId }, exposedName, { extra: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      manager.execute({ tenantId, botId, actorId: ownerId }, exposedName, { key: "not valid" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      manager.execute({ tenantId, botId, actorId: ownerId }, exposedName, { key: "item-1" }),
    ).resolves.toEqual({ value: "found" });
    const telegramContext = {
      tenantId,
      botId,
      actorId: ownerId,
      platform: "telegram" as const,
      telegramDeploymentId: "dep_123e4567-e89b-12d3-a456-426614174000" as TelegramDeploymentId,
      telegramUserId: 789,
    };
    expect(await manager.available(telegramContext)).toEqual([]);
    await expect(manager.execute(telegramContext, exposedName, { key: "item-1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    telegramSenderGranted = true;
    expect(await manager.available(telegramContext)).toHaveLength(1);
    await expect(manager.execute(telegramContext, exposedName, { key: "item-1" })).resolves.toEqual({ value: "found" });
    expect(requests.every(({ authorization }) => authorization === null)).toBe(true);
    expect(permissionDecisions.some(({ outcome }) => outcome === "denied")).toBe(true);
    expect(permissionDecisions.some(({ outcome }) => outcome === "allowed")).toBe(true);
    expect(permissionDecisions.every(({ permission }) => permission === "mcp:mcp_server_test:lookup")).toBe(true);
  });

  test("uses a server bearer secret and marks protocol failures unhealthy", async () => {
    const state = memoryRepository();
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async () => "secret-token" },
      allowedOrigins: new Set(["https://mcp.example.com"]),
      fetch: async (_input: string | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
        return Response.redirect("https://outside.example/redirect", 302);
      },
    });
    await manager.addServer({
      id: "mcp_redirect",
      tenantId,
      botId,
      name: "Redirecting service",
      endpoint,
      credentialRef: "secret_00000000000000000000000000000000",
      installedBy: ownerId,
    });
    await expect(manager.connect(tenantId, botId, "mcp_redirect")).rejects.toBeInstanceOf(AppError);
    expect(state.servers[0]?.status).toBe("unhealthy");
  });

  test("bounds MCP connection time and records the server as unhealthy", async () => {
    const state = memoryRepository();
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async () => "unused" },
      allowedOrigins: new Set(["https://mcp.example.com"]),
      timeoutMs: 100,
      fetch: async () => new Promise<Response>(() => {}),
    });
    await manager.addServer({ id: "mcp_slow", tenantId, botId, name: "Slow", endpoint, installedBy: ownerId });

    await expect(manager.connect(tenantId, botId, "mcp_slow")).rejects.toMatchObject({ status: 504 });
    expect(state.servers[0]?.status).toBe("unhealthy");
  });

  test("manages MCP servers and tool grants through the owner-scoped API", async () => {
    const state = memoryRepository();
    const token = await createApiTokenMaterial();
    const principal = { tenantId, ownerId, tokenId: "token_test", scopes: ["bots:read", "bots:write"] };
    const bot: BotDefinition = {
      id: botId,
      tenantId,
      ownerId,
      name: "MCP API bot",
      description: "Test",
      systemPrompt: "Help.",
      model: { providerId: "mock", model: "mock" },
      visibility: "private",
      status: "draft",
      version: 1,
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
    };
    const fetchMock: TestFetch = async (input, init) => {
      const request = new Request(input, init);
      const message = (await request.json()) as {
        id?: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            }
          : { tools: [tool] };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    };
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async () => "secret-token" },
      allowedOrigins: new Set(["https://mcp.example.com"]),
      fetch: fetchMock,
    });
    const handler = createMcpApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => principal,
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      }),
      { get: async () => bot, saveDraft: async () => {} },
      manager,
    );
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const collection = `https://factory.example.test/v1/bots/${botId}/mcp-servers`;
    const rawCredential = await handler(
      new Request(collection, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Example", endpoint, token: "plaintext" }),
      }),
    );
    expect(rawCredential?.status).toBe(400);
    const createResponse = await handler(
      new Request(collection, { method: "POST", headers, body: JSON.stringify({ name: "Example", endpoint }) }),
    );
    expect(createResponse?.status).toBe(201);
    const created = (await createResponse?.json()) as {
      server: { id: string; status: string; credentialRef?: string };
    };
    expect(created.server).toMatchObject({ status: "disconnected" });
    expect(created.server).not.toHaveProperty("credentialRef");

    const connect = await handler(
      new Request(`${collection}/${created.server.id}/connect`, { method: "POST", headers }),
    );
    expect(connect?.status).toBe(200);
    expect(state.tools[0]).toMatchObject({ enabled: false, grantedPermissions: [] });
    const patch = await handler(
      new Request(`${collection}/${created.server.id}/tools/lookup`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: true, grantedPermissions: [MCP_INVOKE_PERMISSION] }),
      }),
    );
    expect(patch?.status).toBe(200);
    const list = await handler(new Request(collection, { headers: { authorization: `Bearer ${token.token}` } }));
    expect(await list?.json()).toMatchObject([{ id: created.server.id, status: "connected", hasCredential: false }]);
  });
});

function memoryRepository() {
  const servers: McpServerConnection[] = [];
  const tools: McpDiscoveredTool[] = [];
  const repository: McpRepository = {
    listServers: async (tenant, bot) => servers.filter((server) => server.tenantId === tenant && server.botId === bot),
    getServer: async (tenant, bot, id) =>
      servers.find((server) => server.tenantId === tenant && server.botId === bot && server.id === id),
    createServer: async (input) => {
      servers.push({
        id: input.id,
        tenantId: input.tenantId,
        botId: input.botId,
        name: input.name,
        endpoint: input.endpoint,
        ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
        status: "disconnected",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    },
    setServerStatus: async (input) => {
      const index = servers.findIndex(
        (server) => server.id === input.serverId && server.tenantId === input.tenantId && server.botId === input.botId,
      );
      const server = servers[index];
      if (server) servers[index] = { ...server, status: input.status, updatedAt: new Date().toISOString() };
    },
    deleteServer: async (input) => {
      const index = servers.findIndex(
        (server) => server.id === input.serverId && server.tenantId === input.tenantId && server.botId === input.botId,
      );
      if (index >= 0) servers.splice(index, 1);
    },
    listTools: async (tenant, bot, serverId) =>
      tools.filter((toolEntry) => {
        const server = servers.find((entry) => entry.id === toolEntry.serverId);
        return (
          server?.tenantId === tenant &&
          server.botId === bot &&
          (serverId === undefined || toolEntry.serverId === serverId)
        );
      }),
    getTool: async (tenant, bot, serverId, name) =>
      tools.find((entry) => {
        const server = servers.find((candidate) => candidate.id === entry.serverId);
        return (
          server?.tenantId === tenant && server.botId === bot && entry.serverId === serverId && entry.name === name
        );
      }),
    replaceDiscoveredTools: async (input) => {
      for (let index = tools.length - 1; index >= 0; index -= 1)
        if (tools[index]?.serverId === input.serverId) tools.splice(index, 1);
      for (const discovered of input.tools) {
        tools.push({
          ...discovered,
          serverId: input.serverId,
          enabled: false,
          grantedPermissions: [],
          lastSeenAt: input.discoveredAt,
        });
      }
    },
    setToolPermission: async (input) => {
      const index = tools.findIndex((entry) => entry.serverId === input.serverId && entry.name === input.toolName);
      const toolEntry = tools[index];
      if (toolEntry)
        tools[index] = { ...toolEntry, enabled: input.enabled, grantedPermissions: input.grantedPermissions };
    },
  };
  return { repository, servers, tools };
}
