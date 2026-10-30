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
  BotDefinition,
  BotDraftPublisher,
  BotManagementRepository,
  BotId,
  BotRepository,
  BotSettingsPatch,
  BotVisibility,
  ConversationId,
  ConversationMessage,
  ConversationRepository,
  CreationApprovalAction,
  CreationApprovalRecord,
  CreationApprovalRepository,
  CreationAnswers,
  CreationSession,
  CreationSessionRepository,
  EncryptedSecretRecord,
  SecretRecordRepository,
  SkillRateLimiter,
  SkillRepository,
  McpRepository,
  ScheduledTaskRepository,
  TenantId,
  UserId,
  InstalledSkill,
  SkillDefinition,
  McpDiscoveredTool,
  McpServerConnection,
  TelegramDeployment,
  TelegramDeploymentId,
  TelegramRepository,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledJob,
  JobId,
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

interface MessageRow {
  role: ConversationMessage["role"];
  content: string;
  metadata_json: string;
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
  status: TelegramDeployment["status"];
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

/** D1 implementation of the same tenant-scoped contracts used by Bun SQLite. */
export class CloudflareD1Repositories
  implements
    BotRepository,
    BotManagementRepository,
    ConversationRepository,
    ApiConversationRepository,
    TelegramRepository,
    ScheduledTaskRepository,
    BotDraftPublisher
{
  readonly sessions: CreationSessionRepository;
  readonly creationApprovals: CreationApprovalRepository;
  readonly secretRecords: SecretRecordRepository;
  readonly apiTokens: ApiTokenRepository;
  readonly skills: SkillRepository;
  readonly skillRateLimiter: SkillRateLimiter;
  readonly mcp: McpRepository;

  constructor(private readonly db: D1Database) {
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
    const row = await this.db
      .prepare(`
        SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
               b.visibility, b.current_version, b.created_at, b.updated_at,
               v.configuration_json
        FROM bots AS b
        JOIN bot_versions AS v
          ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
        WHERE b.tenant_id = ? AND b.id = ?
      `)
      .bind(tenantId, botId)
      .first<BotRow>();
    return row ? mapBot(row) : undefined;
  }

  async listOwned(tenantId: TenantId, ownerId: UserId): Promise<readonly BotDefinition[]> {
    const result = await this.db
      .prepare(`
        SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
               b.visibility, b.current_version, b.created_at, b.updated_at,
               v.configuration_json
        FROM bots AS b
        JOIN bot_versions AS v
          ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
        WHERE b.tenant_id = ? AND b.owner_id = ?
        ORDER BY b.updated_at DESC, b.id
      `)
      .bind(tenantId, ownerId)
      .all<BotRow>();
    return result.results.map(mapBot);
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
    const current = await this.get(input.tenantId, input.botId);
    if (!current || current.ownerId !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    if (current.version !== input.expectedVersion) {
      throw new AppError("CONFLICT", "Bot changed; reload it before applying edits.", 409);
    }
    const updated: BotDefinition = {
      ...current,
      ...patch,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const results = await this.db.batch([
      this.db
        .prepare(`
          INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
          SELECT ?, ?, ?, ?, ?, ? FROM bots
          WHERE tenant_id = ? AND id = ? AND owner_id = ? AND current_version = ?
        `)
        .bind(
          updated.id,
          updated.tenantId,
          updated.version,
          JSON.stringify(configurationFromBot(updated)),
          input.ownerId,
          updated.updatedAt,
          input.tenantId,
          input.botId,
          input.ownerId,
          input.expectedVersion,
        ),
      this.db
        .prepare(`
          UPDATE bots SET name = ?, description = ?, current_version = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND owner_id = ? AND current_version = ?
        `)
        .bind(
          updated.name,
          updated.description,
          updated.version,
          updated.updatedAt,
          input.tenantId,
          input.botId,
          input.ownerId,
          input.expectedVersion,
        ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new AppError("CONFLICT", "Bot changed; reload it before applying edits.", 409);
    }
    return updated;
  }

  async setDisabled(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly disabled: boolean;
  }): Promise<void> {
    const current = await this.get(input.tenantId, input.botId);
    if (!current || current.ownerId !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    if (current.status === "draft") throw new AppError("CONFLICT", "Draft bots cannot be enabled or disabled.", 409);
    const status = input.disabled ? "disabled" : "published";
    if (current.status === status) return;
    const result = await this.db
      .prepare(`
        UPDATE bots SET status = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND owner_id = ? AND status = ?
      `)
      .bind(status, new Date().toISOString(), input.tenantId, input.botId, input.ownerId, current.status)
      .run();
    if (result.meta.changes !== 1)
      throw new AppError("CONFLICT", "Bot changed; reload it before changing status.", 409);
  }

  async deleteOwned(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<void> {
    const owner = await this.db
      .prepare("SELECT owner_id FROM bots WHERE tenant_id = ? AND id = ?")
      .bind(input.tenantId, input.botId)
      .first<{ owner_id: string }>();
    if (!owner || owner.owner_id !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    const results = await this.db.batch([
      this.db
        .prepare("UPDATE factory_sessions SET bot_id = NULL WHERE tenant_id = ? AND bot_id = ?")
        .bind(input.tenantId, input.botId),
      this.db
        .prepare("DELETE FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?")
        .bind(input.tenantId, input.ownerId, input.botId),
    ]);
    if (results[1]?.meta.changes !== 1) throw new AppError("CONFLICT", "Bot changed before it could be deleted.", 409);
  }

  async saveDraft(bot: BotDefinition): Promise<void> {
    if (bot.status !== "draft") {
      throw new AppError("VALIDATION_ERROR", "Only draft bots can be saved through this operation.", 400);
    }
    const existing = await this.db
      .prepare(`
        SELECT b.owner_id, b.status, b.current_version, v.configuration_json
        FROM bots AS b LEFT JOIN bot_versions AS v
          ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
        WHERE b.tenant_id = ? AND b.id = ?
      `)
      .bind(bot.tenantId, bot.id)
      .first<{
        owner_id: string;
        status: BotDefinition["status"];
        current_version: number;
        configuration_json: string | null;
      }>();
    const now = new Date().toISOString();
    const configuration = JSON.stringify(configurationFromBot(bot));
    if (!existing) {
      await this.db.batch([
        this.db
          .prepare(`
            INSERT INTO bots (
              id, tenant_id, owner_id, name, description, status, visibility,
              current_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
          `)
          .bind(
            bot.id,
            bot.tenantId,
            bot.ownerId,
            bot.name,
            bot.description,
            bot.visibility,
            bot.version,
            bot.createdAt,
            now,
          ),
        this.db
          .prepare(`
            INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .bind(bot.id, bot.tenantId, bot.version, configuration, bot.ownerId, now),
      ]);
      return;
    }
    if (existing.owner_id !== bot.ownerId || existing.status !== "draft") {
      throw new AppError("FORBIDDEN", "Only the owner can update an existing draft.", 403);
    }
    if (bot.version <= existing.current_version) {
      if (bot.version === existing.current_version && existing.configuration_json === configuration) {
        return;
      }
      throw new AppError("CONFLICT", "Draft changes require a new version number.", 409);
    }
    const [inserted, updated] = await this.db.batch([
      this.db
        .prepare(`
          INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
          SELECT ?, ?, ?, ?, ?, ? FROM bots
          WHERE tenant_id = ? AND id = ? AND owner_id = ? AND status = 'draft' AND current_version = ?
        `)
        .bind(
          bot.id,
          bot.tenantId,
          bot.version,
          configuration,
          bot.ownerId,
          now,
          bot.tenantId,
          bot.id,
          bot.ownerId,
          existing.current_version,
        ),
      this.db
        .prepare(`
          UPDATE bots SET name = ?, description = ?, visibility = ?, current_version = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND owner_id = ? AND status = 'draft' AND current_version = ?
        `)
        .bind(
          bot.name,
          bot.description,
          bot.visibility,
          bot.version,
          now,
          bot.tenantId,
          bot.id,
          bot.ownerId,
          existing.current_version,
        ),
    ]);
    if (inserted?.meta.changes !== 1 || updated?.meta.changes !== 1) {
      throw new AppError("CONFLICT", "Draft changed; reload it before saving a new version.", 409);
    }
  }

  async createDraft(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly idempotencyKey: string;
    readonly answers: CreationAnswers;
  }): Promise<BotId> {
    const existing = await this.db
      .prepare("SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND creation_key = ?")
      .bind(input.tenantId, input.ownerId, input.idempotencyKey)
      .first<{ id: string }>();
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
    try {
      await this.db.batch([
        this.db
          .prepare(`
            INSERT INTO bots (
              id, tenant_id, owner_id, name, description, status, visibility,
              current_version, creation_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'draft', ?, 1, ?, ?, ?)
          `)
          .bind(
            bot.id,
            bot.tenantId,
            bot.ownerId,
            bot.name,
            bot.description,
            bot.visibility,
            input.idempotencyKey,
            now,
            now,
          ),
        this.db
          .prepare(`
            INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
            VALUES (?, ?, 1, ?, ?, ?)
          `)
          .bind(bot.id, bot.tenantId, JSON.stringify(configurationFromBot(bot)), bot.ownerId, now),
      ]);
      return bot.id;
    } catch (cause) {
      const raced = await this.db
        .prepare("SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND creation_key = ?")
        .bind(input.tenantId, input.ownerId, input.idempotencyKey)
        .first<{ id: string }>();
      if (raced) return raced.id as BotId;
      throw new AppError("CONFLICT", "Bot draft could not be created.", 409, { cause });
    }
  }

  async publish(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly idempotencyKey: string;
  }): Promise<void> {
    const bot = await this.db
      .prepare(`
        SELECT status, visibility, name, description FROM bots
        WHERE tenant_id = ? AND owner_id = ? AND id = ?
      `)
      .bind(input.tenantId, input.ownerId, input.botId)
      .first<{
        status: BotDefinition["status"];
        visibility: BotVisibility;
        name: string;
        description: string;
      }>();
    if (!bot) throw new AppError("NOT_FOUND", "Bot draft was not found.", 404);
    if (bot.status === "disabled") throw new AppError("CONFLICT", "A disabled bot cannot be published.", 409);

    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    if (bot.status === "draft") {
      statements.push(
        this.db
          .prepare(`
            UPDATE bots SET status = 'published', updated_at = ?
            WHERE tenant_id = ? AND owner_id = ? AND id = ? AND status = 'draft'
          `)
          .bind(now, input.tenantId, input.ownerId, input.botId),
      );
    }
    if (bot.visibility === "public") {
      const slug = `${slugify(bot.name)}-${input.botId.slice(-8).toLowerCase()}`;
      statements.push(
        this.db
          .prepare(`
            INSERT INTO public_bot_listings (bot_id, tenant_id, slug, title, summary, listed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(bot_id) DO UPDATE SET title = excluded.title, summary = excluded.summary
          `)
          .bind(input.botId, input.tenantId, slug, bot.name, bot.description, now),
      );
    }
    if (statements.length > 0) {
      try {
        await this.db.batch(statements);
      } catch (cause) {
        throw new AppError("CONFLICT", "Bot could not be published.", 409, { cause });
      }
    }
  }

  async load(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
  ): Promise<readonly ConversationMessage[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new AppError("VALIDATION_ERROR", "Conversation history limit must be between 1 and 1000.", 400);
    }
    const result = await this.db
      .prepare(`
        SELECT role, content, metadata_json FROM (
          SELECT role, content, metadata_json, sequence FROM messages
          WHERE tenant_id = ? AND conversation_id = ? ORDER BY sequence DESC LIMIT ?
        ) ORDER BY sequence ASC
      `)
      .bind(tenantId, conversationId, limit)
      .all<MessageRow>();
    return result.results.map(mapMessage);
  }

  async append(
    tenantId: TenantId,
    conversationId: ConversationId,
    messages: readonly ConversationMessage[],
  ): Promise<void> {
    if (
      messages.length === 0 ||
      messages.length > 256 ||
      messages.some((message) => message.role === "system" || message.content.length > 100_000)
    ) {
      throw new AppError("VALIDATION_ERROR", "Conversation turn is invalid or too large.", 400);
    }
    const now = new Date().toISOString();
    const statements = messages.map((message) => {
      const metadata = JSON.stringify({
        ...(message.name ? { name: message.name } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      });
      return this.db
        .prepare(`
          INSERT INTO messages (
            id, tenant_id, conversation_id, sequence, role, content, metadata_json, created_at
          )
          SELECT ?, ?, ?,
            (SELECT COALESCE(MAX(sequence), 0) + 1 FROM messages
             WHERE tenant_id = ? AND conversation_id = ?),
            ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM conversations WHERE tenant_id = ? AND id = ?)
        `)
        .bind(
          `msg_${crypto.randomUUID()}`,
          tenantId,
          conversationId,
          tenantId,
          conversationId,
          message.role,
          message.content,
          metadata,
          now,
          tenantId,
          conversationId,
        );
    });
    const update = this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE tenant_id = ? AND id = ?")
      .bind(now, tenantId, conversationId);
    const results = await this.db.batch([...statements, update]);
    if (results.slice(0, statements.length).some((result) => result.meta.changes !== 1)) {
      const exists = await this.db
        .prepare("SELECT 1 AS found FROM conversations WHERE tenant_id = ? AND id = ?")
        .bind(tenantId, conversationId)
        .first<{ found: number }>();
      if (!exists) throw new AppError("NOT_FOUND", "Conversation was not found.", 404);
      throw new AppError("CONFLICT", "Conversation turn could not be committed atomically.", 409);
    }
  }

  async createConversation(input: {
    readonly id: ConversationId;
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly actorId?: UserId;
    readonly platform: "internal" | "telegram" | "web_chat" | "api";
    readonly platformConversationId: string;
  }): Promise<void> {
    const externalId = input.platformConversationId.trim();
    if (!externalId || externalId.length > 512) {
      throw new AppError("VALIDATION_ERROR", "Platform conversation identifier is invalid.", 400);
    }
    const now = new Date().toISOString();
    try {
      await this.db
        .prepare(`
          INSERT INTO conversations (
            id, tenant_id, bot_id, actor_id, platform, platform_conversation_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(input.id, input.tenantId, input.botId, input.actorId ?? null, input.platform, externalId, now, now)
        .run();
    } catch (cause) {
      throw new AppError("CONFLICT", "Conversation could not be created for this tenant and bot.", 409, {
        cause,
      });
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
    const existing = await this.db
      .prepare(`
        SELECT id FROM conversations
        WHERE tenant_id = ? AND bot_id = ? AND platform = 'api' AND platform_conversation_id = ? AND actor_id = ?
      `)
      .bind(input.tenantId, input.botId, key, input.actorId)
      .first<{ id: string }>();
    if (existing) return existing.id as ConversationId;

    const now = new Date().toISOString();
    try {
      await this.db
        .prepare(`
          INSERT INTO conversations (
            id, tenant_id, bot_id, actor_id, platform, platform_conversation_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'api', ?, ?, ?)
          ON CONFLICT(tenant_id, bot_id, platform, platform_conversation_id) DO NOTHING
        `)
        .bind(`conversation_${crypto.randomUUID()}`, input.tenantId, input.botId, input.actorId, key, now, now)
        .run();
    } catch (cause) {
      throw new AppError("CONFLICT", "API conversation could not be created.", 409, { cause });
    }
    const created = await this.db
      .prepare(`
        SELECT id FROM conversations
        WHERE tenant_id = ? AND bot_id = ? AND platform = 'api' AND platform_conversation_id = ? AND actor_id = ?
      `)
      .bind(input.tenantId, input.botId, key, input.actorId)
      .first<{ id: string }>();
    if (!created) throw new AppError("CONFLICT", "API conversation could not be loaded after creation.", 409);
    return created.id as ConversationId;
  }

  async getTelegramDeployment(id: TelegramDeploymentId) {
    const row = await this.db
      .prepare(`
        SELECT id, tenant_id, bot_id, external_id, credential_ref, webhook_secret_ref, status
        FROM bot_deployments WHERE id = ? AND interface = 'telegram'
      `)
      .bind(id)
      .first<TelegramDeploymentRow>();
    return row ? mapTelegramDeployment(row) : undefined;
  }

  async getOwnedTelegramDeployment(input: { tenantId: TenantId; ownerId: UserId; botId: BotId }) {
    const row = await this.db
      .prepare(`
        SELECT d.id, d.tenant_id, d.bot_id, d.external_id, d.credential_ref, d.webhook_secret_ref, d.status
        FROM bot_deployments AS d
        JOIN bots AS b ON b.id = d.bot_id AND b.tenant_id = d.tenant_id
        WHERE d.tenant_id = ? AND b.owner_id = ? AND d.bot_id = ?
          AND d.interface = 'telegram' AND d.status IN ('pending', 'active', 'failed')
        ORDER BY d.created_at DESC LIMIT 1
      `)
      .bind(input.tenantId, input.ownerId, input.botId)
      .first<TelegramDeploymentRow>();
    return row ? mapTelegramDeployment(row) : undefined;
  }

  async createTelegramDeployment(input: TelegramDeployment): Promise<void> {
    try {
      await this.db
        .prepare(`
          INSERT INTO bot_deployments (
            id, bot_id, tenant_id, interface, status, external_id,
            credential_ref, webhook_secret_ref, configuration_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'telegram', ?, ?, ?, ?, '{}', ?, ?)
        `)
        .bind(
          input.id,
          input.botId,
          input.tenantId,
          input.status,
          input.externalId,
          input.credentialRef,
          input.webhookSecretRef,
          new Date().toISOString(),
          new Date().toISOString(),
        )
        .run();
    } catch {
      throw new AppError("CONFLICT", "Telegram deployment could not be created.", 409);
    }
  }

  async setTelegramDeploymentStatus(input: {
    tenantId: TenantId;
    id: TelegramDeploymentId;
    status: TelegramDeployment["status"];
  }): Promise<void> {
    const result = await this.db
      .prepare(
        "UPDATE bot_deployments SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND interface = 'telegram'",
      )
      .bind(input.status, new Date().toISOString(), input.tenantId, input.id)
      .run();
    if (result.meta.changes !== 1) throw new AppError("NOT_FOUND", "Telegram deployment was not found.", 404);
  }

  async deleteTelegramDeployment(input: { tenantId: TenantId; id: TelegramDeploymentId }): Promise<void> {
    await this.db
      .prepare("DELETE FROM bot_deployments WHERE tenant_id = ? AND id = ? AND interface = 'telegram'")
      .bind(input.tenantId, input.id)
      .run();
  }

  async getTelegramAccessPolicy(deploymentId: TelegramDeploymentId) {
    const [allowedResult, pendingResult] = await Promise.all([
      this.db
        .prepare(
          "SELECT telegram_user_id FROM telegram_allowed_users WHERE deployment_id = ? ORDER BY telegram_user_id",
        )
        .bind(deploymentId)
        .all<{ telegram_user_id: number }>(),
      this.db
        .prepare(`
          SELECT telegram_user_id FROM telegram_access_requests
          WHERE deployment_id = ? ORDER BY last_seen_at DESC LIMIT 100
        `)
        .bind(deploymentId)
        .all<{ telegram_user_id: number }>(),
    ]);
    return {
      allowedUserIds: allowedResult.results.map(({ telegram_user_id }) => telegram_user_id),
      pendingUserIds: pendingResult.results.map(({ telegram_user_id }) => telegram_user_id),
    };
  }

  async isTelegramSenderAllowed(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
  }): Promise<boolean> {
    validateTelegramUserId(input.telegramUserId);
    const row = await this.db
      .prepare("SELECT 1 AS allowed FROM telegram_allowed_users WHERE deployment_id = ? AND telegram_user_id = ?")
      .bind(input.deploymentId, input.telegramUserId)
      .first<{ allowed: number }>();
    return row !== null;
  }

  async recordTelegramAccessRequest(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
    now: string;
  }): Promise<void> {
    validateTelegramUserId(input.telegramUserId);
    await this.db.batch([
      this.db
        .prepare(`
        INSERT INTO telegram_access_requests (deployment_id, telegram_user_id, first_seen_at, last_seen_at, request_count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(deployment_id, telegram_user_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          request_count = telegram_access_requests.request_count + 1
      `)
        .bind(input.deploymentId, input.telegramUserId, input.now, input.now),
      this.db
        .prepare(`
        DELETE FROM telegram_access_requests
        WHERE deployment_id = ? AND telegram_user_id NOT IN (
          SELECT telegram_user_id FROM telegram_access_requests
          WHERE deployment_id = ? ORDER BY last_seen_at DESC, telegram_user_id LIMIT 100
        )
      `)
        .bind(input.deploymentId, input.deploymentId),
    ]);
  }

  async replaceTelegramAllowedUsers(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserIds: readonly number[];
    now: string;
  }): Promise<void> {
    validateTelegramUserIds(input.telegramUserIds);
    const deployment = await this.db
      .prepare("SELECT id FROM bot_deployments WHERE id = ? AND interface = 'telegram'")
      .bind(input.deploymentId)
      .first<{ id: string }>();
    if (!deployment) throw new AppError("NOT_FOUND", "Telegram deployment was not found.", 404);
    const statements = [
      this.db.prepare("DELETE FROM telegram_allowed_users WHERE deployment_id = ?").bind(input.deploymentId),
      ...input.telegramUserIds.map((telegramUserId) =>
        this.db
          .prepare("INSERT INTO telegram_allowed_users (deployment_id, telegram_user_id, created_at) VALUES (?, ?, ?)")
          .bind(input.deploymentId, telegramUserId, input.now),
      ),
      this.db
        .prepare(`
          DELETE FROM telegram_access_requests WHERE deployment_id = ?
            AND telegram_user_id IN (
              SELECT telegram_user_id FROM telegram_allowed_users WHERE deployment_id = ?
            )
        `)
        .bind(input.deploymentId, input.deploymentId),
    ];
    try {
      await this.db.batch(statements);
    } catch {
      throw new AppError("CONFLICT", "Telegram sender access could not be updated.", 409);
    }
  }

  async getOrCreateTelegramConversation(input: {
    tenantId: TenantId;
    botId: BotId;
    actorId: UserId;
    conversationKey: string;
  }): Promise<ConversationId> {
    const key = input.conversationKey.trim();
    if (!key || key.length > 512) throw new AppError("VALIDATION_ERROR", "Telegram conversation key is invalid.", 400);
    const now = new Date().toISOString();
    await this.db
      .prepare(`
        INSERT INTO conversations (
          id, tenant_id, bot_id, actor_id, platform, platform_conversation_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'telegram', ?, ?, ?)
        ON CONFLICT(tenant_id, bot_id, platform, platform_conversation_id) DO NOTHING
      `)
      .bind(`conversation_${crypto.randomUUID()}`, input.tenantId, input.botId, input.actorId, key, now, now)
      .run();
    const created = await this.db
      .prepare(`
        SELECT id FROM conversations
        WHERE tenant_id = ? AND bot_id = ? AND platform = 'telegram' AND platform_conversation_id = ?
      `)
      .bind(input.tenantId, input.botId, key)
      .first<{ id: string }>();
    if (!created) throw new AppError("CONFLICT", "Telegram conversation could not be loaded after creation.", 409);
    return created.id as ConversationId;
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
    const result = await this.db
      .prepare(`
        INSERT INTO telegram_updates (deployment_id, update_id, state, response_text, lease_until, created_at, updated_at)
        VALUES (?, ?, 'processing', NULL, ?, ?, ?)
        ON CONFLICT(deployment_id, update_id) DO UPDATE SET
          state = CASE WHEN telegram_updates.state = 'ready' THEN 'ready' ELSE 'processing' END,
          response_text = CASE WHEN telegram_updates.state = 'ready' THEN telegram_updates.response_text ELSE NULL END,
          lease_until = excluded.lease_until,
          updated_at = excluded.updated_at
        WHERE telegram_updates.state != 'completed' AND telegram_updates.lease_until <= ?
      `)
      .bind(input.deploymentId, input.updateId, input.leaseUntil, input.now, input.now, input.now)
      .run();
    const row = await this.db
      .prepare(
        "SELECT state, response_text, lease_until FROM telegram_updates WHERE deployment_id = ? AND update_id = ?",
      )
      .bind(input.deploymentId, input.updateId)
      .first<TelegramUpdateRow>();
    if (!row) throw new AppError("CONFLICT", "Telegram update reservation failed.", 409);
    if (row.state === "completed") return { state: "completed" as const };
    if (result.meta.changes === 0 || row.lease_until !== input.leaseUntil) return { state: "busy" as const };
    if (row.state === "ready") return { state: "ready" as const, responseText: row.response_text ?? "" };
    return { state: "acquired" as const };
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
    const result = await this.db
      .prepare(`
        UPDATE telegram_updates SET state = 'ready', response_text = ?, lease_until = ?, updated_at = ?
        WHERE deployment_id = ? AND update_id = ? AND state = 'processing'
      `)
      .bind(input.responseText, input.leaseUntil, input.now, input.deploymentId, input.updateId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("CONFLICT", "Telegram update lease was lost.", 409);
  }

  async completeTelegramUpdate(input: {
    deploymentId: TelegramDeploymentId;
    updateId: number;
    now: string;
  }): Promise<void> {
    const result = await this.db
      .prepare(`
        UPDATE telegram_updates SET state = 'completed', response_text = NULL, updated_at = ?
        WHERE deployment_id = ? AND update_id = ? AND state = 'ready'
      `)
      .bind(input.now, input.deploymentId, input.updateId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("CONFLICT", "Telegram update could not be completed.", 409);
  }

  async releaseTelegramUpdate(input: {
    deploymentId: TelegramDeploymentId;
    updateId: number;
    now: string;
  }): Promise<void> {
    await this.db
      .prepare(
        "UPDATE telegram_updates SET lease_until = ?, updated_at = ? WHERE deployment_id = ? AND update_id = ? AND state != 'completed'",
      )
      .bind(input.now, input.now, input.deploymentId, input.updateId)
      .run();
  }

  async createScheduledTask(input: { task: ScheduledTask; firstJobId: JobId; idempotencyKey: string }): Promise<void> {
    const firstRunAt = input.task.nextRunAt;
    if (!firstRunAt) {
      throw new AppError("VALIDATION_ERROR", "Scheduled task must have a first run time.", 400);
    }
    try {
      await this.db.batch([
        this.db
          .prepare(`
            INSERT INTO scheduled_tasks (
              id, tenant_id, bot_id, owner_id, schedule, timezone, payload_json, status,
              next_run_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
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
          ),
        this.db
          .prepare(`
            INSERT INTO jobs (
              id, tenant_id, kind, status, idempotency_key, payload_json,
              attempts, available_at, lease_until, created_at, updated_at
            ) VALUES (?, ?, 'scheduled_task', 'queued', ?, ?, 0, ?, NULL, ?, ?)
          `)
          .bind(
            input.firstJobId,
            input.task.tenantId,
            input.idempotencyKey,
            JSON.stringify({ taskId: input.task.id }),
            firstRunAt,
            input.task.createdAt,
            input.task.updatedAt,
          ),
      ]);
    } catch {
      throw new AppError("CONFLICT", "Scheduled task could not be created.", 409);
    }
  }

  async getScheduledTask(input: { tenantId: TenantId; taskId: ScheduledTaskId }): Promise<ScheduledTask | undefined> {
    const row = await this.db
      .prepare(`
        SELECT id, tenant_id, bot_id, owner_id, schedule, timezone, payload_json, status,
               next_run_at, created_at, updated_at
        FROM scheduled_tasks WHERE tenant_id = ? AND id = ?
      `)
      .bind(input.tenantId, input.taskId)
      .first<ScheduledTaskRow>();
    return row ? mapScheduledTask(row) : undefined;
  }

  async listOwnedScheduledTasks(input: { tenantId: TenantId; ownerId: UserId; botId: BotId }) {
    const result = await this.db
      .prepare(`
        SELECT id, tenant_id, bot_id, owner_id, schedule, timezone, payload_json, status,
               next_run_at, created_at, updated_at
        FROM scheduled_tasks WHERE tenant_id = ? AND owner_id = ? AND bot_id = ?
        ORDER BY created_at DESC, id
      `)
      .bind(input.tenantId, input.ownerId, input.botId)
      .all<ScheduledTaskRow>();
    return result.results.map(mapScheduledTask);
  }

  async listDueScheduledJobIds(input: { now: string; limit: number }): Promise<readonly JobId[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new AppError("VALIDATION_ERROR", "Scheduled job batch size is invalid.", 400);
    }
    const result = await this.db
      .prepare(`
        SELECT id FROM jobs WHERE kind = 'scheduled_task' AND (
          (status IN ('queued', 'retrying') AND available_at <= ?)
          OR (status = 'running' AND lease_until <= ?)
        ) ORDER BY available_at, id LIMIT ?
      `)
      .bind(input.now, input.now, input.limit)
      .all<{ id: string }>();
    return result.results.map((row) => row.id as JobId);
  }

  async setScheduledTaskStatus(input: {
    tenantId: TenantId;
    ownerId: UserId;
    taskId: ScheduledTaskId;
    status: ScheduledTask["status"];
    nextRunAt?: string;
    now: string;
  }): Promise<void> {
    const statements = [
      this.db
        .prepare(`
          UPDATE scheduled_tasks SET status = ?, next_run_at = COALESCE(?, next_run_at), updated_at = ?
          WHERE tenant_id = ? AND owner_id = ? AND id = ?
        `)
        .bind(input.status, input.nextRunAt ?? null, input.now, input.tenantId, input.ownerId, input.taskId),
    ];
    if (input.status !== "active") {
      statements.push(
        this.db
          .prepare(`
          UPDATE jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?
          WHERE tenant_id = ? AND kind = 'scheduled_task' AND status IN ('queued', 'retrying')
            AND substr(idempotency_key, 1, length(?)) = ?
            AND EXISTS (
              SELECT 1 FROM scheduled_tasks WHERE tenant_id = ? AND owner_id = ? AND id = ?
            )
        `)
          .bind(
            input.now,
            input.tenantId,
            `${input.taskId}:`,
            `${input.taskId}:`,
            input.tenantId,
            input.ownerId,
            input.taskId,
          ),
      );
    }
    const result = await this.db.batch(statements);
    if (result[0]?.meta.changes !== 1) throw new AppError("NOT_FOUND", "Scheduled task was not found.", 404);
  }

  async createScheduledRunJob(input: {
    tenantId: TenantId;
    taskId: ScheduledTaskId;
    jobId: JobId;
    runAt: string;
    idempotencyKey: string;
    now: string;
  }): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO jobs (
          id, tenant_id, kind, status, idempotency_key, payload_json,
          attempts, available_at, lease_until, created_at, updated_at
        ) VALUES (?, ?, 'scheduled_task', 'queued', ?, ?, 0, ?, NULL, ?, ?)
        ON CONFLICT(tenant_id, kind, idempotency_key) DO NOTHING
      `)
      .bind(
        input.jobId,
        input.tenantId,
        input.idempotencyKey,
        JSON.stringify({ taskId: input.taskId }),
        input.runAt,
        input.now,
        input.now,
      )
      .run();
  }

  async getScheduledJob(input: { jobId: JobId }): Promise<ScheduledJob | undefined> {
    const row = await this.db
      .prepare(`
        SELECT id, tenant_id, status, attempts, available_at, lease_until, payload_json
        FROM jobs WHERE id = ? AND kind = 'scheduled_task'
      `)
      .bind(input.jobId)
      .first<ScheduledJobRow>();
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
    const row = await this.db
      .prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
        WHERE id = ? AND kind = 'scheduled_task'
          AND ((status IN ('queued', 'retrying') AND available_at <= ?)
            OR (status = 'running' AND lease_until <= ?))
        RETURNING id, tenant_id, status, attempts, available_at, lease_until, payload_json
      `)
      .bind(input.leaseUntil, input.now, input.jobId, input.now, input.now)
      .first<ScheduledJobRow>();
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

  async saveScheduledJobResult(input: { jobId: JobId; resultText: string; now: string }): Promise<void> {
    const row = await this.db
      .prepare("SELECT payload_json FROM jobs WHERE id = ? AND status = 'running'")
      .bind(input.jobId)
      .first<{ payload_json: string }>();
    if (!row) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
    const payload = parseJson<{ taskId?: unknown }>(row.payload_json, "scheduled job payload");
    if (typeof payload.taskId !== "string" || !isScheduledTaskId(payload.taskId)) {
      throw new AppError("INTERNAL_ERROR", "Stored scheduled job task reference is invalid.", 500);
    }
    const result = await this.db
      .prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .bind(JSON.stringify({ taskId: payload.taskId, resultText: input.resultText }), input.now, input.jobId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
  }

  async completeScheduledRun(input: {
    tenantId: TenantId;
    taskId: ScheduledTaskId;
    jobId: JobId;
    nextRunAt?: string;
    now: string;
  }): Promise<void> {
    const task = await this.db
      .prepare("SELECT status FROM scheduled_tasks WHERE tenant_id = ? AND id = ?")
      .bind(input.tenantId, input.taskId)
      .first<{ status: ScheduledTask["status"] }>();
    if (!task) throw new AppError("NOT_FOUND", "Scheduled task was not found.", 404);
    const results = await this.db.batch([
      this.db
        .prepare(`
          UPDATE scheduled_tasks SET next_run_at = ?, status = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'active'
            AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'running')
        `)
        .bind(
          input.nextRunAt ?? null,
          input.nextRunAt ? "active" : "completed",
          input.now,
          input.tenantId,
          input.taskId,
          input.jobId,
        ),
      this.db
        .prepare(`
          UPDATE jobs SET status = 'succeeded', lease_until = NULL, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'running'
        `)
        .bind(input.now, input.jobId, input.tenantId),
    ]);
    if (results[1]?.meta.changes !== 1) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
  }

  async retryScheduledJob(input: { jobId: JobId; availableAt: string; now: string }): Promise<void> {
    const result = await this.db
      .prepare(
        "UPDATE jobs SET status = 'retrying', available_at = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .bind(input.availableAt, input.now, input.jobId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
  }

  async failScheduledJob(input: { jobId: JobId; now: string }): Promise<void> {
    const result = await this.db
      .prepare(
        "UPDATE jobs SET status = 'failed', lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .bind(input.now, input.jobId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("CONFLICT", "Scheduled job lease was lost.", 409);
  }

  async createSession(session: CreationSession): Promise<void> {
    try {
      await this.db
        .prepare(`
          INSERT INTO factory_sessions (
            id, tenant_id, owner_id, status, current_step, answers_json,
            bot_id, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
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
        )
        .run();
    } catch (cause) {
      throw new AppError("CONFLICT", "Creation session could not be created.", 409, { cause });
    }
  }

  async getSession(tenantId: TenantId, ownerId: UserId, sessionId: string): Promise<CreationSession | undefined> {
    const row = await this.db
      .prepare(`
        SELECT id, tenant_id, owner_id, status, current_step, answers_json,
               bot_id, revision, created_at, updated_at
        FROM factory_sessions WHERE tenant_id = ? AND owner_id = ? AND id = ?
      `)
      .bind(tenantId, ownerId, sessionId)
      .first<SessionRow>();
    return row ? mapSession(row) : undefined;
  }

  async saveSession(session: CreationSession, expectedRevision: number): Promise<void> {
    const result = await this.db
      .prepare(`
        UPDATE factory_sessions
        SET status = ?, current_step = ?, answers_json = ?, bot_id = ?, revision = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND owner_id = ? AND revision = ?
      `)
      .bind(
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
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new AppError("CONFLICT", "Creation session changed; reload it before continuing.", 409);
    }
  }

  async getSecret(tenantId: TenantId, reference: string): Promise<EncryptedSecretRecord | undefined> {
    const row = await this.db
      .prepare(`
        SELECT tenant_id, reference, key_id, nonce, ciphertext, envelope_version, created_at
        FROM encrypted_secrets WHERE tenant_id = ? AND reference = ?
      `)
      .bind(tenantId, reference)
      .first<SecretRow>();
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
      await this.db
        .prepare(`
          INSERT INTO encrypted_secrets (
            tenant_id, reference, key_id, nonce, ciphertext, envelope_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          record.tenantId,
          record.reference,
          record.keyId,
          record.nonce,
          record.ciphertext,
          record.version,
          record.createdAt,
        )
        .run();
    } catch (cause) {
      throw new AppError("CONFLICT", "Encrypted credential could not be stored.", 409, { cause });
    }
  }

  async deleteSecret(tenantId: TenantId, reference: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM encrypted_secrets WHERE tenant_id = ? AND reference = ?")
      .bind(tenantId, reference)
      .run();
  }

  async findActiveApiToken(tokenHash: string, now: string): Promise<ApiTokenPrincipal | undefined> {
    const row = await this.db
      .prepare(`
        SELECT t.id, t.tenant_id, t.owner_id, t.scopes_json
        FROM api_tokens AS t
        JOIN tenant_memberships AS m
          ON m.tenant_id = t.tenant_id AND m.user_id = t.owner_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > ?)
      `)
      .bind(tokenHash, now)
      .first<ApiTokenRow>();
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
      await this.db
        .prepare(`
          INSERT INTO creation_approvals (
            approval_hash, tenant_id, owner_id, session_id, action, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          record.approvalHash,
          record.tenantId,
          record.ownerId,
          record.sessionId,
          record.action,
          record.createdAt,
          record.expiresAt,
        )
        .run();
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
    const result = await this.db
      .prepare(`
        UPDATE creation_approvals SET consumed_at = ?
        WHERE approval_hash = ? AND tenant_id = ? AND owner_id = ? AND session_id = ? AND action = ?
          AND consumed_at IS NULL AND expires_at > ?
      `)
      .bind(input.now, input.approvalHash, input.tenantId, input.ownerId, input.sessionId, input.action, input.now)
      .run();
    return result.meta.changes === 1;
  }

  async listMcpServers(tenantId: TenantId, botId: BotId): Promise<readonly McpServerConnection[]> {
    const result = await this.db
      .prepare(`
        SELECT id, tenant_id, bot_id, name, endpoint, credential_ref, status, created_at, updated_at
        FROM mcp_servers WHERE tenant_id = ? AND bot_id = ? ORDER BY created_at, id
      `)
      .bind(tenantId, botId)
      .all<McpServerRow>();
    return result.results.map(mapMcpServer);
  }

  async getMcpServer(tenantId: TenantId, botId: BotId, serverId: string): Promise<McpServerConnection | undefined> {
    const row = await this.db
      .prepare(`
        SELECT id, tenant_id, bot_id, name, endpoint, credential_ref, status, created_at, updated_at
        FROM mcp_servers WHERE tenant_id = ? AND bot_id = ? AND id = ?
      `)
      .bind(tenantId, botId, serverId)
      .first<McpServerRow>();
    return row ? mapMcpServer(row) : undefined;
  }

  async createMcpServer(input: Parameters<McpRepository["createServer"]>[0]): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.db
        .prepare(`
          INSERT INTO mcp_servers (
            id, tenant_id, bot_id, name, endpoint, credential_ref, status, configuration_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'disconnected', '{}', ?, ?)
        `)
        .bind(input.id, input.tenantId, input.botId, input.name, input.endpoint, input.credentialRef ?? null, now, now)
        .run();
    } catch (cause) {
      throw new AppError("CONFLICT", "MCP server could not be added to this bot.", 409, { cause });
    }
  }

  async setMcpServerStatus(input: Parameters<McpRepository["setServerStatus"]>[0]): Promise<void> {
    const result = await this.db
      .prepare("UPDATE mcp_servers SET status = ?, updated_at = ? WHERE tenant_id = ? AND bot_id = ? AND id = ?")
      .bind(input.status, new Date().toISOString(), input.tenantId, input.botId, input.serverId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("NOT_FOUND", "MCP server was not found for this bot.", 404);
  }

  async deleteMcpServer(input: Parameters<McpRepository["deleteServer"]>[0]): Promise<void> {
    const result = await this.db
      .prepare("DELETE FROM mcp_servers WHERE tenant_id = ? AND bot_id = ? AND id = ?")
      .bind(input.tenantId, input.botId, input.serverId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("NOT_FOUND", "MCP server was not found for this bot.", 404);
  }

  async listMcpTools(tenantId: TenantId, botId: BotId, serverId?: string): Promise<readonly McpDiscoveredTool[]> {
    const query = this.db.prepare(
      serverId
        ? `SELECT server_id, tool_name, description, input_schema_json, output_schema_json, enabled, permissions_json, last_seen_at
         FROM mcp_tool_permissions WHERE tenant_id = ? AND bot_id = ? AND server_id = ? ORDER BY tool_name`
        : `SELECT server_id, tool_name, description, input_schema_json, output_schema_json, enabled, permissions_json, last_seen_at
         FROM mcp_tool_permissions WHERE tenant_id = ? AND bot_id = ? ORDER BY server_id, tool_name`,
    );
    const result = serverId
      ? await query.bind(tenantId, botId, serverId).all<McpToolRow>()
      : await query.bind(tenantId, botId).all<McpToolRow>();
    return result.results.map(mapMcpTool);
  }

  async getMcpTool(
    tenantId: TenantId,
    botId: BotId,
    serverId: string,
    toolName: string,
  ): Promise<McpDiscoveredTool | undefined> {
    const row = await this.db
      .prepare(`
        SELECT server_id, tool_name, description, input_schema_json, output_schema_json, enabled, permissions_json, last_seen_at
        FROM mcp_tool_permissions WHERE tenant_id = ? AND bot_id = ? AND server_id = ? AND tool_name = ?
      `)
      .bind(tenantId, botId, serverId, toolName)
      .first<McpToolRow>();
    return row ? mapMcpTool(row) : undefined;
  }

  async replaceMcpTools(input: Parameters<McpRepository["replaceDiscoveredTools"]>[0]): Promise<void> {
    const statements: D1PreparedStatement[] = input.tools.map((tool) => {
      const inputSchema = JSON.stringify(tool.inputSchema);
      const outputSchema = tool.outputSchema === undefined ? null : JSON.stringify(tool.outputSchema);
      return this.db
        .prepare(`
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
        `)
        .bind(
          input.tenantId,
          input.botId,
          input.serverId,
          tool.name,
          tool.description,
          inputSchema,
          outputSchema,
          input.discoveredAt,
          input.discoveredAt,
        );
    });
    const names = input.tools.map(({ name }) => name);
    statements.push(
      names.length
        ? this.db
            .prepare(
              `DELETE FROM mcp_tool_permissions WHERE tenant_id = ? AND bot_id = ? AND server_id = ? AND tool_name NOT IN (${names.map(() => "?").join(",")})`,
            )
            .bind(input.tenantId, input.botId, input.serverId, ...names)
        : this.db
            .prepare("DELETE FROM mcp_tool_permissions WHERE tenant_id = ? AND bot_id = ? AND server_id = ?")
            .bind(input.tenantId, input.botId, input.serverId),
    );
    await this.db.batch(statements);
  }

  async setMcpToolPermission(input: Parameters<McpRepository["setToolPermission"]>[0]): Promise<void> {
    const result = await this.db
      .prepare(`
        UPDATE mcp_tool_permissions SET enabled = ?, permissions_json = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND server_id = ? AND tool_name = ?
      `)
      .bind(
        Number(input.enabled),
        JSON.stringify(input.grantedPermissions),
        new Date().toISOString(),
        input.tenantId,
        input.botId,
        input.serverId,
        input.toolName,
      )
      .run();
    if (result.meta.changes !== 1) throw new AppError("NOT_FOUND", "Discovered MCP tool was not found.", 404);
  }

  async listSkillCatalog(tenantId: TenantId): Promise<readonly SkillDefinition[]> {
    const result = await this.db
      .prepare(`
        SELECT id, tenant_id, name, version, author, category, description, execution_type,
               input_schema_json, output_schema_json, permissions_json, definition_json, enabled
        FROM skills WHERE enabled = 1 AND (tenant_id IS NULL OR tenant_id = ?)
        ORDER BY category, name, version
      `)
      .bind(tenantId)
      .all<SkillRow>();
    return result.results.map(mapSkillDefinition);
  }

  async getCatalogSkill(tenantId: TenantId, skillId: string): Promise<SkillDefinition | undefined> {
    const row = await this.db
      .prepare(`
        SELECT id, tenant_id, name, version, author, category, description, execution_type,
               input_schema_json, output_schema_json, permissions_json, definition_json, enabled
        FROM skills WHERE id = ? AND enabled = 1 AND (tenant_id IS NULL OR tenant_id = ?)
      `)
      .bind(skillId, tenantId)
      .first<SkillRow>();
    return row ? mapSkillDefinition(row) : undefined;
  }

  async listInstalledSkills(tenantId: TenantId, botId: BotId): Promise<readonly InstalledSkill[]> {
    const result = await this.db
      .prepare(`
        SELECT s.id, s.tenant_id, s.name, s.version, s.author, s.category, s.description, s.execution_type,
               s.input_schema_json, s.output_schema_json, s.permissions_json, s.definition_json, s.enabled,
               i.enabled AS installed_enabled, i.installed_by, i.configuration_json AS installation_json
        FROM skill_installations AS i
        JOIN skills AS s ON s.id = i.skill_id
        WHERE i.tenant_id = ? AND i.bot_id = ? AND (s.tenant_id IS NULL OR s.tenant_id = ?)
        ORDER BY s.name, s.id
      `)
      .bind(tenantId, botId, tenantId)
      .all<SkillRow>();
    return result.results.map(mapInstalledSkill);
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
      await this.db
        .prepare(`
          INSERT INTO skill_installations (
            tenant_id, bot_id, skill_id, enabled, configuration_json, installed_by, installed_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?)
        `)
        .bind(
          input.tenantId,
          input.botId,
          input.skillId,
          JSON.stringify({ ...validated.configuration, grantedPermissions: validated.grantedPermissions }),
          input.installedBy,
          new Date().toISOString(),
        )
        .run();
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
    const result = await this.db
      .prepare(`
        UPDATE skill_installations SET enabled = ?
        WHERE tenant_id = ? AND bot_id = ? AND skill_id = ?
      `)
      .bind(Number(input.enabled), input.tenantId, input.botId, input.skillId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("NOT_FOUND", "Installed skill was not found.", 404);
  }

  async uninstallSkill(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
  }): Promise<void> {
    const result = await this.db
      .prepare("DELETE FROM skill_installations WHERE tenant_id = ? AND bot_id = ? AND skill_id = ?")
      .bind(input.tenantId, input.botId, input.skillId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("NOT_FOUND", "Installed skill was not found.", 404);
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
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM skill_rate_limit_buckets WHERE window_start < ?").bind(windowStart - windowMs * 2),
      this.db
        .prepare(`
          INSERT INTO skill_rate_limit_buckets (tenant_id, bot_id, skill_id, window_start, request_count)
          VALUES (?, ?, ?, ?, 1)
          ON CONFLICT (tenant_id, bot_id, skill_id, window_start)
          DO UPDATE SET request_count = request_count + 1
          WHERE request_count < ?
        `)
        .bind(input.tenantId, input.botId, input.skillId, windowStart, input.maxRequests),
    ]);
    return results[1]?.meta.changes === 1;
  }

  async createApiToken(record: ApiTokenRecord): Promise<void> {
    try {
      await this.db
        .prepare(`
          INSERT INTO api_tokens (
            id, tenant_id, owner_id, token_hash, token_prefix, scopes_json, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          record.tokenId,
          record.tenantId,
          record.ownerId,
          record.tokenHash,
          record.tokenPrefix,
          JSON.stringify(record.scopes),
          record.createdAt,
          record.expiresAt ?? null,
        )
        .run();
    } catch (cause) {
      throw new AppError("CONFLICT", "API token could not be created.", 409, { cause });
    }
  }

  async revokeApiToken(tenantId: TenantId, ownerId: UserId, tokenId: string, revokedAt: string): Promise<void> {
    await this.db
      .prepare(`
        UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?)
        WHERE tenant_id = ? AND owner_id = ? AND id = ?
      `)
      .bind(revokedAt, tenantId, ownerId, tokenId)
      .run();
  }
}

function mapSkillDefinition(row: SkillRow): SkillDefinition {
  return parseStoredSkillDefinition({
    id: row.id,
    tenantId: row.tenant_id,
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
    tenantId: row.tenant_id,
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
  const permissions = parseMcpJson(row.permissions_json, "tool permissions");
  if (!Array.isArray(permissions) || permissions.some((permission) => typeof permission !== "string")) {
    throw new AppError("INTERNAL_ERROR", "Stored MCP tool permissions are invalid.", 500);
  }
  const inputSchema = parseMcpJson(row.input_schema_json, "input schema");
  const outputSchema = row.output_schema_json ? parseMcpJson(row.output_schema_json, "output schema") : undefined;
  if (!isRecord(inputSchema) || (outputSchema !== undefined && !isRecord(outputSchema))) {
    throw new AppError("INTERNAL_ERROR", "Stored MCP tool schema is invalid.", 500);
  }
  return {
    serverId: row.server_id,
    name: row.tool_name,
    description: row.description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    enabled: row.enabled === 1,
    grantedPermissions: permissions as string[],
    lastSeenAt: row.last_seen_at,
  };
}

function parseMcpJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", `Stored MCP ${label} is invalid JSON.`, 500, { cause });
  }
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", `Stored ${label} is invalid JSON.`, 500, { cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapBot(row: BotRow): BotDefinition {
  const config = JSON.parse(row.configuration_json) as {
    systemPrompt: string;
    model: BotDefinition["model"];
    purpose?: string;
    audience?: string;
    skills?: readonly string[];
    mcpConnections?: readonly string[];
    integrations?: readonly string[];
    memoryEnabled?: boolean;
    scheduledTasks?: readonly string[];
    privacySettings?: readonly string[];
    interfaces?: BotDefinition["interfaces"];
  };
  return {
    id: row.id as BotId,
    tenantId: row.tenant_id as TenantId,
    ownerId: row.owner_id as UserId,
    name: row.name,
    description: row.description,
    systemPrompt: config.systemPrompt,
    model: config.model,
    ...(config.purpose === undefined ? {} : { purpose: config.purpose }),
    ...(config.audience === undefined ? {} : { audience: config.audience }),
    ...(config.skills === undefined ? {} : { skills: config.skills }),
    ...(config.mcpConnections === undefined ? {} : { mcpConnections: config.mcpConnections }),
    ...(config.integrations === undefined ? {} : { integrations: config.integrations }),
    ...(config.memoryEnabled === undefined ? {} : { memoryEnabled: config.memoryEnabled }),
    ...(config.scheduledTasks === undefined ? {} : { scheduledTasks: config.scheduledTasks }),
    ...(config.privacySettings === undefined ? {} : { privacySettings: config.privacySettings }),
    ...(config.interfaces === undefined ? {} : { interfaces: config.interfaces }),
    visibility: row.visibility,
    status: row.status,
    version: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: SessionRow): CreationSession {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    ownerId: row.owner_id as UserId,
    status: row.status,
    currentStep: row.current_step,
    answers: JSON.parse(row.answers_json) as CreationSession["answers"],
    ...(row.bot_id === null ? {} : { botId: row.bot_id as BotId }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): ConversationMessage {
  const metadata = JSON.parse(row.metadata_json) as {
    name?: string;
    toolCallId?: string;
    toolCalls?: ConversationMessage["toolCalls"];
  };
  return {
    role: row.role,
    content: row.content,
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
    ...(metadata.toolCalls ? { toolCalls: metadata.toolCalls } : {}),
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

function parseScopes(scopesJson: string): readonly string[] {
  const scopes: unknown = JSON.parse(scopesJson);
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
    throw new AppError("INTERNAL_ERROR", "API token scopes are corrupted.", 500);
  }
  return scopes;
}

function configurationFromBot(bot: BotDefinition): Record<string, unknown> {
  return {
    systemPrompt: bot.systemPrompt,
    model: bot.model,
    ...(bot.purpose === undefined ? {} : { purpose: bot.purpose }),
    ...(bot.audience === undefined ? {} : { audience: bot.audience }),
    ...(bot.skills === undefined ? {} : { skills: bot.skills }),
    ...(bot.mcpConnections === undefined ? {} : { mcpConnections: bot.mcpConnections }),
    ...(bot.integrations === undefined ? {} : { integrations: bot.integrations }),
    ...(bot.memoryEnabled === undefined ? {} : { memoryEnabled: bot.memoryEnabled }),
    ...(bot.scheduledTasks === undefined ? {} : { scheduledTasks: bot.scheduledTasks }),
    ...(bot.privacySettings === undefined ? {} : { privacySettings: bot.privacySettings }),
    ...(bot.interfaces === undefined ? {} : { interfaces: bot.interfaces }),
  };
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "bot"
  );
}
