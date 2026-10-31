import { CloudflareD1Repositories } from "./d1-repositories.js";
import { BotCoordinator } from "./coordinator.js";
import { ConversationCoordinator } from "./conversation-coordinator.js";
import { CloudflareConversationAgentEngine } from "./conversation-agent-engine.js";
import { CloudflareAlarmScheduler } from "./scheduler.js";
import { CloudflareR2ObjectStore } from "./r2-object-store.js";
import { CloudflareD1UploadedFileRepository } from "./uploaded-file-repository.js";
import {
  ApiTokenAuthenticator,
  BotFactory,
  CreationApprovalService,
  FactoryAssistant,
  ProviderCapabilityTools,
  EncryptedSecretStore,
  createSecretRotationApiHandler,
  createGlobalSkillCatalogAdminHandler,
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
  createBotOwnershipTransfersApiHandler,
  createSkillsApiHandler,
  createMcpApiHandler,
  TelegramManager,
  createTelegramManagementApiHandler,
  createTelegramWebhookHandler,
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
  UploadedDocumentTools,
  createUploadedFilesApiHandler,
  createOptionalHttpMalwareScanner,
  ScheduledTaskService,
  ScheduledTaskRunner,
  createScheduledTasksApiHandler,
  createToolExecutionRecoveryApiHandler,
  parseRuntimeConfig,
  CombinedToolRegistry,
  DurableToolRegistry,
  McpManager,
  SkillEngine,
  createDefaultNativeSkillRegistry,
  TelegramMasterBot,
  createTelegramMasterWebhookHandler,
  sanitizeLogFields,
  sanitizeLogText,
  type Logger,
} from "@aihat/core";

export { BotCoordinator, ConversationCoordinator };

const nativeSkills = createDefaultNativeSkillRegistry();

export const runtimeCapabilities = {
  runtime: "cloudflare",
  features: {
    sharedAgentEngine: true,
    databasePersistence: true,
    durableObjectSqlite: true,
    durableConversationCoordination: true,
    durableObjectAlarms: true,
    queueEnqueue: true,
    queueProcessing: true,
    objectStorage: true,
    uploadedFileManagement: true,
    fileMalwareScanning: false,
    encryptedSecrets: true,
    authentication: true,
    longTermMemory: true,
    promptSkills: true,
    httpSkills: true,
    workflowSkills: true,
    nativeSkills: true,
    modelStreaming: false,
    modelStructuredOutput: false,
    telegram: true,
    telegramMasterBot: false,
    mcp: true,
    mcpOAuth: true,
    mcpOAuthAuthorizationCode: true,
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
    const miniAppResponse = await serveMiniApp(request, env.ASSETS);
    if (miniAppResponse) return miniAppResponse;
    const d1 = repositories(env);
    const runtimeConfig = runtimeConfigFromEnv(env);
    const globalSkillCatalogResponse = await createGlobalSkillCatalogAdminHandler({
      skills: d1.skills,
      authorizationToken: env.SKILL_CATALOG_ADMIN_TOKEN ?? "",
      nativeSkills,
    })(request);
    if (globalSkillCatalogResponse) return globalSkillCatalogResponse;
    const secretRotationResponse = await createSecretRotationApiHandler({
      records: d1.secretRecords,
      keyring: new EnvironmentSecretKeyring({
        SECRET_ACTIVE_KEY_ID: env.SECRET_ACTIVE_KEY_ID,
        SECRET_KEYRING_JSON: env.SECRET_KEYRING_JSON,
      }),
      authorizationToken: env.SECRET_ROTATION_AUTH_TOKEN ?? "",
    })(request);
    if (secretRotationResponse) return secretRotationResponse;
    const authenticator = new ApiTokenAuthenticator(d1.apiTokens, { authorizationAudit: d1 });
    const malwareScanner = createOptionalHttpMalwareScanner({
      ...(env.FILE_SCANNER_ENDPOINT ? { endpoint: env.FILE_SCANNER_ENDPOINT } : {}),
      ...(env.FILE_SCANNER_TOKEN ? { token: env.FILE_SCANNER_TOKEN } : {}),
      allowedOrigins: new Set(
        env.FILE_SCANNER_ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    });
    const uploadedFilesService = new UploadedFilesService({
      bots: d1,
      files: new CloudflareD1UploadedFileRepository(env.DB),
      objects: objectStore(env),
      ...(malwareScanner ? { scanner: malwareScanner } : {}),
      runtime: "cloudflare",
    });
    const uploadedFilesApi = createUploadedFilesApiHandler(authenticator, uploadedFilesService);
    const telegramMasterBotToken = env.TELEGRAM_MASTER_BOT_TOKEN ?? env.TELEGRAME_BOT_TOKEN ?? "";
    const telegramWebAppAuth = createTelegramWebAppAuthHandler({
      botToken: telegramMasterBotToken,
      accounts: d1.telegramAuth,
      tokens: d1.apiTokens,
    });
    const telegramAuthResponse = await telegramWebAppAuth(request);
    if (telegramAuthResponse) return telegramAuthResponse;
    const apiResponse = await createManagementApiHandler(authenticator, d1.apiTokens)(request);
    if (apiResponse) return apiResponse;
    const tenantMembersResponse = await createTenantMembersApiHandler(authenticator, d1.tenantMembers)(request);
    if (tenantMembersResponse) return tenantMembersResponse;
    const workspacesResponse = await createWorkspacesApiHandler(authenticator, d1.apiTokens, d1.tenantMembers)(request);
    if (workspacesResponse) return workspacesResponse;
    const conversationHistoryResponse = await createConversationHistoryApiHandler(authenticator, d1)(request);
    if (conversationHistoryResponse) return conversationHistoryResponse;
    const usageResponse = await createUsageApiHandler(authenticator, d1)(request);
    if (usageResponse) return usageResponse;
    const auditLogResponse = await createAuditLogApiHandler(authenticator, d1)(request);
    if (auditLogResponse) return auditLogResponse;
    const approvals = new CreationApprovalService(d1.creationApprovals);
    const botFactory = new BotFactory({ sessions: d1.sessions, approvals, drafts: d1 });
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
    const botManagementResponse = await createBotManagementApiHandler(
      authenticator,
      d1,
      d1,
      new BotCredentialApprovalService(d1.botCredentialApprovals),
      secretStore,
    )(request);
    if (botManagementResponse) return botManagementResponse;
    const ownershipTransferResponse = await createBotOwnershipTransfersApiHandler(authenticator, d1)(request);
    if (ownershipTransferResponse) return ownershipTransferResponse;
    const memoryService = createEncryptedMemoryService(d1, secretStore);
    const memoryResponse = await createMemoryApiHandler(authenticator, memoryService)(request);
    if (memoryResponse) return memoryResponse;
    const uploadedFilesResponse = await uploadedFilesApi(request);
    if (uploadedFilesResponse) return uploadedFilesResponse;
    const skillsResponse = await createSkillsApiHandler(authenticator, d1, d1.skills, secretStore)(request);
    if (skillsResponse) return skillsResponse;
    const mcpManager = new McpManager({
      repository: d1.mcp,
      secrets: secretStore,
      secretWriter: secretStore,
      telegramGrants: d1,
      authorizationAudit: d1,
      allowedOrigins: new Set(
        env.MCP_ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    });
    const modelAllowedOrigins = new Set(
      env.MODEL_ALLOWED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
    const mcpResponse = await createMcpApiHandler(authenticator, d1, mcpManager)(request);
    if (mcpResponse) return mcpResponse;
    const factoryAssistant =
      env.FACTORY_LLM_ENDPOINT?.trim() && env.FACTORY_LLM_TOKEN?.trim() && env.FACTORY_LLM_MODEL?.trim()
        ? new FactoryAssistant({
            endpoint: env.FACTORY_LLM_ENDPOINT,
            token: env.FACTORY_LLM_TOKEN,
            model: env.FACTORY_LLM_MODEL,
          })
        : undefined;
    const factoryResponse = await createFactoryApiHandler(authenticator, botFactory, approvals, secretStore, {
      modelDiscoveryOrigins: modelAllowedOrigins,
      ...(factoryAssistant ? { assistant: factoryAssistant } : {}),
    })(request);
    if (factoryResponse) return factoryResponse;
    const runtimeLogger = createRuntimeLogger();
    const baseAgentEngine = createOpenAICompatibleAgentEngine({
      conversations: d1,
      secrets: secretStore,
      retryPolicy: runtimeConfig.modelRetryPolicy,
      logger: runtimeLogger,
      tools: new DurableToolRegistry({
        registry: new CombinedToolRegistry([
          new ProviderCapabilityTools({ bots: d1, secrets: secretStore, allowedOrigins: modelAllowedOrigins }),
          new UploadedDocumentTools({ bots: d1, files: uploadedFilesService }),
          new SkillEngine({
            skills: d1.skills,
            rateLimiter: d1.skillRateLimiter,
            workflowExecutions: d1.workflowExecutions,
            nativeHandlers: nativeSkills.handlers,
            secrets: secretStore,
            secretWriter: secretStore,
            telegramGrants: d1,
            authorizationAudit: d1,
            logger: runtimeLogger,
            allowedHttpOrigins: new Set(
              env.HTTP_SKILL_ALLOWED_ORIGINS.split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
          }),
          mcpManager,
        ]),
        executions: d1.toolExecutions,
        secrets: secretStore,
        secretWriter: secretStore,
      }),
      toolCalling: true,
      imageInput: String(env.MODEL_IMAGE_INPUT) === "true",
      streamingOrigins: new Set(
        (env.MODEL_STREAMING_ORIGINS ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
      structuredOutputOrigins: new Set(
        (env.MODEL_STRUCTURED_OUTPUT_ORIGINS ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
      allowedOrigins: modelAllowedOrigins,
    });
    const trackedAgentEngine = createUsageTrackingAgentEngine(
      createMemoryAwareAgentEngine(baseAgentEngine, memoryService, runtimeLogger),
      d1,
      runtimeLogger,
    );
    const agentEngine = new CloudflareConversationAgentEngine(
      trackedAgentEngine,
      env.CONVERSATION_COORDINATOR,
      runtimeLogger,
    );
    const telegram = new TelegramManager({
      repository: d1,
      bots: d1,
      secrets: secretStore,
      engine: agentEngine,
      objects: objectStore(env),
      ...(malwareScanner ? { malwareScanner } : {}),
      webhookBaseUrl: env.TELEGRAM_WEBHOOK_BASE_URL ?? "",
      retryPolicy: runtimeConfig.telegramRetryPolicy,
      logger: runtimeLogger,
    });
    const scheduledTaskService = new ScheduledTaskService(d1, d1, telegram, scheduler(env));
    const masterBot =
      telegramMasterBotToken && env.TELEGRAM_MASTER_WEBHOOK_SECRET && env.TELEGRAM_WEBHOOK_BASE_URL
        ? new TelegramMasterBot({
            token: telegramMasterBotToken,
            webhookSecret: env.TELEGRAM_MASTER_WEBHOOK_SECRET,
            webhookBaseUrl: env.TELEGRAM_WEBHOOK_BASE_URL,
            accounts: d1.telegramAuth,
            sessions: d1.masterBot,
            factory: botFactory,
            bots: d1,
            retryPolicy: runtimeConfig.telegramRetryPolicy,
            requestsPerMinute: runtimeConfig.telegramMasterRequestsPerMinute,
            logger: runtimeLogger,
          })
        : undefined;
    const masterWebhookResponse = await createTelegramMasterWebhookHandler(masterBot)(request);
    if (masterWebhookResponse) return masterWebhookResponse;
    const webhookResponse = await createTelegramWebhookHandler(telegram)(request);
    if (webhookResponse) return webhookResponse;
    const telegramResponse = await createTelegramManagementApiHandler(authenticator, d1, d1, telegram)(request);
    if (telegramResponse) return telegramResponse;
    const scheduledTasksResponse = await createScheduledTasksApiHandler(authenticator, scheduledTaskService)(request);
    if (scheduledTasksResponse) return scheduledTasksResponse;
    const toolExecutionRecoveryResponse = await createToolExecutionRecoveryApiHandler(
      authenticator,
      d1.toolExecutions,
    )(request);
    if (toolExecutionRecoveryResponse) return toolExecutionRecoveryResponse;
    const botAccessResponse = await createBotAccessApiHandler({
      authenticator,
      access: d1,
      bots: d1,
      conversations: d1,
      engine: agentEngine,
    })(request);
    if (botAccessResponse) return botAccessResponse;
    const agentResponse = await createAgentApiHandler(authenticator, d1, d1, agentEngine)(request);
    if (agentResponse) return agentResponse;
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", runtime: "cloudflare", environment: env.APP_ENV });
    }
    if (url.pathname === "/capabilities" && request.method === "GET") {
      return Response.json({
        ...runtimeCapabilities,
        features: {
          ...runtimeCapabilities.features,
          telegram: Boolean(env.TELEGRAM_WEBHOOK_BASE_URL),
          telegramMiniAppAuth: Boolean(telegramMasterBotToken),
          telegramMasterBot: Boolean(masterBot),
          fileMalwareScanning: Boolean(malwareScanner),
          modelStreaming: hasVerifiedStreamingOrigin(
            new Set(
              env.MODEL_ALLOWED_ORIGINS.split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
            new Set(
              (env.MODEL_STREAMING_ORIGINS ?? "")
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
          ),
          modelStructuredOutput: hasVerifiedStructuredOutputOrigin(
            new Set(
              env.MODEL_ALLOWED_ORIGINS.split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
            new Set(
              (env.MODEL_STRUCTURED_OUTPUT_ORIGINS ?? "")
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
          ),
        },
      });
    }
    if (url.pathname === "/ready" && request.method === "GET") {
      try {
        await env.DB.prepare("SELECT id FROM tenants LIMIT 1").first<{ id: string }>();
        const coordinator = env.BOT_COORDINATOR.get(env.BOT_COORDINATOR.idFromName("readiness-check"));
        const coordinatorResponse = await coordinator.fetch("https://coordinator/health");
        if (!coordinatorResponse.ok) throw new Error("Durable Object readiness failed.");
        const conversationCoordinator = env.CONVERSATION_COORDINATOR.get(
          env.CONVERSATION_COORDINATOR.idFromName("readiness-check"),
        );
        const conversationResponse = await conversationCoordinator.fetch("https://conversation-coordinator/health");
        if (!conversationResponse.ok) throw new Error("Conversation Durable Object readiness failed.");
        return Response.json({ status: "ready", runtime: "cloudflare" });
      } catch {
        return Response.json({ status: "not_ready", reason: "database_unavailable_or_unmigrated" }, { status: 503 });
      }
    }
    return new Response("Not found.", { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const d1 = repositories(env);
    const uploadedFilesService = new UploadedFilesService({
      bots: d1,
      files: new CloudflareD1UploadedFileRepository(env.DB),
      objects: objectStore(env),
      runtime: "cloudflare",
    });
    const runtimeConfig = runtimeConfigFromEnv(env);
    const runtimeLogger = createRuntimeLogger();
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
    const memoryService = createEncryptedMemoryService(d1, secretStore);
    const mcpManager = new McpManager({
      repository: d1.mcp,
      secrets: secretStore,
      secretWriter: secretStore,
      telegramGrants: d1,
      authorizationAudit: d1,
      allowedOrigins: new Set(
        env.MCP_ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    });
    const modelAllowedOrigins = new Set(
      env.MODEL_ALLOWED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
    const baseEngine = createOpenAICompatibleAgentEngine({
      conversations: d1,
      secrets: secretStore,
      retryPolicy: runtimeConfig.modelRetryPolicy,
      logger: runtimeLogger,
      tools: new DurableToolRegistry({
        registry: new CombinedToolRegistry([
          new ProviderCapabilityTools({ bots: d1, secrets: secretStore, allowedOrigins: modelAllowedOrigins }),
          new UploadedDocumentTools({ bots: d1, files: uploadedFilesService }),
          new SkillEngine({
            skills: d1.skills,
            rateLimiter: d1.skillRateLimiter,
            workflowExecutions: d1.workflowExecutions,
            nativeHandlers: nativeSkills.handlers,
            secrets: secretStore,
            secretWriter: secretStore,
            telegramGrants: d1,
            authorizationAudit: d1,
            logger: runtimeLogger,
            allowedHttpOrigins: new Set(
              env.HTTP_SKILL_ALLOWED_ORIGINS.split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            ),
          }),
          mcpManager,
        ]),
        executions: d1.toolExecutions,
        secrets: secretStore,
        secretWriter: secretStore,
      }),
      toolCalling: true,
      imageInput: String(env.MODEL_IMAGE_INPUT) === "true",
      structuredOutputOrigins: new Set(
        (env.MODEL_STRUCTURED_OUTPUT_ORIGINS ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
      allowedOrigins: modelAllowedOrigins,
    });
    const trackedEngine = createUsageTrackingAgentEngine(
      createMemoryAwareAgentEngine(baseEngine, memoryService, runtimeLogger),
      d1,
      runtimeLogger,
    );
    const engine = new CloudflareConversationAgentEngine(trackedEngine, env.CONVERSATION_COORDINATOR, runtimeLogger);
    const telegram = new TelegramManager({
      repository: d1,
      bots: d1,
      secrets: secretStore,
      engine,
      objects: objectStore(env),
      webhookBaseUrl: env.TELEGRAM_WEBHOOK_BASE_URL ?? "",
      retryPolicy: runtimeConfig.telegramRetryPolicy,
      logger: runtimeLogger,
    });
    const runner = new ScheduledTaskRunner(
      d1,
      d1,
      d1,
      engine,
      telegram,
      scheduler(env),
      undefined,
      runtimeConfig.scheduledTaskRetryPolicy,
      runtimeLogger,
    );
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

function runtimeConfigFromEnv(env: Env) {
  return parseRuntimeConfig({
    APP_ENV: env.APP_ENV,
    MODEL_RETRY_MAX_ATTEMPTS: env.MODEL_RETRY_MAX_ATTEMPTS,
    MODEL_RETRY_BACKOFF_MS: env.MODEL_RETRY_BACKOFF_MS,
    TELEGRAM_RETRY_MAX_ATTEMPTS: env.TELEGRAM_RETRY_MAX_ATTEMPTS,
    TELEGRAM_RETRY_MAX_AFTER_SECONDS: env.TELEGRAM_RETRY_MAX_AFTER_SECONDS,
    TELEGRAM_MASTER_REQUESTS_PER_MINUTE: env.TELEGRAM_MASTER_REQUESTS_PER_MINUTE,
    SCHEDULED_TASK_RETRY_MAX_ATTEMPTS: env.SCHEDULED_TASK_RETRY_MAX_ATTEMPTS,
    SCHEDULED_TASK_RETRY_BACKOFF_MS: env.SCHEDULED_TASK_RETRY_BACKOFF_MS,
    SCHEDULED_TASK_RETRY_MAX_BACKOFF_MS: env.SCHEDULED_TASK_RETRY_MAX_BACKOFF_MS,
  });
}

function createRuntimeLogger(): Logger {
  const write = (level: "info" | "warn" | "error", event: string, fields?: Readonly<Record<string, unknown>>) => {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      ...sanitizeLogFields(fields ?? {}),
      event: sanitizeLogText(event),
    });
    if (level === "info") console.info(record);
    else if (level === "warn") console.warn(record);
    else console.error(record);
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

async function serveMiniApp(request: Request, assets: Fetcher): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/miniapp") return Response.redirect(new URL("/miniapp/", url), 308);
  if (url.pathname === "/miniapp/" && (request.method === "GET" || request.method === "HEAD")) {
    return assets.fetch(new Request(new URL("/", url), request));
  }
  const asset = /^\/miniapp\/assets\/([A-Za-z0-9_-]+\.(?:js|css))$/.exec(url.pathname);
  if (asset && (request.method === "GET" || request.method === "HEAD")) {
    const fileName = asset[1];
    if (!fileName) return new Response(null, { status: 404 });
    return assets.fetch(new Request(new URL(`/assets/${fileName}`, url), request));
  }
  if (url.pathname.startsWith("/miniapp/")) return new Response("Not found.", { status: 404 });
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
