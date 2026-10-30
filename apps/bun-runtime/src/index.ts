import { parseBunRuntimeConfig } from "./config.js";
import { JsonLogger } from "./logger.js";
import { openSqliteDatabase } from "./migrations.js";
import { runtimeCapabilities } from "./capabilities.js";
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
import { BunSqliteRepositories } from "./sqlite-store.js";

const config = parseBunRuntimeConfig(process.env);
const logger = new JsonLogger(config.logLevel);
const db = openSqliteDatabase(config.databasePath);
const repositories = new BunSqliteRepositories(db);
const authenticator = new ApiTokenAuthenticator(repositories.apiTokens);
const approvals = new CreationApprovalService(repositories.creationApprovals);
let encryptedSecrets: EncryptedSecretStore | undefined;
const secretStore = {
  resolve: (tenantId: Parameters<EncryptedSecretStore["resolve"]>[0], reference: string, signal?: AbortSignal) => {
    return bunSecretStore().resolve(tenantId, reference, signal);
  },
  put: (tenantId: Parameters<EncryptedSecretStore["put"]>[0], plaintext: string) =>
    bunSecretStore().put(tenantId, plaintext),
  delete: (tenantId: Parameters<EncryptedSecretStore["delete"]>[0], reference: string) =>
    bunSecretStore().delete(tenantId, reference),
};
const mcpManager = new McpManager({
  repository: repositories.mcp,
  secrets: secretStore,
  telegramGrants: repositories,
  allowedOrigins: new Set(
    (process.env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
});
const agentEngine = createOpenAICompatibleAgentEngine({
  conversations: repositories,
  secrets: secretStore,
  tools: new CombinedToolRegistry([
    new SkillEngine({
      skills: repositories.skills,
      rateLimiter: repositories.skillRateLimiter,
      secrets: secretStore,
      telegramGrants: repositories,
      allowedHttpOrigins: new Set(
        (process.env.HTTP_SKILL_ALLOWED_ORIGINS ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    }),
    mcpManager,
  ]),
  toolCalling: true,
  allowedOrigins: new Set(
    (process.env.MODEL_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
});
const telegram = new TelegramManager({
  repository: repositories,
  bots: repositories,
  secrets: secretStore,
  engine: agentEngine,
  webhookBaseUrl: process.env.TELEGRAM_WEBHOOK_BASE_URL ?? "",
});
const scheduledTaskService = new ScheduledTaskService(repositories, repositories, telegram);
const scheduledTaskRunner = new ScheduledTaskRunner(repositories, repositories, repositories, agentEngine, telegram);
const factoryApi = createFactoryApiHandler(
  authenticator,
  new BotFactory({ sessions: repositories.sessions, approvals, drafts: repositories }),
  approvals,
  secretStore,
);
const agentApi = createAgentApiHandler(authenticator, repositories, repositories, agentEngine);
const managementApi = createManagementApiHandler(authenticator, repositories.apiTokens);
const botManagementApi = createBotManagementApiHandler(authenticator, repositories, repositories);
const skillsApi = createSkillsApiHandler(authenticator, repositories, repositories.skills, secretStore);
const mcpApi = createMcpApiHandler(authenticator, repositories, mcpManager);
const telegramApi = createTelegramManagementApiHandler(authenticator, repositories, repositories, telegram);
const scheduledTasksApi = createScheduledTasksApiHandler(authenticator, scheduledTaskService);
const telegramWebhook = createTelegramWebhookHandler(telegram);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    const webhookResponse = await telegramWebhook(request);
    if (webhookResponse) return webhookResponse;
    const apiResponse = await managementApi(request);
    if (apiResponse) return apiResponse;
    const botManagementResponse = await botManagementApi(request);
    if (botManagementResponse) return botManagementResponse;
    const skillsResponse = await skillsApi(request);
    if (skillsResponse) return skillsResponse;
    const mcpResponse = await mcpApi(request);
    if (mcpResponse) return mcpResponse;
    const telegramResponse = await telegramApi(request);
    if (telegramResponse) return telegramResponse;
    const scheduledTasksResponse = await scheduledTasksApi(request);
    if (scheduledTasksResponse) return scheduledTasksResponse;
    const factoryResponse = await factoryApi(request);
    if (factoryResponse) return factoryResponse;
    const agentResponse = await agentApi(request);
    if (agentResponse) return agentResponse;
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (request.method === "GET" && url.pathname === "/capabilities") {
      return Response.json({
        ...runtimeCapabilities,
        features: { ...runtimeCapabilities.features, telegram: Boolean(process.env.TELEGRAM_WEBHOOK_BASE_URL) },
      });
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      try {
        db.query("SELECT 1 AS ready").get();
        return Response.json({ status: "ready" });
      } catch {
        return Response.json({ status: "unavailable" }, { status: 503 });
      }
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },
});

logger.info("bun_runtime_started", { host: config.host, port: config.port, environment: config.environment });

let scheduledBatchRunning = false;
const scheduledWorkerTimer = setInterval(() => {
  if (scheduledBatchRunning || stopping) return;
  scheduledBatchRunning = true;
  void scheduledTaskRunner
    .runDueBatch(new Date().toISOString(), 10)
    .catch((error: unknown) => logger.error("scheduled_task_batch_failed", { error }))
    .finally(() => {
      scheduledBatchRunning = false;
    });
}, 5_000);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("bun_runtime_stopping", { signal });
  clearInterval(scheduledWorkerTimer);
  await server.stop(true);
  db.close();
  logger.info("bun_runtime_stopped");
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

function bunSecretStore(): EncryptedSecretStore {
  encryptedSecrets ??= new EncryptedSecretStore(repositories.secretRecords, new EnvironmentSecretKeyring(process.env));
  return encryptedSecrets;
}
