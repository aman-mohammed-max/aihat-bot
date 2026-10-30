import { CloudflareD1Repositories } from "./d1-repositories.js";
import { BotCoordinator } from "./coordinator.js";
import { CloudflareAlarmScheduler } from "./scheduler.js";
import { CloudflareR2ObjectStore } from "./r2-object-store.js";
import {
  ApiTokenAuthenticator,
  BotFactory,
  CreationApprovalService,
  EncryptedSecretStore,
  EnvironmentSecretKeyring,
  createAgentApiHandler,
  createFactoryApiHandler,
  createOpenAICompatibleAgentEngine,
  createManagementApiHandler,
  createBotManagementApiHandler,
  createSkillsApiHandler,
  createMcpApiHandler,
  TelegramManager,
  createTelegramManagementApiHandler,
  createTelegramWebhookHandler,
  ScheduledTaskService,
  ScheduledTaskRunner,
  createScheduledTasksApiHandler,
  CombinedToolRegistry,
  McpManager,
  SkillEngine,
} from "@aihat/core";

export { BotCoordinator };

export const runtimeCapabilities = {
  runtime: "cloudflare",
  features: {
    sharedAgentEngine: true,
    databasePersistence: true,
    durableObjectSqlite: true,
    durableObjectAlarms: true,
    queueEnqueue: true,
    queueProcessing: true,
    objectStorage: true,
    encryptedSecrets: true,
    authentication: true,
    promptSkills: true,
    httpSkills: true,
    nativeSkills: false,
    telegram: true,
    mcp: true,
    mcpOAuth: false,
    arbitraryCodeExecution: false,
  },
} as const;

/** D1 repository adapter shared by authenticated request handlers. */
export function repositories(env: Env): CloudflareD1Repositories {
  return new CloudflareD1Repositories(env.DB);
}

export function scheduler(env: Env): CloudflareAlarmScheduler {
  return new CloudflareAlarmScheduler(env.BOT_COORDINATOR);
}

export function objectStore(env: Env): CloudflareR2ObjectStore {
  return new CloudflareR2ObjectStore(env.OBJECTS);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const d1 = repositories(env);
    const authenticator = new ApiTokenAuthenticator(d1.apiTokens);
    const apiResponse = await createManagementApiHandler(authenticator, d1.apiTokens)(request);
    if (apiResponse) return apiResponse;
    const botManagementResponse = await createBotManagementApiHandler(authenticator, d1, d1)(request);
    if (botManagementResponse) return botManagementResponse;
    const approvals = new CreationApprovalService(d1.creationApprovals);
    let encryptedSecrets: EncryptedSecretStore | undefined;
    const secretStore = {
      resolve: (tenantId: Parameters<EncryptedSecretStore["resolve"]>[0], reference: string, signal?: AbortSignal) => {
        return getSecretStore().resolve(tenantId, reference, signal);
      },
      put: (tenantId: Parameters<EncryptedSecretStore["put"]>[0], plaintext: string) =>
        getSecretStore().put(tenantId, plaintext),
      delete: (tenantId: Parameters<EncryptedSecretStore["delete"]>[0], reference: string) =>
        getSecretStore().delete(tenantId, reference),
    };
    const getSecretStore = (): EncryptedSecretStore => {
      encryptedSecrets ??= new EncryptedSecretStore(
        d1.secretRecords,
        new EnvironmentSecretKeyring({
          SECRET_ACTIVE_KEY_ID: env.SECRET_ACTIVE_KEY_ID,
          SECRET_KEYRING_JSON: env.SECRET_KEYRING_JSON,
        }),
      );
      return encryptedSecrets;
    };
    const skillsResponse = await createSkillsApiHandler(authenticator, d1, d1.skills, secretStore)(request);
    if (skillsResponse) return skillsResponse;
    const mcpManager = new McpManager({
      repository: d1.mcp,
      secrets: secretStore,
      telegramGrants: d1,
      allowedOrigins: new Set(
        env.MCP_ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    });
    const mcpResponse = await createMcpApiHandler(authenticator, d1, mcpManager)(request);
    if (mcpResponse) return mcpResponse;
    const factoryResponse = await createFactoryApiHandler(
      authenticator,
      new BotFactory({ sessions: d1.sessions, approvals, drafts: d1 }),
      approvals,
      secretStore,
    )(request);
    if (factoryResponse) return factoryResponse;
    const agentEngine = createOpenAICompatibleAgentEngine({
      conversations: d1,
      secrets: secretStore,
      tools: new CombinedToolRegistry([
        new SkillEngine({
          skills: d1.skills,
          rateLimiter: d1.skillRateLimiter,
          secrets: secretStore,
          telegramGrants: d1,
          allowedHttpOrigins: new Set(
            env.HTTP_SKILL_ALLOWED_ORIGINS.split(",")
              .map((origin) => origin.trim())
              .filter(Boolean),
          ),
        }),
        mcpManager,
      ]),
      toolCalling: true,
      allowedOrigins: new Set(
        env.MODEL_ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    });
    const telegram = new TelegramManager({
      repository: d1,
      bots: d1,
      secrets: secretStore,
      engine: agentEngine,
      webhookBaseUrl: env.TELEGRAM_WEBHOOK_BASE_URL ?? "",
    });
    const scheduledTaskService = new ScheduledTaskService(d1, d1, telegram, scheduler(env));
    const webhookResponse = await createTelegramWebhookHandler(telegram)(request);
    if (webhookResponse) return webhookResponse;
    const telegramResponse = await createTelegramManagementApiHandler(authenticator, d1, d1, telegram)(request);
    if (telegramResponse) return telegramResponse;
    const scheduledTasksResponse = await createScheduledTasksApiHandler(authenticator, scheduledTaskService)(request);
    if (scheduledTasksResponse) return scheduledTasksResponse;
    const agentResponse = await createAgentApiHandler(authenticator, d1, d1, agentEngine)(request);
    if (agentResponse) return agentResponse;
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", runtime: "cloudflare", environment: env.APP_ENV });
    }
    if (url.pathname === "/capabilities" && request.method === "GET") {
      return Response.json({
        ...runtimeCapabilities,
        features: { ...runtimeCapabilities.features, telegram: Boolean(env.TELEGRAM_WEBHOOK_BASE_URL) },
      });
    }
    if (url.pathname === "/ready" && request.method === "GET") {
      try {
        await env.DB.prepare("SELECT id FROM tenants LIMIT 1").first<{ id: string }>();
        const coordinator = env.BOT_COORDINATOR.get(env.BOT_COORDINATOR.idFromName("readiness-check"));
        const coordinatorResponse = await coordinator.fetch("https://coordinator/health");
        if (!coordinatorResponse.ok) throw new Error("Durable Object readiness failed.");
        return Response.json({ status: "ready", runtime: "cloudflare" });
      } catch {
        return Response.json({ status: "not_ready", reason: "database_unavailable_or_unmigrated" }, { status: 503 });
      }
    }
    return new Response("Not found.", { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const d1 = repositories(env);
    const secrets = new EncryptedSecretStore(
      d1.secretRecords,
      new EnvironmentSecretKeyring({
        SECRET_ACTIVE_KEY_ID: env.SECRET_ACTIVE_KEY_ID,
        SECRET_KEYRING_JSON: env.SECRET_KEYRING_JSON,
      }),
    );
    const secretStore = {
      resolve: (tenantId: Parameters<EncryptedSecretStore["resolve"]>[0], reference: string, signal?: AbortSignal) =>
        secrets.resolve(tenantId, reference, signal),
      put: (tenantId: Parameters<EncryptedSecretStore["put"]>[0], plaintext: string) =>
        secrets.put(tenantId, plaintext),
      delete: (tenantId: Parameters<EncryptedSecretStore["delete"]>[0], reference: string) =>
        secrets.delete(tenantId, reference),
    };
    const mcpManager = new McpManager({
      repository: d1.mcp,
      secrets: secretStore,
      telegramGrants: d1,
      allowedOrigins: new Set(
        env.MCP_ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    });
    const engine = createOpenAICompatibleAgentEngine({
      conversations: d1,
      secrets: secretStore,
      tools: new CombinedToolRegistry([
        new SkillEngine({
          skills: d1.skills,
          rateLimiter: d1.skillRateLimiter,
          secrets: secretStore,
          telegramGrants: d1,
          allowedHttpOrigins: new Set(
            env.HTTP_SKILL_ALLOWED_ORIGINS.split(",")
              .map((origin) => origin.trim())
              .filter(Boolean),
          ),
        }),
        mcpManager,
      ]),
      toolCalling: true,
      allowedOrigins: new Set(
        env.MODEL_ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    });
    const telegram = new TelegramManager({
      repository: d1,
      bots: d1,
      secrets: secretStore,
      engine,
      webhookBaseUrl: env.TELEGRAM_WEBHOOK_BASE_URL ?? "",
    });
    const runner = new ScheduledTaskRunner(d1, d1, d1, engine, telegram, scheduler(env));
    for (const message of batch.messages) {
      const body = message.body;
      if (
        !isRecord(body) ||
        body.type !== "scheduled_task" ||
        typeof body.payloadRef !== "string" ||
        !/^job_[a-f0-9]{32}$/.test(body.payloadRef)
      ) {
        message.ack();
        continue;
      }
      try {
        const result = await runner.process(body.payloadRef as import("@aihat/core").JobId);
        if (result === "not_claimed") message.retry({ delaySeconds: 60 });
        else message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const dueJobIds = await repositories(env).listDueScheduledJobIds({
      now: new Date().toISOString(),
      limit: 100,
    });
    await Promise.all(dueJobIds.map((jobId) => env.JOBS.send({ type: "scheduled_task", payloadRef: jobId })));
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
