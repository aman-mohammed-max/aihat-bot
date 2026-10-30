import type { Database } from "bun:sqlite";
import {
  AppError,
  parseStoredSkillDefinition,
  parseStoredSkillInstallation,
  validateBotSettingsPatch,
  validateSkillInstallation,
  validateSkillRateLimitInput,
} from "@aihat/core";
import type {
  ApiConversationRepository,
  ApiTokenPrincipal,
  ApiTokenRecord,
  ApiTokenRepository,
  BotDraftPublisher,
  BotManagementRepository,
  BotRepository,
  BotSettingsPatch,
  ConversationRepository,
  CreationApprovalAction,
  CreationApprovalRecord,
  CreationApprovalRepository,
  CreationSessionRepository,
  EncryptedSecretRecord,
  SecretRecordRepository,
  SkillRateLimiter,
  SkillRepository,
  McpRepository,
  ScheduledTaskRepository,
  TelegramRepository,
} from "@aihat/core";
import type {
  AgentRequest,
  BotDefinition,
  BotId,
  BotVisibility,
  ConversationId,
  ConversationMessage,
  CreationAnswers,
  CreationSession,
  InstalledSkill,
  ModelConfig,
  McpDiscoveredTool,
  McpServerConnection,
  SkillDefinition,
  TenantId,
  TelegramDeployment,
  TelegramDeploymentId,
  ScheduledJob,
  ScheduledTask,
  ScheduledTaskId,
  JobId,
  UserId,
} from "@aihat/core";

interface BotRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  name: string;
  description: string;
  status: BotDefinition["status"];
  visibility: BotVisibility;
  current_version: number;
  created_at: string;
  updated_at: string;
  configuration_json: string;
}

interface ConversationRow {
  role: ConversationMessage["role"];
  content: string;
  metadata_json: string;
}

interface SessionRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  status: CreationSession["status"];
  current_step: CreationSession["currentStep"];
  answers_json: string;
  bot_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface SecretRow {
  tenant_id: string;
  reference: string;
  key_id: string;
  nonce: string;
  ciphertext: string;
  envelope_version: 1;
  created_at: string;
}

interface ApiTokenRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  scopes_json: string;
}

interface SkillRow {
  id: string;
  tenant_id: string | null;
  name: string;
  version: string;
  author: string;
  category: string;
  description: string;
  execution_type: SkillDefinition["executionType"];
  input_schema_json: string;
  output_schema_json: string;
  permissions_json: string;
  definition_json: string;
  enabled: number;
  installed_enabled?: number;
  installed_by?: string;
  installation_json?: string;
}

interface McpServerRow {
  id: string;
  tenant_id: string;
  bot_id: string;
  name: string;
  endpoint: string;
  credential_ref: string | null;
  status: McpServerConnection["status"];
  created_at: string;
  updated_at: string;
}

interface McpToolRow {
  server_id: string;
  tool_name: string;
  description: string;
  input_schema_json: string;
  output_schema_json: string | null;
  enabled: number;
  permissions_json: string;
  last_seen_at: string;
}

interface TelegramDeploymentRow {
  id: string;
  tenant_id: string;
  bot_id: string;
  external_id: string;
  credential_ref: string;
  webhook_secret_ref: string;
  status: "pending" | "active" | "disabled" | "failed";
}

interface TelegramUpdateRow {
  state: "processing" | "ready" | "completed";
  response_text: string | null;
  lease_until: string;
}

interface ScheduledTaskRow {
  id: string;
  tenant_id: string;
  bot_id: string;
  owner_id: string;
  schedule: string;
  timezone: string;
  payload_json: string;
  status: ScheduledTask["status"];
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ScheduledJobRow {
  id: string;
  tenant_id: string;
  status: ScheduledJob["status"];
  attempts: number;
  available_at: string;
  lease_until: string | null;
  payload_json: string;
}

/** Bun-specific SQLite repositories. Every read and write carries the owning tenant. */
export class BunSqliteRepositories
  implements
    BotRepository,
    BotManagementRepository,
    ConversationRepository,
    ApiConversationRepository,
    TelegramRepository,
    ScheduledTaskRepository,
    BotDraftPublisher
{
  readonly #db: Database;
  readonly sessions: CreationSessionRepository;
  readonly creationApprovals: CreationApprovalRepository;
  readonly secretRecords: SecretRecordRepository;
  readonly apiTokens: ApiTokenRepository;
  readonly skills: SkillRepository;
  readonly skillRateLimiter: SkillRateLimiter;
  readonly mcp: McpRepository;

  constructor(db: Database) {
    this.#db = db;
    this.sessions = {
      create: (session) => this.createSession(session),
      get: (tenantId, ownerId, sessionId) => this.getSession(tenantId, ownerId, sessionId),
      save: (session, expectedRevision) => this.saveSession(session, expectedRevision),
    };
    this.creationApprovals = {
      create: (record) => this.createCreationApproval(record),
      consume: (input) => this.consumeCreationApproval(input),
    };
    this.secretRecords = {
      get: (tenantId, reference) => this.getSecret(tenantId, reference),
      create: (record) => this.createSecret(record),
      delete: (tenantId, reference) => this.deleteSecret(tenantId, reference),
    };
    this.apiTokens = {
      findActive: (tokenHash, now) => this.findActiveApiToken(tokenHash, now),
      create: (record) => this.createApiToken(record),
      revoke: (tenantId, ownerId, tokenId, revokedAt) => this.revokeApiToken(tenantId, ownerId, tokenId, revokedAt),
    };
    this.skills = {
      listCatalog: (tenantId) => this.listSkillCatalog(tenantId),
      getCatalogSkill: (tenantId, skillId) => this.getCatalogSkill(tenantId, skillId),
      listInstalled: (tenantId, botId) => this.listInstalledSkills(tenantId, botId),
      install: (input) => this.installSkill(input),
      setEnabled: (input) => this.setSkillEnabled(input),
      uninstall: (input) => this.uninstallSkill(input),
    };
    this.skillRateLimiter = {
      consume: (input) => this.consumeSkillRateLimit(input),
    };
    this.mcp = {
      listServers: (tenantId, botId) => this.listMcpServers(tenantId, botId),
      getServer: (tenantId, botId, serverId) => this.getMcpServer(tenantId, botId, serverId),
      createServer: (input) => this.createMcpServer(input),
      setServerStatus: (input) => this.setMcpServerStatus(input),
      deleteServer: (input) => this.deleteMcpServer(input),
      listTools: (tenantId, botId, serverId) => this.listMcpTools(tenantId, botId, serverId),
      getTool: (tenantId, botId, serverId, toolName) => this.getMcpTool(tenantId, botId, serverId, toolName),
      replaceDiscoveredTools: (input) => this.replaceMcpTools(input),
      setToolPermission: (input) => this.setMcpToolPermission(input),
    };
  }

  async get(tenantId: TenantId, botId: BotId): Promise<BotDefinition | undefined> {
    const row = this.#db
      .query<BotRow, [string, string]>(`
      SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
             b.visibility, b.current_version, b.created_at, b.updated_at,
             v.configuration_json
      FROM bots AS b
      JOIN bot_versions AS v
        ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
      WHERE b.tenant_id = ? AND b.id = ?
    `)
      .get(tenantId, botId);
    return row ? mapBot(row) : undefined;
  }

  async listOwned(tenantId: TenantId, ownerId: UserId): Promise<readonly BotDefinition[]> {
    const rows = this.#db
      .query<BotRow, [string, string]>(`
        SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
               b.visibility, b.current_version, b.created_at, b.updated_at,
               v.configuration_json
        FROM bots AS b
        JOIN bot_versions AS v
          ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
        WHERE b.tenant_id = ? AND b.owner_id = ?
        ORDER BY b.updated_at DESC, b.id
      `)
      .all(tenantId, ownerId);
    return rows.map(mapBot);
  }

  async updateOwned(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly expectedVersion: number;
    readonly patch: BotSettingsPatch;
  }): Promise<BotDefinition> {
    const patch = validateBotSettingsPatch(input.patch);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AppError("VALIDATION_ERROR", "Expected bot version is invalid.", 400);
    }
    const update = this.#db.transaction(() => {
      const row = this.#db
        .query<BotRow, [string, string]>(`
          SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
                 b.visibility, b.current_version, b.created_at, b.updated_at,
                 v.configuration_json
          FROM bots AS b
          JOIN bot_versions AS v
            ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
          WHERE b.tenant_id = ? AND b.id = ?
        `)
        .get(input.tenantId, input.botId);
      if (!row || row.owner_id !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
      if (row.current_version !== input.expectedVersion) {
        throw new AppError("CONFLICT", "Bot changed; reload it before applying edits.", 409);
      }
      const current = mapBot(row);
      const updated: BotDefinition = {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      const createdAt = updated.updatedAt;
      this.#db
        .query(`
          INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          updated.id,
          updated.tenantId,
          updated.version,
          JSON.stringify(configurationFromBot(updated)),
          input.ownerId,
          createdAt,
        );
      const result = this.#db
        .query(`
          UPDATE bots SET name = ?, description = ?, current_version = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND owner_id = ? AND current_version = ?
        `)
        .run(
          updated.name,
          updated.description,
          updated.version,
          createdAt,
          input.tenantId,
          input.botId,
          input.ownerId,
          input.expectedVersion,
        );
      if (result.changes !== 1) throw new AppError("CONFLICT", "Bot changed; reload it before applying edits.", 409);
      return updated;
    });
    return update.immediate();
  }

  async setDisabled(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly disabled: boolean;
  }): Promise<void> {
    const row = this.#db
      .query<{ owner_id: string; status: BotDefinition["status"] }, [string, string]>(
        "SELECT owner_id, status FROM bots WHERE tenant_id = ? AND id = ?",
      )
      .get(input.tenantId, input.botId);
    if (!row || row.owner_id !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    if (row.status === "draft") throw new AppError("CONFLICT", "Draft bots cannot be enabled or disabled.", 409);
    const status = input.disabled ? "disabled" : "published";
    this.#db
      .query("UPDATE bots SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND owner_id = ?")
      .run(status, new Date().toISOString(), input.tenantId, input.botId, input.ownerId);
  }

  async deleteOwned(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<void> {
    const remove = this.#db.transaction(() => {
      const row = this.#db
        .query<{ owner_id: string }, [string, string]>("SELECT owner_id FROM bots WHERE tenant_id = ? AND id = ?")
        .get(input.tenantId, input.botId);
      if (!row || row.owner_id !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
      this.#db
        .query("UPDATE factory_sessions SET bot_id = NULL WHERE tenant_id = ? AND bot_id = ?")
        .run(input.tenantId, input.botId);
      this.#db
        .query("DELETE FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?")
        .run(input.tenantId, input.ownerId, input.botId);
    });
    remove.immediate();
  }

  async saveDraft(bot: BotDefinition): Promise<void> {
    if (bot.status !== "draft")
      throw new AppError("VALIDATION_ERROR", "Only draft bots can be saved through this operation.", 400);
    const save = this.#db.transaction(() => this.#saveDraft(bot));
    save.immediate();
  }

  async createDraft(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly idempotencyKey: string;
    readonly answers: CreationAnswers;
  }): Promise<BotId> {
    const create = this.#db.transaction((): BotId => {
      const existing = this.#db
        .query<{ id: string }, [string, string, string]>(
          "SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND creation_key = ?",
        )
        .get(input.tenantId, input.ownerId, input.idempotencyKey);
      if (existing) return existing.id as BotId;

      const now = new Date().toISOString();
      const botId = `bot_${crypto.randomUUID()}` as BotId;
      const bot: BotDefinition = {
        id: botId,
        tenantId: input.tenantId,
        ownerId: input.ownerId,
        name: input.answers.name,
        description: input.answers.description,
        systemPrompt: input.answers.personality,
        model: {
          providerId: input.answers.providerId,
          model: input.answers.model,
          endpoint: input.answers.endpoint,
          credentialRef: input.answers.credentialRef,
        },
        purpose: input.answers.purpose,
        audience: input.answers.audience,
        skills: input.answers.skills,
        mcpConnections: input.answers.mcpConnections,
        integrations: input.answers.integrations,
        memoryEnabled: input.answers.memoryEnabled,
        scheduledTasks: input.answers.scheduledTasks,
        privacySettings: input.answers.privacySettings,
        interfaces: input.answers.interfaces,
        visibility: input.answers.visibility,
        status: "draft",
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      const configuration = JSON.stringify({
        systemPrompt: bot.systemPrompt,
        model: bot.model,
        purpose: input.answers.purpose,
        audience: input.answers.audience,
        skills: input.answers.skills,
        mcpConnections: input.answers.mcpConnections,
        integrations: input.answers.integrations,
        memoryEnabled: input.answers.memoryEnabled,
        scheduledTasks: input.answers.scheduledTasks,
        privacySettings: input.answers.privacySettings,
        interfaces: input.answers.interfaces,
      });
      this.#db
        .query(`
        INSERT INTO bots (
          id, tenant_id, owner_id, name, description, status, visibility,
          current_version, creation_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', ?, 1, ?, ?, ?)
      `)
        .run(
          bot.id,
          bot.tenantId,
          bot.ownerId,
          bot.name,
          bot.description,
          bot.visibility,
          input.idempotencyKey,
          now,
          now,
        );
      this.#db
        .query(`
        INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
        VALUES (?, ?, 1, ?, ?, ?)
      `)
        .run(bot.id, bot.tenantId, configuration, bot.ownerId, now);
      return bot.id;
    });
    return create.immediate();
  }

  async publish(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly idempotencyKey: string;
  }): Promise<void> {
    const publish = this.#db.transaction(() => {
      const bot = this.#db
        .query<
          {
            status: BotDefinition["status"];
            visibility: BotVisibility;
            name: string;
            description: string;
          },
          [string, string, string]
        >(`
        SELECT status, visibility, name, description FROM bots
        WHERE tenant_id = ? AND owner_id = ? AND id = ?
      `)
        .get(input.tenantId, input.ownerId, input.botId);
      if (!bot) throw new AppError("NOT_FOUND", "Bot draft was not found.", 404);
      if (bot.status === "disabled") throw new AppError("CONFLICT", "A disabled bot cannot be published.", 409);

      if (bot.status === "draft") {
        this.#db
          .query(`
          UPDATE bots SET status = 'published', updated_at = ?
          WHERE tenant_id = ? AND owner_id = ? AND id = ? AND status = 'draft'
        `)
          .run(new Date().toISOString(), input.tenantId, input.ownerId, input.botId);
      }
      if (bot.visibility === "public") {
        const slug = `${slugify(bot.name)}-${input.botId.slice(-8).toLowerCase()}`;
        this.#db
          .query(`
          INSERT INTO public_bot_listings (bot_id, tenant_id, slug, title, summary, listed_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(bot_id) DO UPDATE SET title = excluded.title, summary = excluded.summary
        `)
          .run(input.botId, input.tenantId, slug, bot.name, bot.description, new Date().toISOString());
      }
    });
    publish.immediate();
  }

  async load(tenantId: TenantId, conversationId: ConversationId, limit: number): Promise<AgentRequest["messages"]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new AppError("VALIDATION_ERROR", "Conversation history limit must be between 1 and 1000.", 400);
    }
    const rows = this.#db
      .query<ConversationRow, [string, string, number]>(`
      SELECT role, content, metadata_json FROM (
        SELECT role, content, metadata_json, sequence
        FROM messages WHERE tenant_id = ? AND conversation_id = ?
        ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence ASC
    `)
      .all(tenantId, conversationId, limit);
    return rows.map(mapMessage);
  }

  async append(tenantId: TenantId, conversationId: ConversationId, messages: AgentRequest["messages"]): Promise<void> {
    if (messages.length === 0 || messages.length > 256) {
      throw new AppError("VALIDATION_ERROR", "A persisted conversation turn must contain 1 to 256 messages.", 400);
    }
    if (messages.some((message) => message.role === "system" || message.content.length > 100_000)) {
      throw new AppError("VALIDATION_ERROR", "Conversation message is invalid or too large.", 400);
    }
    const appendTurn = this.#db.transaction(() => {
      const conversation = this.#db
        .query<{ id: string }, [string, string]>("SELECT id FROM conversations WHERE tenant_id = ? AND id = ?")
        .get(tenantId, conversationId);
      if (!conversation) throw new AppError("NOT_FOUND", "Conversation was not found.", 404);
      const last = this.#db
        .query<{ sequence: number }, [string, string]>(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE tenant_id = ? AND conversation_id = ?",
        )
        .get(tenantId, conversationId);
      let sequence = last?.sequence ?? 0;
      const insert = this.#db.query(`
        INSERT INTO messages (id, tenant_id, conversation_id, sequence, role, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const message of messages) {
        sequence += 1;
        const metadata = JSON.stringify({
          ...(message.name ? { name: message.name } : {}),
          ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
          ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        });
        insert.run(
          `msg_${crypto.randomUUID()}`,
          tenantId,
          conversationId,
          sequence,
          message.role,
          message.content,
          metadata,
          new Date().toISOString(),
        );
      }
      this.#db
        .query("UPDATE conversations SET updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(new Date().toISOString(), tenantId, conversationId);
    });
    appendTurn.immediate();
  }

  async createConversation(input: {
    readonly id: ConversationId;
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly actorId?: UserId;
    readonly platform: "internal" | "telegram" | "web_chat" | "api";
    readonly platformConversationId: string;
  }): Promise<void> {
    const platformConversationId = input.platformConversationId.trim();
    if (!platformConversationId || platformConversationId.length > 512) {
      throw new AppError("VALIDATION_ERROR", "Platform conversation identifier is invalid.", 400);
    }
    const now = new Date().toISOString();
    try {
      this.#db
        .query(`
        INSERT INTO conversations (id, tenant_id, bot_id, actor_id, platform, platform_conversation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          input.id,
          input.tenantId,
          input.botId,
          input.actorId ?? null,
          input.platform,
          platformConversationId,
          now,
          now,
        );
    } catch (cause) {
      throw new AppError("CONFLICT", "Conversation could not be created for this tenant and bot.", 409, { cause });
    }
  }

  async getOrCreateApiConversation(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly actorId: UserId;
    readonly conversationKey: string;
  }): Promise<ConversationId> {
    const key = input.conversationKey.trim();
    if (!key || key.length > 512) {
      throw new AppError("VALIDATION_ERROR", "API conversation key is invalid.", 400);
    }
    const createOrLoad = this.#db.transaction((): ConversationId => {
      const existing = this.#db
        .query<{ id: string }, [string, string, string, string]>(`
          SELECT id FROM conversations
          WHERE tenant_id = ? AND bot_id = ? AND platform = 'api' AND platform_conversation_id = ? AND actor_id = ?
        `)
        .get(input.tenantId, input.botId, key, input.actorId);
      if (existing) return existing.id as ConversationId;
      const id = `conversation_${crypto.randomUUID()}` as ConversationId;
      const now = new Date().toISOString();
      this.#db
        .query(`
          INSERT INTO conversations (
            id, tenant_id, bot_id, actor_id, platform, platform_conversation_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'api', ?, ?, ?)
        `)
        .run(id, input.tenantId, input.botId, input.actorId, key, now, now);
      return id;
    });
    return createOrLoad.immediate();
  }

  async getTelegramDeployment(id: TelegramDeploymentId) {
    const row = this.#db
      .query<TelegramDeploymentRow, [string]>(`
        SELECT id, tenant_id, bot_id, external_id, credential_ref, webhook_secret_ref, status
        FROM bot_deployments WHERE id = ? AND interface = 'telegram'
      `)
      .get(id);
    return row ? mapTelegramDeployment(row) : undefined;
  }

  async getOwnedTelegramDeployment(input: { tenantId: TenantId; ownerId: UserId; botId: BotId }) {
    const row = this.#db
      .query<TelegramDeploymentRow, [string, string, string]>(`
        SELECT d.id, d.tenant_id, d.bot_id, d.external_id, d.credential_ref, d.webhook_secret_ref, d.status
        FROM bot_deployments AS d
        JOIN bots AS b ON b.id = d.bot_id AND b.tenant_id = d.tenant_id
        WHERE d.tenant_id = ? AND b.owner_id = ? AND d.bot_id = ?
          AND d.interface = 'telegram' AND d.status IN ('pending', 'active', 'failed')
        ORDER BY d.created_at DESC LIMIT 1
      `)
      .get(input.tenantId, input.ownerId, input.botId);
    return row ? mapTelegramDeployment(row) : undefined;
  }

  async createTelegramDeployment(input: TelegramDeployment): Promise<void> {
    try {
      this.#db
        .query(`
          INSERT INTO bot_deployments (
            id, bot_id, tenant_id, interface, status, external_id,
            credential_ref, webhook_secret_ref, configuration_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'telegram', ?, ?, ?, ?, '{}', ?, ?)
        `)
        .run(
          input.id,
          input.botId,
          input.tenantId,
          input.status,
          input.externalId,
          input.credentialRef,
          input.webhookSecretRef,
          new Date().toISOString(),
          new Date().toISOString(),
        );
    } catch (cause) {
      throw new AppError("CONFLICT", "Telegram deployment could not be created.", 409, { cause });
    }
  }

  async setTelegramDeploymentStatus(input: {
    tenantId: TenantId;
    id: TelegramDeploymentId;
    status: "pending" | "active" | "disabled" | "failed";
  }): Promise<void> {
    const result = this.#db
      .query(
        "UPDATE bot_deployments SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND interface = 'telegram'",
      )
      .run(input.status, new Date().toISOString(), input.tenantId, input.id);
    if (result.changes !== 1) throw new AppError("NOT_FOUND", "Telegram deployment was not found.", 404);
  }

  async deleteTelegramDeployment(input: { tenantId: TenantId; id: TelegramDeploymentId }): Promise<void> {
    this.#db
      .query("DELETE FROM bot_deployments WHERE tenant_id = ? AND id = ? AND interface = 'telegram'")
      .run(input.tenantId, input.id);
  }

  async getTelegramAccessPolicy(deploymentId: TelegramDeploymentId) {
    const allowedUserIds = this.#db
      .query<{ telegram_user_id: number }, [string]>(`
        SELECT telegram_user_id FROM telegram_allowed_users WHERE deployment_id = ? ORDER BY telegram_user_id
      `)
      .all(deploymentId)
      .map(({ telegram_user_id }) => telegram_user_id);
    const pendingUserIds = this.#db
      .query<{ telegram_user_id: number }, [string]>(`
        SELECT telegram_user_id FROM telegram_access_requests
        WHERE deployment_id = ? ORDER BY last_seen_at DESC LIMIT 100
      `)
      .all(deploymentId)
      .map(({ telegram_user_id }) => telegram_user_id);
    return { allowedUserIds, pendingUserIds };
  }

  async isTelegramSenderAllowed(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
  }): Promise<boolean> {
    validateTelegramUserId(input.telegramUserId);
    return Boolean(
      this.#db
        .query<{ allowed: number }, [string, number]>(`
          SELECT 1 AS allowed FROM telegram_allowed_users WHERE deployment_id = ? AND telegram_user_id = ?
        `)
        .get(input.deploymentId, input.telegramUserId),
    );
  }

  async recordTelegramAccessRequest(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
    now: string;
  }): Promise<void> {
    validateTelegramUserId(input.telegramUserId);
    const record = this.#db.transaction(() => {
      this.#db
        .query(`
        INSERT INTO telegram_access_requests (deployment_id, telegram_user_id, first_seen_at, last_seen_at, request_count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(deployment_id, telegram_user_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          request_count = telegram_access_requests.request_count + 1
      `)
        .run(input.deploymentId, input.telegramUserId, input.now, input.now);
      this.#db
        .query(`
          DELETE FROM telegram_access_requests
          WHERE deployment_id = ? AND telegram_user_id NOT IN (
            SELECT telegram_user_id FROM telegram_access_requests
            WHERE deployment_id = ? ORDER BY last_seen_at DESC, telegram_user_id LIMIT 100
          )
        `)
        .run(input.deploymentId, input.deploymentId);
    });
    record.immediate();
  }

  async replaceTelegramAllowedUsers(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserIds: readonly number[];
    now: string;
  }): Promise<void> {
    validateTelegramUserIds(input.telegramUserIds);
    const replace = this.#db.transaction(() => {
      const deployment = this.#db
        .query<{ id: string }, [string]>("SELECT id FROM bot_deployments WHERE id = ? AND interface = 'telegram'")
        .get(input.deploymentId);
      if (!deployment) throw new AppError("NOT_FOUND", "Telegram deployment was not found.", 404);
      if (input.telegramUserIds.length === 0) {
        this.#db.query("DELETE FROM telegram_allowed_users WHERE deployment_id = ?").run(input.deploymentId);
      } else {
        const placeholders = input.telegramUserIds.map(() => "?").join(", ");
        this.#db
          .query(
            `DELETE FROM telegram_allowed_users WHERE deployment_id = ? AND telegram_user_id NOT IN (${placeholders})`,
          )
          .run(input.deploymentId, ...input.telegramUserIds);
      }
      const insert = this.#db.query(
        "INSERT INTO telegram_allowed_users (deployment_id, telegram_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      );
      for (const telegramUserId of input.telegramUserIds) insert.run(input.deploymentId, telegramUserId, input.now);
      this.#db
        .query(`
          DELETE FROM telegram_access_requests WHERE deployment_id = ?
            AND telegram_user_id IN (
              SELECT telegram_user_id FROM telegram_allowed_users WHERE deployment_id = ?
            )
        `)
        .run(input.deploymentId, input.deploymentId);
    });
    replace.immediate();
  }

  async listTelegramToolGrants(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
  }): Promise<readonly string[]> {
    validateTelegramUserId(input.telegramUserId);
    return this.#db
      .query<{ tool_ref: string }, [string, number]>(`
        SELECT g.tool_ref FROM telegram_tool_grants AS g
        JOIN telegram_allowed_users AS a
          ON a.deployment_id = g.deployment_id AND a.telegram_user_id = g.telegram_user_id
        WHERE g.deployment_id = ? AND g.telegram_user_id = ? ORDER BY g.tool_ref
      `)
      .all(input.deploymentId, input.telegramUserId)
      .map(({ tool_ref }) => tool_ref);
  }

  async replaceTelegramToolGrants(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
    toolRefs: readonly string[];
    now: string;
  }): Promise<void> {
    validateTelegramUserId(input.telegramUserId);
    validateTelegramToolRefs(input.toolRefs);
    const replace = this.#db.transaction(() => {
      const allowed = this.#db
        .query<{ allowed: number }, [string, number]>(`
          SELECT 1 AS allowed FROM bot_deployments AS d
          JOIN telegram_allowed_users AS a ON a.deployment_id = d.id
          WHERE d.id = ? AND d.interface = 'telegram' AND d.status = 'active' AND a.telegram_user_id = ?
        `)
        .get(input.deploymentId, input.telegramUserId);
      if (!allowed) throw new AppError("FORBIDDEN", "Telegram tool grants require an approved sender.", 403);
      this.#db
        .query("DELETE FROM telegram_tool_grants WHERE deployment_id = ? AND telegram_user_id = ?")
        .run(input.deploymentId, input.telegramUserId);
      const insert = this.#db.query(
        "INSERT INTO telegram_tool_grants (deployment_id, telegram_user_id, tool_ref, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const toolRef of input.toolRefs) insert.run(input.deploymentId, input.telegramUserId, toolRef, input.now);
    });
    replace.immediate();
  }

  async isTelegramToolAllowed(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
    toolRef: string;
  }): Promise<boolean> {
    validateTelegramUserId(input.telegramUserId);
    return Boolean(
      this.#db
        .query<{ allowed: number }, [string, number, string]>(`
          SELECT 1 AS allowed FROM telegram_tool_grants AS g
          JOIN telegram_allowed_users AS a
            ON a.deployment_id = g.deployment_id AND a.telegram_user_id = g.telegram_user_id
          JOIN bot_deployments AS d ON d.id = g.deployment_id AND d.interface = 'telegram'
          WHERE g.deployment_id = ? AND g.telegram_user_id = ? AND g.tool_ref = ? AND d.status = 'active'
        `)
        .get(input.deploymentId, input.telegramUserId, input.toolRef),
    );
  }

  async getOrCreateTelegramConversation(input: {
    tenantId: TenantId;
    botId: BotId;
    actorId: UserId;
    conversationKey: string;
  }): Promise<ConversationId> {
    const key = input.conversationKey.trim();
    if (!key || key.length > 512) throw new AppError("VALIDATION_ERROR", "Telegram conversation key is invalid.", 400);
    const createOrLoad = this.#db.transaction((): ConversationId => {
      const existing = this.#db
        .query<{ id: string }, [string, string, string]>(`
          SELECT id FROM conversations
          WHERE tenant_id = ? AND bot_id = ? AND platform = 'telegram' AND platform_conversation_id = ?
        `)
        .get(input.tenantId, input.botId, key);
      if (existing) return existing.id as ConversationId;
      const id = `conversation_${crypto.randomUUID()}` as ConversationId;
      const now = new Date().toISOString();
      this.#db
        .query(`
          INSERT INTO conversations (
            id, tenant_id, bot_id, actor_id, platform, platform_conversation_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'telegram', ?, ?, ?)
        `)
        .run(id, input.tenantId, input.botId, input.actorId, key, now, now);
      return id;
    });
    return createOrLoad.immediate();
  }

  async reserveTelegramUpdate(input: {
    deploymentId: TelegramDeploymentId;
    updateId: number;
    leaseUntil: string;
    now: string;
  }) {
    if (!Number.isSafeInteger(input.updateId) || input.updateId < 0) {
      throw new AppError("VALIDATION_ERROR", "Telegram update identifier is invalid.", 400);
    }
    const reserve = this.#db.transaction(() => {
      const row = this.#db
        .query<TelegramUpdateRow, [string, number]>(`
          SELECT state, response_text, lease_until FROM telegram_updates WHERE deployment_id = ? AND update_id = ?
        `)
        .get(input.deploymentId, input.updateId);
      if (row?.state === "completed") return { state: "completed" as const };
      if (row && row.lease_until > input.now) return { state: "busy" as const };
      if (row?.state === "ready") {
        this.#db
          .query(
            "UPDATE telegram_updates SET lease_until = ?, updated_at = ? WHERE deployment_id = ? AND update_id = ?",
          )
          .run(input.leaseUntil, input.now, input.deploymentId, input.updateId);
        return { state: "ready" as const, responseText: row.response_text ?? "" };
      }
      if (row) {
        this.#db
          .query(`
            UPDATE telegram_updates SET state = 'processing', response_text = NULL, lease_until = ?, updated_at = ?
            WHERE deployment_id = ? AND update_id = ?
          `)
          .run(input.leaseUntil, input.now, input.deploymentId, input.updateId);
      } else {
        this.#db
          .query(`
            INSERT INTO telegram_updates (deployment_id, update_id, state, response_text, lease_until, created_at, updated_at)
            VALUES (?, ?, 'processing', NULL, ?, ?, ?)
          `)
          .run(input.deploymentId, input.updateId, input.leaseUntil, input.now, input.now);
      }
      return { state: "acquired" as const };
    });
    return reserve.immediate();
  }

  async saveTelegramUpdateResponse(input: {
    deploymentId: TelegramDeploymentId;
    updateId: number;
    responseText: string;
    leaseUntil: string;
    now: string;
  }): Promise<void> {
    if (input.responseText.length > 100_000)
      throw new AppError("VALIDATION_ERROR", "Telegram response is too large.", 400);
    const result = this.#db
      .query(`
        UPDATE telegram_updates SET state = 'ready', response_text = ?, lease_until = ?, updated_at = ?
        WHERE deployment_id = ? AND update_id = ? AND state = 'processing'
      `)
      .run(input.responseText, input.leaseUntil, input.now, input.deploymentId, input.updateId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Telegram update lease was lost.", 409);
  }

  async completeTelegramUpdate(input: {
    deploymentId: TelegramDeploymentId;
    updateId: number;
    now: string;
  }): Promise<void> {
    const result = this.#db
      .query(`
        UPDATE telegram_updates SET state = 'completed', response_text = NULL, updated_at = ?
        WHERE deployment_id = ? AND update_id = ? AND state = 'ready'
      `)
      .run(input.now, input.deploymentId, input.updateId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Telegram update could not be completed.", 409);
  }

  async releaseTelegramUpdate(input: {
    deploymentId: TelegramDeploymentId;
    updateId: number;
    now: string;
  }): Promise<void> {
    this.#db
      .query(
        "UPDATE telegram_updates SET lease_until = ?, updated_at = ? WHERE deployment_id = ? AND update_id = ? AND state != 'completed'",
      )
      .run(input.now, input.now, input.deploymentId, input.updateId);
  }

  async createScheduledTask(input: { task: ScheduledTask; firstJobId: JobId; idempotencyKey: string }): Promise<void> {
    const firstRunAt = input.task.nextRunAt;
    if (!firstRunAt) {
      throw new AppError("VALIDATION_ERROR", "Scheduled task must have a first run time.", 400);
    }
    const create = this.#db.transaction(() => {
      this.#db
        .query(`
          INSERT INTO scheduled_tasks (
            id, tenant_id, bot_id, owner_id, schedule, timezone, payload_json, status,
            next_run_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.task.id,
          input.task.tenantId,
          input.task.botId,
          input.task.ownerId,
          input.task.schedule,
          input.task.timezone,
          JSON.stringify({ prompt: input.task.prompt, notifyTelegramUserId: input.task.notifyTelegramUserId }),
          input.task.status,
          input.task.nextRunAt ?? null,
          input.task.createdAt,
          input.task.updatedAt,
        );
      this.#db
        .query(`
          INSERT INTO jobs (
            id, tenant_id, kind, status, idempotency_key, payload_json,
            attempts, available_at, lease_until, created_at, updated_at
          ) VALUES (?, ?, 'scheduled_task', 'queued', ?, ?, 0, ?, NULL, ?, ?)
        `)
        .run(
          input.firstJobId,
          input.task.tenantId,
          input.idempotencyKey,
          JSON.stringify({ taskId: input.task.id }),
          firstRunAt,
          input.task.createdAt,
          input.task.updatedAt,
        );
    });
    try {
      create.immediate();
    } catch (cause) {
      throw new AppError("CONFLICT", "Scheduled task could not be created.", 409, { cause });
    }
  }

  async getScheduledTask(input: { tenantId: TenantId; taskId: ScheduledTaskId }): Promise<ScheduledTask | undefined> {
    const row = this.#db
      .query<ScheduledTaskRow, [string, string]>(`
        SELECT id, tenant_id, bot_id, owner_id, schedule, timezone, payload_json, status,
               next_run_at, created_at, updated_at
        FROM scheduled_tasks WHERE tenant_id = ? AND id = ?
      `)
      .get(input.tenantId, input.taskId);
    return row ? mapScheduledTask(row) : undefined;
  }

  async listOwnedScheduledTasks(input: { tenantId: TenantId; ownerId: UserId; botId: BotId }) {
    const rows = this.#db
      .query<ScheduledTaskRow, [string, string, string]>(`
        SELECT id, tenant_id, bot_id, owner_id, schedule, timezone, payload_json, status,
               next_run_at, created_at, updated_at
        FROM scheduled_tasks WHERE tenant_id = ? AND owner_id = ? AND bot_id = ?
        ORDER BY created_at DESC, id
      `)
      .all(input.tenantId, input.ownerId, input.botId);
    return rows.map(mapScheduledTask);
  }

  async listDueScheduledJobIds(input: { now: string; limit: number }): Promise<readonly JobId[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new AppError("VALIDATION_ERROR", "Scheduled job batch size is invalid.", 400);
    }
    return this.#db
      .query<{ id: string }, [string, string, number]>(`
        SELECT id FROM jobs WHERE kind = 'scheduled_task' AND (
          (status IN ('queued', 'retrying') AND available_at <= ?)
          OR (status = 'running' AND lease_until <= ?)
        ) ORDER BY available_at, id LIMIT ?
      `)
      .all(input.now, input.now, input.limit)
      .map((row) => row.id as JobId);
  }

  async setScheduledTaskStatus(input: {
    tenantId: TenantId;
    ownerId: UserId;
    taskId: ScheduledTaskId;
    status: ScheduledTask["status"];
    nextRunAt?: string;
    now: string;
  }): Promise<void> {
    const setStatus = this.#db.transaction(() => {
      const result = this.#db
        .query(`
          UPDATE scheduled_tasks SET status = ?, next_run_at = COALESCE(?, next_run_at), updated_at = ?
          WHERE tenant_id = ? AND owner_id = ? AND id = ?
        `)
        .run(input.status, input.nextRunAt ?? null, input.now, input.tenantId, input.ownerId, input.taskId);
      if (result.changes !== 1) throw new AppError("NOT_FOUND", "Scheduled task was not found.", 404);
      if (input.status !== "active") {
        this.#db
          .query(`
            UPDATE jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?
            WHERE tenant_id = ? AND kind = 'scheduled_task' AND status IN ('queued', 'retrying')
              AND substr(idempotency_key, 1, length(?)) = ?
          `)
          .run(input.now, input.tenantId, `${input.taskId}:`, `${input.taskId}:`);
      }
    });
    setStatus.immediate();
  }

  async createScheduledRunJob(input: {
    tenantId: TenantId;
    taskId: ScheduledTaskId;
    jobId: JobId;
    runAt: string;
    idempotencyKey: string;
    now: string;
  }): Promise<void> {
    this.#db
      .query(`
        INSERT INTO jobs (
          id, tenant_id, kind, status, idempotency_key, payload_json,
          attempts, available_at, lease_until, created_at, updated_at
        ) VALUES (?, ?, 'scheduled_task', 'queued', ?, ?, 0, ?, NULL, ?, ?)
        ON CONFLICT(tenant_id, kind, idempotency_key) DO NOTHING
      `)
      .run(
        input.jobId,
        input.tenantId,
        input.idempotencyKey,
        JSON.stringify({ taskId: input.taskId }),
        input.runAt,
        input.now,
        input.now,
      );
  }

  async getScheduledJob(input: { jobId: JobId }): Promise<ScheduledJob | undefined> {
    const row = this.#db
      .query<ScheduledJobRow, [string]>(`
        SELECT id, tenant_id, status, attempts, available_at, lease_until, payload_json
        FROM jobs WHERE id = ? AND kind = 'scheduled_task'
      `)
      .get(input.jobId);
    if (!row) return undefined;
    const payload = parseJson<{ taskId?: unknown; resultText?: unknown }>(row.payload_json, "scheduled job payload");
    if (typeof payload.taskId !== "string" || !isScheduledTaskId(payload.taskId)) {
      throw new AppError("INTERNAL_ERROR", "Stored scheduled job task reference is invalid.", 500);
    }
    return {
      id: row.id as JobId,
      tenantId: row.tenant_id as TenantId,
      taskId: payload.taskId as ScheduledTaskId,
      status: row.status,
      attempts: row.attempts,
      availableAt: row.available_at,
      ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
      ...(typeof payload.resultText === "string" ? { resultText: payload.resultText } : {}),
    };
  }

  async claimScheduledJob(input: { jobId: JobId; now: string; leaseUntil: string }): Promise<ScheduledJob | undefined> {
    const claim = this.#db.transaction((): ScheduledJob | undefined => {
      const row = this.#db
        .query<ScheduledJobRow, [string]>(`
          SELECT id, tenant_id, status, attempts, available_at, lease_until, payload_json
          FROM jobs WHERE id = ? AND kind = 'scheduled_task'
        `)
        .get(input.jobId);
      if (!row) return undefined;
      const taskPayload = parseJson<{ taskId?: unknown; resultText?: unknown }>(
        row.payload_json,
        "scheduled job payload",
      );
      if (typeof taskPayload.taskId !== "string" || !isScheduledTaskId(taskPayload.taskId)) {
        throw new AppError("INTERNAL_ERROR", "Stored scheduled job task reference is invalid.", 500);
      }
      const due = row.available_at <= input.now;
      const queued = due && (row.status === "queued" || row.status === "retrying");
      const expired = row.status === "running" && row.lease_until !== null && row.lease_until <= input.now;
      if (!queued && !expired) return undefined;
      const updated = this.#db
        .query(`
          UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
          WHERE id = ? AND kind = 'scheduled_task'
            AND ((status IN ('queued', 'retrying') AND available_at <= ?)
              OR (status = 'running' AND lease_until <= ?))
        `)
        .run(input.leaseUntil, input.now, input.jobId, input.now, input.now);
      if (updated.changes !== 1) return undefined;
      return {
        id: row.id as JobId,
        tenantId: row.tenant_id as TenantId,
        taskId: taskPayload.taskId as ScheduledTaskId,
        status: "running",
        attempts: row.attempts + 1,
        availableAt: row.available_at,
        leaseUntil: input.leaseUntil,
        ...(typeof taskPayload.resultText === "string" ? { resultText: taskPayload.resultText } : {}),
      };
    });
    return claim.immediate();
  }

  async saveScheduledJobResult(input: { jobId: JobId; resultText: string; now: string }): Promise<void> {
    const row = this.#db
      .query<{ payload_json: string }, [string]>("SELECT payload_json FROM jobs WHERE id = ? AND status = 'running'")
      .get(input.jobId);
    if (!row) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
    const payload = parseJson<{ taskId?: unknown }>(row.payload_json, "scheduled job payload");
    if (typeof payload.taskId !== "string" || !isScheduledTaskId(payload.taskId)) {
      throw new AppError("INTERNAL_ERROR", "Stored scheduled job task reference is invalid.", 500);
    }
    const result = this.#db
      .query("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(JSON.stringify({ taskId: payload.taskId, resultText: input.resultText }), input.now, input.jobId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
  }

  async completeScheduledRun(input: {
    tenantId: TenantId;
    taskId: ScheduledTaskId;
    jobId: JobId;
    nextRunAt?: string;
    now: string;
  }): Promise<void> {
    const complete = this.#db.transaction(() => {
      const job = this.#db
        .query(`
          UPDATE jobs SET status = 'succeeded', lease_until = NULL, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'running'
        `)
        .run(input.now, input.jobId, input.tenantId);
      if (job.changes !== 1) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
      const task = this.#db
        .query<{ status: ScheduledTask["status"] }, [string, string]>(`
          SELECT status FROM scheduled_tasks WHERE tenant_id = ? AND id = ?
        `)
        .get(input.tenantId, input.taskId);
      if (!task) throw new AppError("NOT_FOUND", "Scheduled task was not found.", 404);
      if (task.status === "active") {
        this.#db
          .query(`
            UPDATE scheduled_tasks SET next_run_at = ?, status = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND status = 'active'
          `)
          .run(
            input.nextRunAt ?? null,
            input.nextRunAt ? "active" : "completed",
            input.now,
            input.tenantId,
            input.taskId,
          );
      }
    });
    complete.immediate();
  }

  async retryScheduledJob(input: { jobId: JobId; availableAt: string; now: string }): Promise<void> {
    const result = this.#db
      .query(`
        UPDATE jobs SET status = 'retrying', available_at = ?, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'
      `)
      .run(input.availableAt, input.now, input.jobId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
  }

  async failScheduledJob(input: { jobId: JobId; now: string }): Promise<void> {
    const result = this.#db
      .query(
        "UPDATE jobs SET status = 'failed', lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(input.now, input.jobId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
  }

  async createSession(session: CreationSession): Promise<void> {
    try {
      this.#db
        .query(`
        INSERT INTO factory_sessions (
          id, tenant_id, owner_id, status, current_step, answers_json,
          bot_id, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          session.id,
          session.tenantId,
          session.ownerId,
          session.status,
          session.currentStep,
          JSON.stringify(session.answers),
          session.botId ?? null,
          session.revision,
          session.createdAt,
          session.updatedAt,
        );
    } catch (cause) {
      throw new AppError("CONFLICT", "Creation session could not be created.", 409, { cause });
    }
  }

  async getSession(tenantId: TenantId, ownerId: UserId, sessionId: string): Promise<CreationSession | undefined> {
    const row = this.#db
      .query<SessionRow, [string, string, string]>(`
      SELECT id, tenant_id, owner_id, status, current_step, answers_json,
             bot_id, revision, created_at, updated_at
      FROM factory_sessions WHERE tenant_id = ? AND owner_id = ? AND id = ?
    `)
      .get(tenantId, ownerId, sessionId);
    return row ? mapSession(row) : undefined;
  }

  async saveSession(session: CreationSession, expectedRevision: number): Promise<void> {
    const result = this.#db
      .query(`
      UPDATE factory_sessions
      SET status = ?, current_step = ?, answers_json = ?, bot_id = ?, revision = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND owner_id = ? AND revision = ?
    `)
      .run(
        session.status,
        session.currentStep,
        JSON.stringify(session.answers),
        session.botId ?? null,
        session.revision,
        session.updatedAt,
        session.id,
        session.tenantId,
        session.ownerId,
        expectedRevision,
      );
    if (result.changes !== 1)
      throw new AppError("CONFLICT", "Creation session changed; reload it before continuing.", 409);
  }

  async getSecret(tenantId: TenantId, reference: string): Promise<EncryptedSecretRecord | undefined> {
    const row = this.#db
      .query<SecretRow, [string, string]>(`
      SELECT tenant_id, reference, key_id, nonce, ciphertext, envelope_version, created_at
      FROM encrypted_secrets WHERE tenant_id = ? AND reference = ?
    `)
      .get(tenantId, reference);
    return row
      ? {
          tenantId: row.tenant_id as TenantId,
          reference: row.reference,
          keyId: row.key_id,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          version: row.envelope_version,
          createdAt: row.created_at,
        }
      : undefined;
  }

  async createSecret(record: EncryptedSecretRecord): Promise<void> {
    try {
      this.#db
        .query(`
        INSERT INTO encrypted_secrets (tenant_id, reference, key_id, nonce, ciphertext, envelope_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          record.tenantId,
          record.reference,
          record.keyId,
          record.nonce,
          record.ciphertext,
          record.version,
          record.createdAt,
        );
    } catch (cause) {
      throw new AppError("CONFLICT", "Encrypted credential could not be stored.", 409, { cause });
    }
  }

  async deleteSecret(tenantId: TenantId, reference: string): Promise<void> {
    this.#db.query("DELETE FROM encrypted_secrets WHERE tenant_id = ? AND reference = ?").run(tenantId, reference);
  }

  async findActiveApiToken(tokenHash: string, now: string): Promise<ApiTokenPrincipal | undefined> {
    const row = this.#db
      .query<ApiTokenRow, [string, string]>(`
        SELECT t.id, t.tenant_id, t.owner_id, t.scopes_json
        FROM api_tokens AS t
        JOIN tenant_memberships AS m
          ON m.tenant_id = t.tenant_id AND m.user_id = t.owner_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > ?)
      `)
      .get(tokenHash, now);
    if (!row) return undefined;
    return {
      tokenId: row.id,
      tenantId: row.tenant_id as TenantId,
      ownerId: row.owner_id as UserId,
      scopes: parseScopes(row.scopes_json),
    };
  }

  async createCreationApproval(record: CreationApprovalRecord): Promise<void> {
    try {
      this.#db
        .query(`
          INSERT INTO creation_approvals (
            approval_hash, tenant_id, owner_id, session_id, action, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          record.approvalHash,
          record.tenantId,
          record.ownerId,
          record.sessionId,
          record.action,
          record.createdAt,
          record.expiresAt,
        );
    } catch (cause) {
      throw new AppError("CONFLICT", "Creation approval could not be issued.", 409, { cause });
    }
  }

  async consumeCreationApproval(input: {
    readonly approvalHash: string;
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly sessionId: string;
    readonly action: CreationApprovalAction;
    readonly now: string;
  }): Promise<boolean> {
    const result = this.#db
      .query(`
        UPDATE creation_approvals SET consumed_at = ?
        WHERE approval_hash = ? AND tenant_id = ? AND owner_id = ? AND session_id = ? AND action = ?
          AND consumed_at IS NULL AND expires_at > ?
      `)
      .run(input.now, input.approvalHash, input.tenantId, input.ownerId, input.sessionId, input.action, input.now);
    return result.changes === 1;
  }

  async listSkillCatalog(tenantId: TenantId): Promise<readonly SkillDefinition[]> {
    const rows = this.#db
      .query<SkillRow, [string]>(`
        SELECT id, tenant_id, name, version, author, category, description, execution_type,
               input_schema_json, output_schema_json, permissions_json, definition_json, enabled
        FROM skills WHERE enabled = 1 AND (tenant_id IS NULL OR tenant_id = ?)
        ORDER BY category, name, version
      `)
      .all(tenantId);
    return rows.map(mapSkillDefinition);
  }

  async listMcpServers(tenantId: TenantId, botId: BotId): Promise<readonly McpServerConnection[]> {
    const rows = this.#db
      .query<McpServerRow, [string, string]>(`
        SELECT id, tenant_id, bot_id, name, endpoint, credential_ref, status, created_at, updated_at
        FROM mcp_servers WHERE tenant_id = ? AND bot_id = ? ORDER BY created_at, id
      `)
      .all(tenantId, botId);
    return rows.map(mapMcpServer);
  }

  async getMcpServer(tenantId: TenantId, botId: BotId, serverId: string): Promise<McpServerConnection | undefined> {
    const row = this.#db
      .query<McpServerRow, [string, string, string]>(`
        SELECT id, tenant_id, bot_id, name, endpoint, credential_ref, status, created_at, updated_at
        FROM mcp_servers WHERE tenant_id = ? AND bot_id = ? AND id = ?
      `)
      .get(tenantId, botId, serverId);
    return row ? mapMcpServer(row) : undefined;
  }

  async createMcpServer(input: Parameters<McpRepository["createServer"]>[0]): Promise<void> {
    const now = new Date().toISOString();
    try {
      this.#db
        .query(`
          INSERT INTO mcp_servers (
            id, tenant_id, bot_id, name, endpoint, credential_ref, status, configuration_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'disconnected', '{}', ?, ?)
        `)
        .run(input.id, input.tenantId, input.botId, input.name, input.endpoint, input.credentialRef ?? null, now, now);
    } catch (cause) {
      throw new AppError("CONFLICT", "MCP server could not be added to this bot.", 409, { cause });
    }
  }

  async setMcpServerStatus(input: Parameters<McpRepository["setServerStatus"]>[0]): Promise<void> {
    const result = this.#db
      .query("UPDATE mcp_servers SET status = ?, updated_at = ? WHERE tenant_id = ? AND bot_id = ? AND id = ?")
      .run(input.status, new Date().toISOString(), input.tenantId, input.botId, input.serverId);
    if (result.changes !== 1) throw new AppError("NOT_FOUND", "MCP server was not found for this bot.", 404);
  }

  async deleteMcpServer(input: Parameters<McpRepository["deleteServer"]>[0]): Promise<void> {
    const result = this.#db
      .query("DELETE FROM mcp_servers WHERE tenant_id = ? AND bot_id = ? AND id = ?")
      .run(input.tenantId, input.botId, input.serverId);
    if (result.changes !== 1) throw new AppError("NOT_FOUND", "MCP server was not found for this bot.", 404);
  }

  async listMcpTools(tenantId: TenantId, botId: BotId, serverId?: string): Promise<readonly McpDiscoveredTool[]> {
    const rows = serverId
      ? this.#db
          .query<McpToolRow, [string, string, string]>(`
            SELECT server_id, tool_name, description, input_schema_json, output_schema_json,
                   enabled, permissions_json, last_seen_at
            FROM mcp_tool_permissions WHERE tenant_id = ? AND bot_id = ? AND server_id = ? ORDER BY tool_name
          `)
          .all(tenantId, botId, serverId)
      : this.#db
          .query<McpToolRow, [string, string]>(`
            SELECT server_id, tool_name, description, input_schema_json, output_schema_json,
                   enabled, permissions_json, last_seen_at
            FROM mcp_tool_permissions WHERE tenant_id = ? AND bot_id = ? ORDER BY server_id, tool_name
          `)
          .all(tenantId, botId);
    return rows.map(mapMcpTool);
  }

  async getMcpTool(
    tenantId: TenantId,
    botId: BotId,
    serverId: string,
    toolName: string,
  ): Promise<McpDiscoveredTool | undefined> {
    const row = this.#db
      .query<McpToolRow, [string, string, string, string]>(`
        SELECT server_id, tool_name, description, input_schema_json, output_schema_json,
               enabled, permissions_json, last_seen_at
        FROM mcp_tool_permissions
        WHERE tenant_id = ? AND bot_id = ? AND server_id = ? AND tool_name = ?
      `)
      .get(tenantId, botId, serverId, toolName);
    return row ? mapMcpTool(row) : undefined;
  }

  async replaceMcpTools(input: Parameters<McpRepository["replaceDiscoveredTools"]>[0]): Promise<void> {
    const replace = this.#db.transaction(() => {
      const upsert = this.#db.query(`
        INSERT INTO mcp_tool_permissions (
          tenant_id, bot_id, server_id, tool_name, enabled, permissions_json,
          description, input_schema_json, output_schema_json, last_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, '[]', ?, ?, ?, ?, ?)
        ON CONFLICT(server_id, tool_name) DO UPDATE SET
          enabled = CASE WHEN mcp_tool_permissions.input_schema_json IS excluded.input_schema_json
                              AND mcp_tool_permissions.output_schema_json IS excluded.output_schema_json
                         THEN mcp_tool_permissions.enabled ELSE 0 END,
          permissions_json = CASE WHEN mcp_tool_permissions.input_schema_json IS excluded.input_schema_json
                                       AND mcp_tool_permissions.output_schema_json IS excluded.output_schema_json
                                  THEN mcp_tool_permissions.permissions_json ELSE '[]' END,
          description = excluded.description,
          input_schema_json = excluded.input_schema_json,
          output_schema_json = excluded.output_schema_json,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `);
      for (const tool of input.tools) {
        const schema = JSON.stringify(tool.inputSchema);
        const output = tool.outputSchema === undefined ? null : JSON.stringify(tool.outputSchema);
        upsert.run(
          input.tenantId,
          input.botId,
          input.serverId,
          tool.name,
          tool.description,
          schema,
          output,
          input.discoveredAt,
          input.discoveredAt,
        );
      }
      const names = input.tools.map(({ name }) => name);
      const stale = names.length
        ? this.#db.query(`
            DELETE FROM mcp_tool_permissions
            WHERE tenant_id = ? AND bot_id = ? AND server_id = ? AND tool_name NOT IN (${names.map(() => "?").join(",")})
          `)
        : this.#db.query("DELETE FROM mcp_tool_permissions WHERE tenant_id = ? AND bot_id = ? AND server_id = ?");
      stale.run(input.tenantId, input.botId, input.serverId, ...names);
    });
    replace.immediate();
  }

  async setMcpToolPermission(input: Parameters<McpRepository["setToolPermission"]>[0]): Promise<void> {
    const result = this.#db
      .query(`
        UPDATE mcp_tool_permissions SET enabled = ?, permissions_json = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND server_id = ? AND tool_name = ?
      `)
      .run(
        Number(input.enabled),
        JSON.stringify(input.grantedPermissions),
        new Date().toISOString(),
        input.tenantId,
        input.botId,
        input.serverId,
        input.toolName,
      );
    if (result.changes !== 1) throw new AppError("NOT_FOUND", "Discovered MCP tool was not found.", 404);
  }

  async getCatalogSkill(tenantId: TenantId, skillId: string): Promise<SkillDefinition | undefined> {
    const row = this.#db
      .query<SkillRow, [string, string]>(`
        SELECT id, tenant_id, name, version, author, category, description, execution_type,
               input_schema_json, output_schema_json, permissions_json, definition_json, enabled
        FROM skills WHERE id = ? AND enabled = 1 AND (tenant_id IS NULL OR tenant_id = ?)
      `)
      .get(skillId, tenantId);
    return row ? mapSkillDefinition(row) : undefined;
  }

  async listInstalledSkills(tenantId: TenantId, botId: BotId): Promise<readonly InstalledSkill[]> {
    const rows = this.#db
      .query<SkillRow, [string, string, string]>(`
        SELECT s.id, s.tenant_id, s.name, s.version, s.author, s.category, s.description, s.execution_type,
               s.input_schema_json, s.output_schema_json, s.permissions_json, s.definition_json, s.enabled,
               i.enabled AS installed_enabled, i.installed_by, i.configuration_json AS installation_json
        FROM skill_installations AS i
        JOIN skills AS s ON s.id = i.skill_id
        WHERE i.tenant_id = ? AND i.bot_id = ? AND (s.tenant_id IS NULL OR s.tenant_id = ?)
        ORDER BY s.name, s.id
      `)
      .all(tenantId, botId, tenantId);
    return rows.map(mapInstalledSkill);
  }

  async installSkill(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly installedBy: UserId;
    readonly configuration: Readonly<Record<string, unknown>>;
    readonly grantedPermissions: readonly string[];
  }): Promise<void> {
    const definition = await this.getCatalogSkill(input.tenantId, input.skillId);
    if (!definition) throw new AppError("NOT_FOUND", "Skill was not found in this tenant's catalog.", 404);
    const validated = validateSkillInstallation(definition, input.configuration, input.grantedPermissions);
    try {
      this.#db
        .query(`
          INSERT INTO skill_installations (
            tenant_id, bot_id, skill_id, enabled, configuration_json, installed_by, installed_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?)
        `)
        .run(
          input.tenantId,
          input.botId,
          input.skillId,
          JSON.stringify({ ...validated.configuration, grantedPermissions: validated.grantedPermissions }),
          input.installedBy,
          new Date().toISOString(),
        );
    } catch (cause) {
      throw new AppError("CONFLICT", "Skill could not be installed for this bot.", 409, { cause });
    }
  }

  async setSkillEnabled(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly enabled: boolean;
  }): Promise<void> {
    const result = this.#db
      .query(`
        UPDATE skill_installations SET enabled = ?
        WHERE tenant_id = ? AND bot_id = ? AND skill_id = ?
      `)
      .run(Number(input.enabled), input.tenantId, input.botId, input.skillId);
    if (result.changes !== 1) throw new AppError("NOT_FOUND", "Installed skill was not found.", 404);
  }

  async uninstallSkill(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
  }): Promise<void> {
    const result = this.#db
      .query("DELETE FROM skill_installations WHERE tenant_id = ? AND bot_id = ? AND skill_id = ?")
      .run(input.tenantId, input.botId, input.skillId);
    if (result.changes !== 1) throw new AppError("NOT_FOUND", "Installed skill was not found.", 404);
  }

  async consumeSkillRateLimit(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly now: number;
    readonly maxRequests: number;
    readonly windowSeconds: number;
  }): Promise<boolean> {
    validateSkillRateLimitInput(input.maxRequests, input.windowSeconds, input.now);
    const windowMs = input.windowSeconds * 1000;
    const windowStart = Math.floor(input.now / windowMs) * windowMs;
    const consume = this.#db.transaction(() => {
      this.#db.query("DELETE FROM skill_rate_limit_buckets WHERE window_start < ?").run(windowStart - windowMs * 2);
      const result = this.#db
        .query(`
          INSERT INTO skill_rate_limit_buckets (tenant_id, bot_id, skill_id, window_start, request_count)
          VALUES (?, ?, ?, ?, 1)
          ON CONFLICT (tenant_id, bot_id, skill_id, window_start)
          DO UPDATE SET request_count = request_count + 1
          WHERE request_count < ?
        `)
        .run(input.tenantId, input.botId, input.skillId, windowStart, input.maxRequests);
      return result.changes === 1;
    });
    return consume.immediate();
  }

  async createApiToken(record: ApiTokenRecord): Promise<void> {
    try {
      this.#db
        .query(`
          INSERT INTO api_tokens (
            id, tenant_id, owner_id, token_hash, token_prefix, scopes_json, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          record.tokenId,
          record.tenantId,
          record.ownerId,
          record.tokenHash,
          record.tokenPrefix,
          JSON.stringify(record.scopes),
          record.createdAt,
          record.expiresAt ?? null,
        );
    } catch (cause) {
      throw new AppError("CONFLICT", "API token could not be created.", 409, { cause });
    }
  }

  async revokeApiToken(tenantId: TenantId, ownerId: UserId, tokenId: string, revokedAt: string): Promise<void> {
    this.#db
      .query(`
        UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?)
        WHERE tenant_id = ? AND owner_id = ? AND id = ?
      `)
      .run(revokedAt, tenantId, ownerId, tokenId);
  }

  close(): void {
    this.#db.close();
  }

  #saveDraft(bot: BotDefinition, creationKey?: string): void {
    const existing = this.#db
      .query<
        {
          owner_id: string;
          status: BotDefinition["status"];
          current_version: number;
          name: string;
          description: string;
          visibility: BotVisibility;
          configuration_json: string | null;
        },
        [string, string]
      >(`
      SELECT b.owner_id, b.status, b.current_version, b.name, b.description, b.visibility,
             v.configuration_json
      FROM bots AS b
      LEFT JOIN bot_versions AS v
        ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
      WHERE b.tenant_id = ? AND b.id = ?
    `)
      .get(bot.tenantId, bot.id);
    const configuration = JSON.stringify(configurationFromBot(bot));
    const now = new Date().toISOString();
    if (!existing) {
      this.#db
        .query(`
        INSERT INTO bots (
          id, tenant_id, owner_id, name, description, status, visibility,
          current_version, creation_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
      `)
        .run(
          bot.id,
          bot.tenantId,
          bot.ownerId,
          bot.name,
          bot.description,
          bot.visibility,
          bot.version,
          creationKey ?? null,
          bot.createdAt,
          now,
        );
      this.#db
        .query(`
        INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .run(bot.id, bot.tenantId, bot.version, configuration, bot.ownerId, now);
      return;
    }
    if (existing.owner_id !== bot.ownerId || existing.status !== "draft") {
      throw new AppError("FORBIDDEN", "Only the owner can update an existing draft.", 403);
    }
    if (bot.version <= existing.current_version) {
      const unchanged =
        bot.version === existing.current_version &&
        existing.configuration_json === configuration &&
        existing.name === bot.name &&
        existing.description === bot.description &&
        existing.visibility === bot.visibility;
      if (unchanged) return;
      throw new AppError("CONFLICT", "Draft changes require a new version number.", 409);
    }
    this.#db
      .query(`
      INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(bot.id, bot.tenantId, bot.version, configuration, bot.ownerId, now);
    this.#db
      .query(`
      UPDATE bots SET name = ?, description = ?, visibility = ?, current_version = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND owner_id = ? AND status = 'draft'
    `)
      .run(bot.name, bot.description, bot.visibility, bot.version, now, bot.id, bot.tenantId, bot.ownerId);
  }
}

function mapBot(row: BotRow): BotDefinition {
  const config = parseJson<{
    systemPrompt: string;
    model: ModelConfig;
    purpose?: string;
    audience?: string;
    skills?: readonly string[];
    mcpConnections?: readonly string[];
    integrations?: readonly string[];
    memoryEnabled?: boolean;
    scheduledTasks?: readonly string[];
    privacySettings?: readonly string[];
    interfaces?: BotDefinition["interfaces"];
  }>(row.configuration_json, "bot configuration");
  if (
    typeof config.systemPrompt !== "string" ||
    !config.model ||
    typeof config.model.providerId !== "string" ||
    typeof config.model.model !== "string"
  ) {
    throw new AppError("INTERNAL_ERROR", "Stored bot configuration is invalid.", 500);
  }
  return {
    id: row.id as BotId,
    tenantId: row.tenant_id as TenantId,
    ownerId: row.owner_id as UserId,
    name: row.name,
    description: row.description,
    systemPrompt: config.systemPrompt,
    model: config.model,
    ...(typeof config.purpose === "string" ? { purpose: config.purpose } : {}),
    ...(typeof config.audience === "string" ? { audience: config.audience } : {}),
    ...(Array.isArray(config.skills) ? { skills: config.skills } : {}),
    ...(Array.isArray(config.mcpConnections) ? { mcpConnections: config.mcpConnections } : {}),
    ...(Array.isArray(config.integrations) ? { integrations: config.integrations } : {}),
    ...(typeof config.memoryEnabled === "boolean" ? { memoryEnabled: config.memoryEnabled } : {}),
    ...(Array.isArray(config.scheduledTasks) ? { scheduledTasks: config.scheduledTasks } : {}),
    ...(Array.isArray(config.privacySettings) ? { privacySettings: config.privacySettings } : {}),
    ...(Array.isArray(config.interfaces) ? { interfaces: config.interfaces } : {}),
    visibility: row.visibility,
    status: row.status,
    version: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function configurationFromBot(bot: BotDefinition): Record<string, unknown> {
  return {
    systemPrompt: bot.systemPrompt,
    model: bot.model,
    ...(bot.purpose !== undefined ? { purpose: bot.purpose } : {}),
    ...(bot.audience !== undefined ? { audience: bot.audience } : {}),
    ...(bot.skills !== undefined ? { skills: bot.skills } : {}),
    ...(bot.mcpConnections !== undefined ? { mcpConnections: bot.mcpConnections } : {}),
    ...(bot.integrations !== undefined ? { integrations: bot.integrations } : {}),
    ...(bot.memoryEnabled !== undefined ? { memoryEnabled: bot.memoryEnabled } : {}),
    ...(bot.scheduledTasks !== undefined ? { scheduledTasks: bot.scheduledTasks } : {}),
    ...(bot.privacySettings !== undefined ? { privacySettings: bot.privacySettings } : {}),
    ...(bot.interfaces !== undefined ? { interfaces: bot.interfaces } : {}),
  };
}

function mapMessage(row: ConversationRow): ConversationMessage {
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, "message metadata");
  return {
    role: row.role,
    content: row.content,
    ...(typeof metadata.name === "string" ? { name: metadata.name } : {}),
    ...(typeof metadata.toolCallId === "string" ? { toolCallId: metadata.toolCallId } : {}),
    ...(Array.isArray(metadata.toolCalls)
      ? { toolCalls: metadata.toolCalls as NonNullable<ConversationMessage["toolCalls"]> }
      : {}),
  };
}

function mapSession(row: SessionRow): CreationSession {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    ownerId: row.owner_id as UserId,
    status: row.status,
    currentStep: row.current_step,
    answers: parseJson<CreationSession["answers"]>(row.answers_json, "creation session"),
    ...(row.bot_id ? { botId: row.bot_id as BotId } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSkillDefinition(row: SkillRow): SkillDefinition {
  return parseStoredSkillDefinition({
    id: row.id,
    tenantId: row.tenant_id as TenantId | null,
    name: row.name,
    version: row.version,
    author: row.author,
    category: row.category,
    description: row.description,
    executionType: row.execution_type,
    inputSchemaJson: row.input_schema_json,
    outputSchemaJson: row.output_schema_json,
    permissionsJson: row.permissions_json,
    definitionJson: row.definition_json,
    enabled: row.enabled,
  });
}

function mapInstalledSkill(row: SkillRow): InstalledSkill {
  if (typeof row.installed_by !== "string" || typeof row.installed_enabled !== "number" || !row.installation_json) {
    throw new AppError("INTERNAL_ERROR", "Stored skill installation is invalid.", 500);
  }
  return parseStoredSkillInstallation({
    id: row.id,
    tenantId: row.tenant_id as TenantId | null,
    name: row.name,
    version: row.version,
    author: row.author,
    category: row.category,
    description: row.description,
    executionType: row.execution_type,
    inputSchemaJson: row.input_schema_json,
    outputSchemaJson: row.output_schema_json,
    permissionsJson: row.permissions_json,
    definitionJson: row.definition_json,
    enabled: row.enabled,
    installedEnabled: row.installed_enabled,
    installedBy: row.installed_by,
    installationJson: row.installation_json,
  });
}

function mapMcpServer(row: McpServerRow): McpServerConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    botId: row.bot_id as BotId,
    name: row.name,
    endpoint: row.endpoint,
    ...(row.credential_ref ? { credentialRef: row.credential_ref } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMcpTool(row: McpToolRow): McpDiscoveredTool {
  const permissions: unknown = parseJson(row.permissions_json, "MCP tool permissions");
  if (!Array.isArray(permissions) || permissions.some((permission) => typeof permission !== "string")) {
    throw new AppError("INTERNAL_ERROR", "Stored MCP tool permissions are invalid.", 500);
  }
  const inputSchema = parseJson<unknown>(row.input_schema_json, "MCP input schema");
  const outputSchema = row.output_schema_json
    ? parseJson<unknown>(row.output_schema_json, "MCP output schema")
    : undefined;
  if (
    !inputSchema ||
    typeof inputSchema !== "object" ||
    Array.isArray(inputSchema) ||
    (outputSchema !== undefined && (!outputSchema || typeof outputSchema !== "object" || Array.isArray(outputSchema)))
  ) {
    throw new AppError("INTERNAL_ERROR", "Stored MCP tool schema is invalid.", 500);
  }
  return {
    serverId: row.server_id,
    name: row.tool_name,
    description: row.description,
    inputSchema: inputSchema as Readonly<Record<string, unknown>>,
    ...(outputSchema ? { outputSchema: outputSchema as Readonly<Record<string, unknown>> } : {}),
    enabled: row.enabled === 1,
    grantedPermissions: permissions as string[],
    lastSeenAt: row.last_seen_at,
  };
}

function mapTelegramDeployment(row: TelegramDeploymentRow): TelegramDeployment {
  return {
    id: row.id as TelegramDeploymentId,
    tenantId: row.tenant_id as TenantId,
    botId: row.bot_id as BotId,
    externalId: row.external_id,
    credentialRef: row.credential_ref,
    webhookSecretRef: row.webhook_secret_ref,
    status: row.status,
  };
}

function mapScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  const payload = parseJson<{ prompt?: unknown; notifyTelegramUserId?: unknown }>(
    row.payload_json,
    "scheduled task payload",
  );
  if (
    typeof payload.prompt !== "string" ||
    !Number.isSafeInteger(payload.notifyTelegramUserId) ||
    Number(payload.notifyTelegramUserId) < 1
  ) {
    throw new AppError("INTERNAL_ERROR", "Stored scheduled task prompt is invalid.", 500);
  }
  return {
    id: row.id as ScheduledTaskId,
    tenantId: row.tenant_id as TenantId,
    botId: row.bot_id as BotId,
    ownerId: row.owner_id as UserId,
    schedule: row.schedule,
    timezone: row.timezone,
    prompt: payload.prompt,
    notifyTelegramUserId: payload.notifyTelegramUserId as number,
    status: row.status,
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isScheduledTaskId(value: string): boolean {
  return /^task_[a-f0-9]{32}$/.test(value);
}

function validateTelegramUserId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError("VALIDATION_ERROR", "Telegram user ID must be a positive safe integer.", 400);
  }
}

function validateTelegramUserIds(values: readonly number[]): void {
  if (values.length > 100 || new Set(values).size !== values.length) {
    throw new AppError("VALIDATION_ERROR", "Telegram allowlist must contain up to 100 unique user IDs.", 400);
  }
  for (const value of values) validateTelegramUserId(value);
}

function validateTelegramToolRefs(values: readonly string[]): void {
  if (values.length > 100 || new Set(values).size !== values.length) {
    throw new AppError("VALIDATION_ERROR", "Telegram tool grants must contain up to 100 unique references.", 400);
  }
  for (const value of values) {
    const skill = /^skill:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(value);
    const mcp = /^mcp:(mcp_[A-Za-z0-9_-]{1,100}):(.{1,128})$/.exec(value);
    if (!skill && !mcp) throw new AppError("VALIDATION_ERROR", "Telegram tool grant reference is invalid.", 400);
    if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new AppError("VALIDATION_ERROR", "Telegram tool grant reference is invalid.", 400);
    }
  }
}

function parseScopes(scopesJson: string): readonly string[] {
  const scopes: unknown = JSON.parse(scopesJson);
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
    throw new AppError("INTERNAL_ERROR", "API token scopes are corrupted.", 500);
  }
  return scopes;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", `Stored ${label} is invalid JSON.`, 500, { cause });
  }
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "bot";
}
