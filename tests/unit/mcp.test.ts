import { describe, expect, test } from "bun:test";
import { McpManager, MCP_INVOKE_PERMISSION, exposedToolName } from "../../packages/core/src/mcp-manager.js";
import { AppError } from "../../packages/core/src/errors.js";
import { ApiTokenAuthenticator, createApiTokenMaterial } from "../../packages/core/src/api-auth.js";
import { createMcpApiHandler } from "../../packages/core/src/mcp-http-api.js";
import { decodeMcpOAuthAuthorizationState, MCP_OAUTH_CODE_SECRET_PREFIX } from "../../packages/core/src/mcp-oauth.js";
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

  test("reconnects an unhealthy server after its persisted retry delay", async () => {
    const state = memoryRepository();
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    let shouldConnect = false;
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async () => "unused" },
      allowedOrigins: new Set(["https://mcp.example.com"]),
      now: () => now,
      fetch: async (input, init) => {
        if (!shouldConnect) throw new Error("MCP unavailable");
        const request = input instanceof Request ? input : new Request(input, init);
        const message = (await request.json()) as {
          id?: string | number;
          method: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "test-server", version: "1" },
              }
            : { tools: [tool] };
        return Response.json({ jsonrpc: "2.0", id: message.id, result });
      },
    });
    await manager.addServer({ id: "mcp_reconnect", tenantId, botId, name: "Test", endpoint, installedBy: ownerId });
    await expect(manager.connect(tenantId, botId, "mcp_reconnect")).rejects.toMatchObject({ status: 502 });
    expect(state.servers[0]).toMatchObject({ status: "unhealthy", reconnectAttempts: 0 });

    expect(await manager.available({ tenantId, botId, actorId: ownerId })).toEqual([]);
    expect(state.servers[0]?.reconnectAttempts).toBe(0);
    now += 15_001;
    shouldConnect = true;

    expect(await manager.available({ tenantId, botId, actorId: ownerId })).toEqual([]);
    expect(state.servers[0]).toMatchObject({ status: "connected", reconnectAttempts: 0 });
    expect(state.tools).toHaveLength(1);
  });

  test("stores MCP OAuth client credentials behind the secret writer and allowlists the issuer", async () => {
    const state = memoryRepository();
    const stored: string[] = [];
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async () => "unused" },
      secretWriter: {
        put: async (_tenant, value) => {
          stored.push(value);
          return "secret_00000000000000000000000000000001";
        },
        delete: async () => {},
      },
      allowedOrigins: new Set(["https://mcp.example.com", "https://auth.example.com"]),
    });
    await manager.addServer({
      id: "mcp_oauth",
      tenantId,
      botId,
      name: "OAuth server",
      endpoint,
      authentication: {
        mode: "oauth_client_credentials",
        clientId: "bot-factory",
        clientSecret: "oauth-client-secret",
        issuer: "https://auth.example.com",
        scope: "tools:read tools:run",
      },
      installedBy: ownerId,
    });
    expect(state.servers[0]).toMatchObject({
      id: "mcp_oauth",
      credentialRef: "secret_00000000000000000000000000000001",
    });
    expect(stored[0]).toContain("aihat:mcp:oauth-client-credentials:v1:");

    const rejected = new McpManager({
      repository: state.repository,
      secrets: { resolve: async () => "unused" },
      secretWriter: {
        put: async () => {
          throw new Error("must not store rejected credentials");
        },
        delete: async () => {},
      },
      allowedOrigins: new Set(["https://mcp.example.com"]),
    });
    await expect(
      rejected.addServer({
        id: "mcp_bad_oauth",
        tenantId,
        botId,
        name: "Unapproved issuer",
        endpoint,
        authentication: {
          mode: "oauth_client_credentials",
          clientId: "bot-factory",
          clientSecret: "oauth-client-secret",
          issuer: "https://auth.example.com",
        },
        installedBy: ownerId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.servers).toHaveLength(1);
  });

  test("uses OAuth client credentials for an allowlisted MCP authorization server", async () => {
    const state = memoryRepository();
    let storedSecret = "";
    let tokenRequests = 0;
    let authenticatedMcpRequests = 0;
    const fetchMock: TestFetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://auth.example.com" && url.pathname.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
          grant_types_supported: ["client_credentials"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      if (url.origin === "https://auth.example.com" && url.pathname === "/token") {
        tokenRequests += 1;
        const form = new URLSearchParams(await request.text());
        expect(form.get("grant_type")).toBe("client_credentials");
        expect(request.headers.get("authorization")).toBeTruthy();
        return Response.json({ access_token: "mcp-access-token", token_type: "Bearer", expires_in: 300 });
      }
      if (url.origin === "https://mcp.example.com" && url.pathname.includes("oauth-protected-resource")) {
        return Response.json({
          resource: endpoint,
          authorization_servers: ["https://auth.example.com"],
          bearer_methods_supported: ["header"],
        });
      }
      if (url.origin === "https://mcp.example.com" && url.pathname === "/mcp") {
        if (request.headers.get("authorization") !== "Bearer mcp-access-token") {
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        authenticatedMcpRequests += 1;
        const message = (await request.json()) as {
          id?: string | number;
          method: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "OAuth MCP", version: "1" },
              }
            : { tools: [tool] };
        return Response.json({ jsonrpc: "2.0", id: message.id, result });
      }
      throw new Error(`Unexpected request origin or route: ${url.origin}${url.pathname}`);
    };
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async () => storedSecret },
      secretWriter: {
        put: async (_tenant, value) => {
          storedSecret = value;
          return "secret_00000000000000000000000000000003";
        },
        delete: async () => {},
      },
      allowedOrigins: new Set(["https://mcp.example.com", "https://auth.example.com"]),
      fetch: fetchMock,
    });
    await manager.addServer({
      id: "mcp_oauth_discovery",
      tenantId,
      botId,
      name: "OAuth discovery test",
      endpoint,
      authentication: {
        mode: "oauth_client_credentials",
        clientId: "bot-factory",
        clientSecret: "oauth-client-secret",
        issuer: "https://auth.example.com",
      },
      installedBy: ownerId,
    });

    const tools = await manager.connect(tenantId, botId, "mcp_oauth_discovery");
    expect(tools).toHaveLength(1);
    expect(tokenRequests).toBe(1);
    expect(authenticatedMcpRequests).toBeGreaterThan(0);
  });

  test("persists the PKCE authorization flow, validates callbacks once, and saves refreshed tokens", async () => {
    const state = memoryRepository();
    const secrets = new Map<string, string>();
    let secretSequence = 10;
    let authorizationCodeExchanges = 0;
    let refreshTokenExchanges = 0;
    let authenticatedMcpRequests = 0;
    const fetchMock: TestFetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://mcp.example.com" && url.pathname.includes("oauth-protected-resource")) {
        return Response.json({ resource: endpoint, authorization_servers: ["https://auth.example.com"] });
      }
      if (url.origin === "https://auth.example.com" && url.pathname.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.origin === "https://auth.example.com" && url.pathname === "/token") {
        const form = new URLSearchParams(await request.text());
        expect(request.headers.get("authorization")).toBeNull();
        if (form.get("grant_type") === "authorization_code") {
          authorizationCodeExchanges += 1;
          expect(form.get("code")).toBe("authorization-code");
          expect(form.get("code_verifier")).toBeTruthy();
          expect(form.get("redirect_uri")).toBe("https://dashboard.example.test/miniapp/");
          expect(form.get("client_id")).toBe("registered-public-client");
          return Response.json({
            access_token: "short-lived-access-token",
            token_type: "Bearer",
            expires_in: 0,
            refresh_token: "initial-refresh-token",
          });
        }
        if (form.get("grant_type") === "refresh_token") {
          refreshTokenExchanges += 1;
          expect(form.get("refresh_token")).toBe("initial-refresh-token");
          return Response.json({
            access_token: "refreshed-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rotated-refresh-token",
          });
        }
        throw new Error("Unexpected OAuth grant type");
      }
      if (url.origin === "https://mcp.example.com" && url.pathname === "/mcp") {
        if (request.headers.get("authorization") !== "Bearer refreshed-access-token") {
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        authenticatedMcpRequests += 1;
        const message = (await request.json()) as {
          id?: string | number;
          method: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "OAuth MCP", version: "1" },
              }
            : { tools: [tool] };
        return Response.json({ jsonrpc: "2.0", id: message.id, result });
      }
      throw new Error(`Unexpected request origin or route: ${url.origin}${url.pathname}`);
    };
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async (_tenant, reference) => secrets.get(reference) ?? "" },
      secretWriter: {
        put: async (_tenant, value) => {
          const reference = `secret_${(secretSequence++).toString(16).padStart(32, "0")}`;
          secrets.set(reference, value);
          return reference;
        },
        delete: async (_tenant, reference) => {
          secrets.delete(reference);
        },
      },
      allowedOrigins: new Set(["https://mcp.example.com", "https://auth.example.com"]),
      fetch: fetchMock,
    });
    await manager.addServer({
      id: "mcp_oauth_code",
      tenantId,
      botId,
      name: "User consent server",
      endpoint,
      redirectUri: "https://dashboard.example.test/miniapp/",
      authentication: {
        mode: "oauth_authorization_code",
        clientId: "registered-public-client",
        issuer: "https://auth.example.com",
        scope: "tools:read",
      },
      installedBy: ownerId,
    });

    const started = await manager.beginOAuthAuthorization(tenantId, botId, "mcp_oauth_code");
    expect(started.connected).toBe(false);
    expect(started.authorizationUrl).toBeTruthy();
    const authUrl = new URL(started.authorizationUrl as string);
    expect(authUrl.origin).toBe("https://auth.example.com");
    expect(authUrl.searchParams.get("client_id")).toBe("registered-public-client");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://dashboard.example.test/miniapp/");
    const server = state.servers[0];
    expect(server?.credentialRef).toBeTruthy();
    const storedFlow = decodeMcpOAuthAuthorizationState(secrets.get(server?.credentialRef ?? "") ?? "");
    expect(storedFlow).toMatchObject({ state: authUrl.searchParams.get("state"), codeVerifier: expect.any(String) });
    expect(storedFlow?.authorizationUrl).toBe(authUrl.href);

    await expect(
      manager.completeOAuthAuthorization({
        tenantId,
        botId,
        serverId: "mcp_oauth_code",
        code: "authorization-code",
        state: "wrong-state",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      manager.completeOAuthAuthorization({
        tenantId,
        botId,
        serverId: "mcp_oauth_code",
        code: "authorization-code",
        state: storedFlow?.state ?? "",
        issuer: "https://attacker.example.test",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const tools = await manager.completeOAuthAuthorization({
      tenantId,
      botId,
      serverId: "mcp_oauth_code",
      code: "authorization-code",
      state: storedFlow?.state ?? "",
      issuer: "https://auth.example.com",
    });
    expect(tools).toHaveLength(1);
    expect(state.servers[0]?.status).toBe("connected");
    expect(state.tools[0]).toMatchObject({ enabled: false, grantedPermissions: [] });
    expect(authorizationCodeExchanges).toBe(1);
    expect(refreshTokenExchanges).toBe(1);
    expect(authenticatedMcpRequests).toBeGreaterThan(0);
    const storedTokens = decodeMcpOAuthAuthorizationState(secrets.get(state.servers[0]?.credentialRef ?? "") ?? "");
    expect(storedTokens?.tokens).toMatchObject({
      access_token: "refreshed-access-token",
      refresh_token: "rotated-refresh-token",
    });
    expect(storedTokens?.state).toBeUndefined();
    expect(storedTokens?.codeVerifier).toBeUndefined();
    expect(storedTokens?.authorizationUrl).toBeUndefined();
    await expect(
      manager.completeOAuthAuthorization({
        tenantId,
        botId,
        serverId: "mcp_oauth_code",
        code: "authorization-code",
        state: storedFlow?.state ?? "",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("blocks OAuth authorization-code token exchange to metadata outside the origin allowlist", async () => {
    const state = memoryRepository();
    const secrets = new Map<string, string>();
    let nextSecret = 40;
    let outsideRequests = 0;
    const fetchMock: TestFetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://mcp.example.com" && url.pathname.includes("oauth-protected-resource")) {
        return Response.json({ resource: endpoint, authorization_servers: ["https://auth.example.com"] });
      }
      if (url.origin === "https://auth.example.com" && url.pathname.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://outside.example/token",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.origin === "https://mcp.example.com" && url.pathname === "/mcp") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      if (url.origin === "https://outside.example") outsideRequests += 1;
      throw new Error("Unexpected network request.");
    };
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async (_tenant, reference) => secrets.get(reference) ?? "" },
      secretWriter: {
        put: async (_tenant, value) => {
          const reference = `secret_${(nextSecret++).toString(16).padStart(32, "0")}`;
          secrets.set(reference, value);
          return reference;
        },
        delete: async (_tenant, reference) => {
          secrets.delete(reference);
        },
      },
      allowedOrigins: new Set(["https://mcp.example.com", "https://auth.example.com"]),
      fetch: fetchMock,
    });
    await manager.addServer({
      id: "mcp_oauth_egress_code",
      tenantId,
      botId,
      name: "Untrusted token endpoint",
      endpoint,
      redirectUri: "https://dashboard.example.test/miniapp/",
      authentication: {
        mode: "oauth_authorization_code",
        clientId: "registered-client",
        issuer: "https://auth.example.com",
      },
      installedBy: ownerId,
    });
    const started = await manager.beginOAuthAuthorization(tenantId, botId, "mcp_oauth_egress_code");
    const server = state.servers[0];
    const stored = decodeMcpOAuthAuthorizationState(secrets.get(server?.credentialRef ?? "") ?? "");
    expect(started.authorizationUrl).toBeTruthy();
    expect(stored?.state).toBeTruthy();
    await expect(
      manager.completeOAuthAuthorization({
        tenantId,
        botId,
        serverId: "mcp_oauth_egress_code",
        code: "authorization-code",
        state: stored?.state ?? "",
        issuer: "https://auth.example.com",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(outsideRequests).toBe(0);
  });

  test("rejects expired authorization-code callback state before contacting the OAuth server", async () => {
    const state = memoryRepository();
    const secrets = new Map<string, string>();
    let nextRef = "secret_00000000000000000000000000000020";
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async (_tenant, reference) => secrets.get(reference) ?? "" },
      secretWriter: {
        put: async (_tenant, value) => {
          secrets.set(nextRef, value);
          return nextRef;
        },
        delete: async (_tenant, reference) => {
          secrets.delete(reference);
        },
      },
      allowedOrigins: new Set(["https://mcp.example.com", "https://auth.example.com"]),
      fetch: async () => {
        throw new Error("Expired callback must not make a network request.");
      },
    });
    await manager.addServer({
      id: "mcp_oauth_expired",
      tenantId,
      botId,
      name: "Expired server",
      endpoint,
      redirectUri: "https://dashboard.example.test/miniapp/",
      authentication: {
        mode: "oauth_authorization_code",
        clientId: "registered-client",
        issuer: "https://auth.example.com",
      },
      installedBy: ownerId,
    });
    const server = state.servers[0];
    expect(server?.credentialRef).toBeTruthy();
    const stored = JSON.parse(
      secrets.get(server?.credentialRef ?? "")?.slice(MCP_OAUTH_CODE_SECRET_PREFIX.length) ?? "{}",
    ) as Record<string, unknown>;
    stored.state = "expired-state";
    stored.codeVerifier = "saved-verifier";
    stored.flowExpiresAt = new Date(Date.now() - 1000).toISOString();
    stored.authorizationUrl = "https://auth.example.com/authorize?state=expired-state";
    secrets.set(server?.credentialRef ?? "", `${MCP_OAUTH_CODE_SECRET_PREFIX}${JSON.stringify(stored)}`);
    nextRef = "secret_00000000000000000000000000000021";

    await expect(
      manager.completeOAuthAuthorization({
        tenantId,
        botId,
        serverId: "mcp_oauth_expired",
        code: "authorization-code",
        state: "expired-state",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("binds OAuth setup and callbacks to the owner dashboard origin and redacts credentials", async () => {
    const state = memoryRepository();
    const secrets = new Map<string, string>();
    const token = await createApiTokenMaterial();
    const principal = { tenantId, ownerId, tokenId: "mcp-oauth-api-token", scopes: ["bots:read", "bots:write"] };
    const bot: BotDefinition = {
      id: botId,
      tenantId,
      ownerId,
      name: "OAuth API bot",
      description: "Test",
      systemPrompt: "Help.",
      model: { providerId: "mock", model: "mock" },
      visibility: "private",
      status: "draft",
      version: 1,
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
    };
    let sequence = 30;
    let networkRequests = 0;
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async (_tenant, reference) => secrets.get(reference) ?? "" },
      secretWriter: {
        put: async (_tenant, value) => {
          const reference = `secret_${(sequence++).toString(16).padStart(32, "0")}`;
          secrets.set(reference, value);
          return reference;
        },
        delete: async (_tenant, reference) => {
          secrets.delete(reference);
        },
      },
      allowedOrigins: new Set(["https://mcp.example.com", "https://auth.example.com"]),
      fetch: async () => {
        networkRequests += 1;
        throw new Error("This test does not start a remote OAuth flow.");
      },
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
    const collection = `https://dashboard.example.test/v1/bots/${botId}/mcp-servers`;
    const authentication = {
      mode: "oauth_authorization_code",
      clientId: "private-client-id",
      clientSecret: "private-client-secret",
      issuer: "https://auth.example.com",
      scope: "tools:read",
    };
    const createWithoutOrigin = await handler(
      new Request(collection, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "User consent", endpoint, authentication }),
      }),
    );
    expect(createWithoutOrigin?.status).toBe(403);
    expect(state.servers).toHaveLength(0);

    const createResponse = await handler(
      new Request(collection, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
          origin: "https://dashboard.example.test",
        },
        body: JSON.stringify({ name: "User consent", endpoint, authentication }),
      }),
    );
    expect(createResponse?.status).toBe(201);
    expect(createResponse?.headers.get("cache-control")).toBe("no-store");
    const responseText = await createResponse?.text();
    expect(responseText).not.toContain(authentication.clientId);
    expect(responseText).not.toContain(authentication.clientSecret);
    expect(responseText).not.toContain("credentialRef");
    const storedServer = state.servers[0];
    expect(storedServer?.credentialRef).toBeTruthy();
    const saved = decodeMcpOAuthAuthorizationState(secrets.get(storedServer?.credentialRef ?? "") ?? "");
    expect(saved).toMatchObject({
      clientId: authentication.clientId,
      clientSecret: authentication.clientSecret,
      redirectUri: "https://dashboard.example.test/miniapp/",
    });

    const oauthStartUrl = `${collection}/${storedServer?.id}/oauth/start`;
    const startWithoutOrigin = await handler(
      new Request(oauthStartUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}` },
      }),
    );
    expect(startWithoutOrigin?.status).toBe(403);
    const callbackWrongOrigin = await handler(
      new Request(`${collection}/${storedServer?.id}/oauth/callback`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
          origin: "https://attacker.example.test",
        },
        body: JSON.stringify({ code: "secret-code", state: "state" }),
      }),
    );
    expect(callbackWrongOrigin?.status).toBe(403);
    expect(networkRequests).toBe(0);
  });

  test("blocks OAuth metadata that points a token request at an unapproved origin", async () => {
    const state = memoryRepository();
    let storedSecret = "";
    let unapprovedRequests = 0;
    const fetchMock: TestFetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://mcp.example.com" && url.pathname.includes("oauth-protected-resource")) {
        return Response.json({ resource: endpoint, authorization_servers: ["https://auth.example.com"] });
      }
      if (url.origin === "https://auth.example.com" && url.pathname.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://outside.example/token",
          response_types_supported: ["code"],
          grant_types_supported: ["client_credentials"],
        });
      }
      if (url.origin === "https://mcp.example.com" && url.pathname === "/mcp") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      if (url.origin === "https://outside.example") unapprovedRequests += 1;
      throw new Error("Unexpected network request");
    };
    const manager = new McpManager({
      repository: state.repository,
      secrets: { resolve: async () => storedSecret },
      secretWriter: {
        put: async (_tenant, value) => {
          storedSecret = value;
          return "secret_00000000000000000000000000000004";
        },
        delete: async () => {},
      },
      allowedOrigins: new Set(["https://mcp.example.com", "https://auth.example.com"]),
      fetch: fetchMock,
    });
    await manager.addServer({
      id: "mcp_oauth_egress",
      tenantId,
      botId,
      name: "OAuth egress test",
      endpoint,
      authentication: {
        mode: "oauth_client_credentials",
        clientId: "bot-factory",
        clientSecret: "oauth-client-secret",
        issuer: "https://auth.example.com",
      },
      installedBy: ownerId,
    });

    await manager.connect(tenantId, botId, "mcp_oauth_egress").catch(() => undefined);
    expect(unapprovedRequests).toBe(0);
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
      secretWriter: {
        put: async () => "secret_00000000000000000000000000000002",
        delete: async () => {},
      },
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

    const oauthSecret = "oauth-secret-do-not-return";
    const oauthResponse = await handler(
      new Request(collection, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "OAuth service",
          endpoint,
          authentication: {
            mode: "oauth_client_credentials",
            clientId: "factory-client",
            clientSecret: oauthSecret,
            issuer: "https://mcp.example.com",
          },
        }),
      }),
    );
    expect(oauthResponse?.status).toBe(201);
    const oauthBody = await oauthResponse?.text();
    expect(oauthBody).not.toContain(oauthSecret);
    expect(oauthBody).not.toContain("credentialRef");

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
    const servers = (await list?.json()) as { id: string; status: string; hasCredential: boolean }[];
    expect(servers.find((server) => server.id === created.server.id)).toMatchObject({
      status: "connected",
      hasCredential: false,
    });
    expect(servers.find((server) => server.id !== created.server.id)).toMatchObject({
      status: "disconnected",
      hasCredential: true,
    });
  });
});

function memoryRepository() {
  const servers: McpServerConnection[] = [];
  const tools: McpDiscoveredTool[] = [];
  const reconnectLeases = new Map<string, { leaseUntil: string; leaseToken: string }>();
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
      if (server) {
        reconnectLeases.delete(server.id);
        servers[index] = {
          ...server,
          status: input.status,
          reconnectAttempts: 0,
          ...(input.status === "unhealthy" && input.reconnectAfter ? { reconnectAfter: input.reconnectAfter } : {}),
          updatedAt: new Date().toISOString(),
        };
      }
    },
    claimServerReconnect: async (input) => {
      const server = servers.find(
        (entry) => entry.id === input.serverId && entry.tenantId === input.tenantId && entry.botId === input.botId,
      );
      const lease = reconnectLeases.get(input.serverId);
      if (
        !server ||
        server.status !== "unhealthy" ||
        (server.reconnectAttempts ?? 0) >= input.maxAttempts ||
        (server.reconnectAfter !== undefined && server.reconnectAfter > input.now) ||
        (lease !== undefined && lease.leaseUntil > input.now)
      ) {
        return undefined;
      }
      const attempt = (server.reconnectAttempts ?? 0) + 1;
      servers[servers.indexOf(server)] = { ...server, reconnectAttempts: attempt };
      reconnectLeases.set(input.serverId, { leaseUntil: input.leaseUntil, leaseToken: input.leaseToken });
      return attempt;
    },
    failServerReconnect: async (input) => {
      const server = servers.find(
        (entry) => entry.id === input.serverId && entry.tenantId === input.tenantId && entry.botId === input.botId,
      );
      const lease = reconnectLeases.get(input.serverId);
      if (
        !server ||
        server.status !== "unhealthy" ||
        server.reconnectAttempts !== input.attempt ||
        lease?.leaseToken !== input.leaseToken
      ) {
        return false;
      }
      const index = servers.indexOf(server);
      servers[index] = {
        ...server,
        ...(input.retryAfter ? { reconnectAfter: input.retryAfter } : {}),
        updatedAt: input.now,
      };
      reconnectLeases.delete(input.serverId);
      return true;
    },
    setServerCredentialRef: async (input) => {
      const index = servers.findIndex(
        (server) => server.id === input.serverId && server.tenantId === input.tenantId && server.botId === input.botId,
      );
      const server = servers[index];
      if (!server) throw new AppError("NOT_FOUND", "MCP server was not found for this bot.", 404);
      if (server.credentialRef !== input.expectedCredentialRef) {
        throw new AppError("CONFLICT", "MCP credentials changed during OAuth state persistence.", 409);
      }
      servers[index] = { ...server, credentialRef: input.credentialRef, updatedAt: new Date().toISOString() };
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
