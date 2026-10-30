import { requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { BotRepository } from "./ports.js";
import type { McpManager } from "./mcp-manager.js";
import type { BotId, McpServerConnection } from "./types.js";

const BOT_ID = "bot_[a-f0-9-]{36}";
const BOT_SERVERS = new RegExp(`^/v1/bots/(${BOT_ID})/mcp-servers$`);
const SERVER_ROUTE = new RegExp(
  `^/v1/bots/(${BOT_ID})/mcp-servers/([A-Za-z0-9_-]{1,100})(?:/(connect|disconnect|test|tools))?$`,
);
const TOOL_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/mcp-servers/([A-Za-z0-9_-]{1,100})/tools/([^/]{1,128})$`);

/** Owner-scoped MCP connection and tool permission API. */
export function createMcpApiHandler(
  authenticator: ApiTokenAuthenticator,
  bots: BotRepository,
  mcp: McpManager,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    const collection = BOT_SERVERS.exec(pathname);
    const serverRoute = SERVER_ROUTE.exec(pathname);
    const toolRoute = TOOL_ROUTE.exec(pathname);
    if (!collection && !serverRoute && !toolRoute) return undefined;

    try {
      const principal = await authenticator.authenticate(request);
      const botId = (collection?.[1] ?? serverRoute?.[1] ?? toolRoute?.[1]) as BotId | undefined;
      if (!botId) return undefined;
      const bot = await bots.get(principal.tenantId, botId);
      if (!bot || bot.ownerId !== principal.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);

      if (collection) {
        if (request.method === "GET") {
          requireApiScope(principal, "bots:read");
          const servers = await mcp.listServers(principal.tenantId, botId);
          return json(servers.map(serverSummary));
        }
        if (request.method !== "POST") return methodNotAllowed("GET, POST");
        requireApiScope(principal, "bots:write");
        const body = await readJsonBody(request);
        if (!hasOnlyKeys(body, ["name", "endpoint", "credentialRef"])) {
          throw new AppError(
            "VALIDATION_ERROR",
            "MCP server settings contain unsupported or plaintext credential fields.",
            400,
          );
        }
        if (
          typeof body.name !== "string" ||
          typeof body.endpoint !== "string" ||
          (body.credentialRef !== undefined && typeof body.credentialRef !== "string")
        ) {
          throw new AppError("VALIDATION_ERROR", "MCP server settings are invalid.", 400);
        }
        const id = `mcp_${crypto.randomUUID()}`;
        await mcp.addServer({
          id,
          tenantId: principal.tenantId,
          botId,
          name: body.name,
          endpoint: body.endpoint,
          ...(typeof body.credentialRef === "string" ? { credentialRef: body.credentialRef } : {}),
          installedBy: principal.ownerId,
        });
        const servers = await mcp.listServers(principal.tenantId, botId);
        const created = servers.find((server) => server.id === id);
        if (!created) throw new AppError("INTERNAL_ERROR", "MCP server could not be loaded after creation.", 500);
        return json({ server: serverSummary(created), tools: [] }, 201);
      }

      if (toolRoute) {
        requireApiScope(principal, "bots:write");
        if (request.method !== "PATCH") return methodNotAllowed("PATCH");
        const body = await readJsonBody(request);
        if (!hasOnlyKeys(body, ["enabled", "grantedPermissions"])) {
          throw new AppError("VALIDATION_ERROR", "MCP tool settings contain unsupported fields.", 400);
        }
        if (typeof body.enabled !== "boolean" || !Array.isArray(body.grantedPermissions)) {
          throw new AppError("VALIDATION_ERROR", "MCP tool settings are invalid.", 400);
        }
        if (body.grantedPermissions.some((permission) => typeof permission !== "string")) {
          throw new AppError("VALIDATION_ERROR", "MCP tool permissions are invalid.", 400);
        }
        const serverId = toolRoute[2];
        const encodedToolName = toolRoute[3];
        if (!serverId || !encodedToolName) throw new AppError("VALIDATION_ERROR", "MCP tool route is invalid.", 400);
        let toolName: string;
        try {
          toolName = decodeURIComponent(encodedToolName);
        } catch (cause) {
          throw new AppError("VALIDATION_ERROR", "MCP tool name is invalid.", 400, { cause });
        }
        await mcp.setToolPermission({
          tenantId: principal.tenantId,
          botId,
          serverId,
          toolName,
          enabled: body.enabled,
          grantedPermissions: body.grantedPermissions as string[],
        });
        return json({ serverId, toolName, enabled: body.enabled, grantedPermissions: body.grantedPermissions });
      }

      const serverId = serverRoute?.[2];
      const action = serverRoute?.[3];
      if (!serverId) return undefined;
      if (action === "tools" && request.method === "GET") {
        requireApiScope(principal, "bots:read");
        return json(await mcp.listTools(principal.tenantId, botId, serverId));
      }
      if (action === "connect" || action === "test") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        requireApiScope(principal, "bots:write");
        const tools = await mcp.connect(principal.tenantId, botId, serverId);
        const servers = await mcp.listServers(principal.tenantId, botId);
        const server = servers.find((item) => item.id === serverId);
        return json({ server: server ? serverSummary(server) : undefined, discoveredTools: tools.length, tools });
      }
      if (action === "disconnect") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        requireApiScope(principal, "bots:write");
        await mcp.disconnect(principal.tenantId, botId, serverId);
        return new Response(null, { status: 204, headers: noStoreHeaders() });
      }
      if (!action && request.method === "DELETE") {
        requireApiScope(principal, "bots:write");
        await mcp.removeServer(principal.tenantId, botId, serverId);
        return new Response(null, { status: 204, headers: noStoreHeaders() });
      }
      return methodNotAllowed(action ? "GET, POST" : "GET, DELETE");
    } catch (cause) {
      if (cause instanceof AppError) {
        return Response.json(
          { error: cause.code, message: cause.message },
          {
            status: cause.status,
            headers: { ...noStoreHeaders(), ...(cause.status === 401 ? { "www-authenticate": "Bearer" } : {}) },
          },
        );
      }
      return Response.json(
        { error: "INTERNAL_ERROR", message: "The request could not be completed." },
        { status: 500, headers: noStoreHeaders() },
      );
    }
  };
}

function serverSummary(server: McpServerConnection) {
  return {
    id: server.id,
    name: server.name,
    endpoint: server.endpoint,
    status: server.status,
    hasCredential: Boolean(server.credentialRef),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > 16_384) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let text: string;
  try {
    text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 16_384) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
    return value;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStoreHeaders() });
}

function noStoreHeaders(): HeadersInit {
  return { "cache-control": "no-store" };
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow, ...noStoreHeaders() } },
  );
}
