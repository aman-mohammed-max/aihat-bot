import { parseBunRuntimeConfig } from "./config.js";
import { JsonLogger } from "./logger.js";
import { openSqliteDatabase } from "./migrations.js";
import { runtimeCapabilities } from "./capabilities.js";
import {
  ApiTokenAuthenticator,
  BotFactory,
  CreationApprovalService,
  FactoryAssistant,
  ProviderCapabilityTools,
  EncryptedSecretStore,
  BotCredentialApprovalService,
  EnvironmentSecretKeyring,
  createAgentApiHandler,
  createBotAccessApiHandler,
  createFactoryApiHandler,
  createOpenAICompatibleAgentEngine,
  hasVerifiedStructuredOutputOrigin,
  hasVerifiedStreamingOrigin,
  createManagementApiHandler,
  createBotManagementApiHandler,
  createSkillsApiHandler,
  createGlobalSkillCatalogAdminHandler,
  createMcpApiHandler,
  TelegramManager,
  TelegramMasterBot,
  createTelegramManagementApiHandler,
  createTelegramWebhookHandler,
  createTelegramMasterWebhookHandler,
  createTelegramWebAppAuthHandler,
  createConversationHistoryApiHandler,
  createUsageApiHandler,
  createAuditLogApiHandler,
  createTenantMembersApiHandler,
  createWorkspacesApiHandler,
  createUsageTrackingAgentEngine,
  createMemoryApiHandler,
  createMemoryAwareAgentEngine,
  createEncryptedMemoryService,
  UploadedFilesService,
  createUploadedFilesApiHandler,
  createOptionalHttpMalwareScanner,
  ScheduledTaskService,
  ScheduledTaskRunner,
  createScheduledTasksApiHandler,
  CombinedToolRegistry,
  DurableToolRegistry,
  McpManager,
  SkillEngine,
} from "@aihat/core";
import { BunSqliteRepositories } from "./sqlite-store.js";
import { BunFileObjectStore } from "./file-object-store.js";
import { BunSqliteUploadedFileRepository } from "./uploaded-file-repository.js";

const config = parseBunRuntimeConfig(process.env);
const logger = new JsonLogger(config.logLevel);
const db = openSqliteDatabase(config.databasePath);
const repositories = new BunSqliteRepositories(db);
const objects = new BunFileObjectStore(process.env.OBJECTS_PATH ?? "./data/objects");
const uploadedFileRepository = new BunSqliteUploadedFileRepository(db);
const fileScannerOrigins = new Set(
  (process.env.FILE_SCANNER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const malwareScanner = createOptionalHttpMalwareScanner({
  ...(process.env.FILE_SCANNER_ENDPOINT ? { endpoint: process.env.FILE_SCANNER_ENDPOINT } : {}),
  ...(process.env.FILE_SCANNER_TOKEN ? { token: process.env.FILE_SCANNER_TOKEN } : {}),
  allowedOrigins: fileScannerOrigins,
});
const uploadedFilesService = new UploadedFilesService({
  bots: repositories,
  files: uploadedFileRepository,
  objects,
  ...(malwareScanner ? { scanner: malwareScanner } : {}),
  runtime: "bun",
});
const authenticator = new ApiTokenAuthenticator(repositories.apiTokens, { authorizationAudit: repositories });
const telegramMasterBotToken = process.env.TELEGRAM_MASTER_BOT_TOKEN ?? process.env.TELEGRAME_BOT_TOKEN ?? "";
const telegramWebAppAuth = createTelegramWebAppAuthHandler({
  botToken: telegramMasterBotToken,
  accounts: repositories.telegramAuth,
  tokens: repositories.apiTokens,
});
const approvals = new CreationApprovalService(repositories.creationApprovals);
const botCredentialApprovals = new BotCredentialApprovalService(repositories.botCredentialApprovals);
const botFactory = new BotFactory({ sessions: repositories.sessions, approvals, drafts: repositories });
const telegramWebhookBaseUrl = process.env.TELEGRAM_WEBHOOK_BASE_URL ?? "";
const telegramMasterWebhookSecret = process.env.TELEGRAM_MASTER_WEBHOOK_SECRET ?? "";
const telegramMasterBot =
  telegramMasterBotToken && telegramMasterWebhookSecret && telegramWebhookBaseUrl
    ? new TelegramMasterBot({
        token: telegramMasterBotToken,
        webhookSecret: telegramMasterWebhookSecret,
        webhookBaseUrl: telegramWebhookBaseUrl,
        accounts: repositories.telegramAuth,
        sessions: repositories.masterBot,
        factory: botFactory,
        bots: repositories,
      })
    : undefined;
const telegramMasterWebhook = createTelegramMasterWebhookHandler(telegramMasterBot);
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
const memoryService = createEncryptedMemoryService(repositories, secretStore);
const mcpManager = new McpManager({
  repository: repositories.mcp,
  secrets: secretStore,
  telegramGrants: repositories,
  authorizationAudit: repositories,
  allowedOrigins: new Set(
    (process.env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
});
const modelAllowedOrigins = new Set(
  (process.env.MODEL_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const baseAgentEngine = createOpenAICompatibleAgentEngine({
  conversations: repositories,
  secrets: secretStore,
  tools: new DurableToolRegistry({
    registry: new CombinedToolRegistry([
      new ProviderCapabilityTools({ bots: repositories, secrets: secretStore, allowedOrigins: modelAllowedOrigins }),
      new SkillEngine({
        skills: repositories.skills,
        rateLimiter: repositories.skillRateLimiter,
        workflowExecutions: repositories.workflowExecutions,
        secrets: secretStore,
        secretWriter: secretStore,
        telegramGrants: repositories,
        authorizationAudit: repositories,
        allowedHttpOrigins: new Set(
          (process.env.HTTP_SKILL_ALLOWED_ORIGINS ?? "")
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
        ),
      }),
      mcpManager,
    ]),
    executions: repositories.toolExecutions,
    secrets: secretStore,
    secretWriter: secretStore,
  }),
  toolCalling: true,
  imageInput: String(process.env.MODEL_IMAGE_INPUT) === "true",
  streamingOrigins: new Set(
    (process.env.MODEL_STREAMING_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
  structuredOutputOrigins: new Set(
    (process.env.MODEL_STRUCTURED_OUTPUT_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
  allowedOrigins: modelAllowedOrigins,
});
const agentEngine = createUsageTrackingAgentEngine(
  createMemoryAwareAgentEngine(baseAgentEngine, memoryService, logger),
  repositories,
  logger,
);
const telegram = new TelegramManager({
  repository: repositories,
  bots: repositories,
  secrets: secretStore,
  engine: agentEngine,
  objects,
  ...(malwareScanner ? { malwareScanner } : {}),
  webhookBaseUrl: process.env.TELEGRAM_WEBHOOK_BASE_URL ?? "",
});
const scheduledTaskService = new ScheduledTaskService(repositories, repositories, telegram);
const scheduledTaskRunner = new ScheduledTaskRunner(repositories, repositories, repositories, agentEngine, telegram);
const factoryAssistant =
  process.env.FACTORY_LLM_ENDPOINT?.trim() &&
  process.env.FACTORY_LLM_TOKEN?.trim() &&
  process.env.FACTORY_LLM_MODEL?.trim()
    ? new FactoryAssistant({
        endpoint: process.env.FACTORY_LLM_ENDPOINT,
        token: process.env.FACTORY_LLM_TOKEN,
        model: process.env.FACTORY_LLM_MODEL,
      })
    : undefined;
const factoryApi = createFactoryApiHandler(authenticator, botFactory, approvals, secretStore, {
  modelDiscoveryOrigins: new Set(
    (process.env.MODEL_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
  ...(factoryAssistant ? { assistant: factoryAssistant } : {}),
});
const agentApi = createAgentApiHandler(authenticator, repositories, repositories, agentEngine);
const botAccessApi = createBotAccessApiHandler({
  authenticator,
  access: repositories,
  bots: repositories,
  conversations: repositories,
  engine: agentEngine,
});
const managementApi = createManagementApiHandler(authenticator, repositories.apiTokens);
const botManagementApi = createBotManagementApiHandler(
  authenticator,
  repositories,
  repositories,
  botCredentialApprovals,
  secretStore,
);
const conversationHistoryApi = createConversationHistoryApiHandler(authenticator, repositories);
const usageApi = createUsageApiHandler(authenticator, repositories);
const auditLogApi = createAuditLogApiHandler(authenticator, repositories);
const tenantMembersApi = createTenantMembersApiHandler(authenticator, repositories.tenantMembers);
const workspacesApi = createWorkspacesApiHandler(authenticator, repositories.apiTokens, repositories.tenantMembers);
const memoryApi = createMemoryApiHandler(authenticator, memoryService);
const uploadedFilesApi = createUploadedFilesApiHandler(authenticator, uploadedFilesService);
const skillsApi = createSkillsApiHandler(authenticator, repositories, repositories.skills, secretStore);
const globalSkillCatalogAdminApi = createGlobalSkillCatalogAdminHandler({
  skills: repositories.skills,
  authorizationToken: process.env.SKILL_CATALOG_ADMIN_TOKEN ?? "",
});
const mcpApi = createMcpApiHandler(authenticator, repositories, mcpManager);
const telegramApi = createTelegramManagementApiHandler(authenticator, repositories, repositories, telegram);
const scheduledTasksApi = createScheduledTasksApiHandler(authenticator, scheduledTaskService);
const telegramWebhook = createTelegramWebhookHandler(telegram);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    const miniAppResponse = await serveMiniApp(request, url);
    if (miniAppResponse) return miniAppResponse;
    const globalSkillCatalogResponse = await globalSkillCatalogAdminApi(request);
    if (globalSkillCatalogResponse) return globalSkillCatalogResponse;
    const masterWebhookResponse = await telegramMasterWebhook(request);
    if (masterWebhookResponse) return masterWebhookResponse;
    const webhookResponse = await telegramWebhook(request);
    if (webhookResponse) return webhookResponse;
    const telegramAuthResponse = await telegramWebAppAuth(request);
    if (telegramAuthResponse) return telegramAuthResponse;
    const apiResponse = await managementApi(request);
    if (apiResponse) return apiResponse;
    const conversationHistoryResponse = await conversationHistoryApi(request);
    if (conversationHistoryResponse) return conversationHistoryResponse;
    const usageResponse = await usageApi(request);
    if (usageResponse) return usageResponse;
    const auditLogResponse = await auditLogApi(request);
    if (auditLogResponse) return auditLogResponse;
    const tenantMembersResponse = await tenantMembersApi(request);
    if (tenantMembersResponse) return tenantMembersResponse;
    const workspacesResponse = await workspacesApi(request);
    if (workspacesResponse) return workspacesResponse;
    const memoryResponse = await memoryApi(request);
    if (memoryResponse) return memoryResponse;
    const uploadedFilesResponse = await uploadedFilesApi(request);
    if (uploadedFilesResponse) return uploadedFilesResponse;
    const botManagementResponse = await botManagementApi(request);
    if (botManagementResponse) return botManagementResponse;
    const botAccessResponse = await botAccessApi(request);
    if (botAccessResponse) return botAccessResponse;
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
        features: {
          ...runtimeCapabilities.features,
          telegram: Boolean(process.env.TELEGRAM_WEBHOOK_BASE_URL),
          telegramMiniAppAuth: Boolean(telegramMasterBotToken),
          telegramMasterBot: Boolean(telegramMasterBot),
          fileMalwareScanning: Boolean(malwareScanner),
          modelStreaming: hasVerifiedStreamingOrigin(
            new Set(
              (process.env.MODEL_ALLOWED_ORIGINS ?? "")
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
            new Set(
              (process.env.MODEL_STREAMING_ORIGINS ?? "")
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
          ),
          modelStructuredOutput: hasVerifiedStructuredOutputOrigin(
            new Set(
              (process.env.MODEL_ALLOWED_ORIGINS ?? "")
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
            new Set(
              (process.env.MODEL_STRUCTURED_OUTPUT_ORIGINS ?? "")
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
          ),
        },
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

async function serveMiniApp(request: Request, url: URL): Promise<Response | undefined> {
  const dashboardDir = process.env.DASHBOARD_DIR ?? `${process.cwd()}/apps/dashboard/dist`;
  if (url.pathname === "/miniapp") return Response.redirect(new URL("/miniapp/", url), 308);
  if (url.pathname === "/miniapp/" && (request.method === "GET" || request.method === "HEAD")) {
    const index = Bun.file(`${dashboardDir}/index.html`);
    if (!(await index.exists()))
      return new Response("Mini App assets are missing. Run `bun run build:dashboard` first.", { status: 503 });
    return new Response(request.method === "HEAD" ? null : index, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const asset = /^\/miniapp\/assets\/([A-Za-z0-9_-]+\.(?:js|css))$/.exec(url.pathname);
  if (asset && (request.method === "GET" || request.method === "HEAD")) {
    const fileName = asset[1];
    if (!fileName) return new Response(null, { status: 404 });
    const file = Bun.file(`${dashboardDir}/assets/${fileName}`);
    if (!(await file.exists())) return new Response("Not found.", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "content-type": file.type || "application/octet-stream", "cache-control": "public, max-age=300" },
    });
  }
  if (url.pathname.startsWith("/miniapp/")) return new Response("Not found.", { status: 404 });
  return undefined;
}

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
