import {
  AppError,
  parseStoredSkillDefinition,
  parseStoredSkillInstallation,
  mapBotVersionHistoryItem,
  validateBotSettingsPatch,
  validateSkillInstallation,
  validateSkillRateLimitInput,
} from "@aihat/core";
import type {
  ApiConversationRepository,
  BotAccessRepository,
  ApiTokenPrincipal,
  ApiTokenRecord,
  ApiTokenRepository,
  AuditLogRepository,
  ApiAuthorizationDenialRepository,
  BotCredentialApprovalRepository,
  ConversationHistoryRepository,
  BotDefinition,
  BotDraftPublisher,
  BotManagementRepository,
  BotVersionHistoryItem,
  BotId,
  BotRepository,
  BotSettingsPatch,
  BotVisibility,
  ConversationId,
  ConversationMessage,
  ConversationSummary,
  StoredConversationMessage,
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
  SkillCatalogPublication,
  SkillRepository,
  McpRepository,
  MemoryRepository,
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
  TelegramAuthRepository,
  UsageRepository,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledJob,
  JobId,
  UsageRecord,
  UsageSummary,
  StoredBotMemoryRecord,
  BotAccessDecision,
  BotAccessGrant,
  PublicBotListing,
  AuditLogEvent,
  TenantMember,
  TenantInvitation,
  TenantRole,
  TenantWorkspace,
  BotOwnershipTransfer,
  MasterBotRepository,
  MasterBotReply,
  MasterBotSession,
  MasterBotUpdateReservation,
  WorkflowExecution,
  WorkflowExecutionAcquisition,
  WorkflowExecutionRepository,
  ToolExecutionAcquisition,
  ToolExecutionRecovery,
  ToolExecutionRepository,
  TenantMembershipRepository,
  BotOwnershipTransferRepository,
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

interface BotVersionRow {
  bot_id: string;
  version: number;
  current_version: number;
  configuration_json: string;
  created_at: string;
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
  expires_at: string | null;
  role: TenantRole;
}

interface MessageRow {
  role: ConversationMessage["role"];
  content: string;
  metadata_json: string;
}

interface ConversationHistoryMessageRow extends MessageRow {
  id: string;
  sequence: number;
  created_at: string;
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
  response_attachments_json: string;
  lease_until: string;
}

interface MasterBotSessionRow {
  telegram_user_id: number;
  chat_id: number;
  tenant_id: string;
  owner_id: string;
  session_id: string;
  updated_at: string;
}

interface MasterBotUpdateRow {
  state: "processing" | "ready" | "completed";
  response_json: string | null;
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

interface UsageAggregateRow {
  date: string;
  requests: number;
  reported_requests: number;
  input_tokens: number;
  output_tokens: number;
}

interface UsageBotAggregateRow extends Omit<UsageAggregateRow, "date"> {
  bot_id: string;
  bot_name: string;
}

interface ModelRetryAggregateRow {
  date: string;
  retries: number;
}

interface ModelRetryBotAggregateRow {
  bot_id: string;
  bot_name: string;
  retries: number;
}

interface ModelRetryStatusAggregateRow {
  status_code: number;
  retries: number;
}

interface MemoryRow {
  id: string;
  bot_id: string;
  memory_key: string;
  value_json: string;
  encrypted_value: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PublicListingRow {
  bot_id: string;
  slug: string;
  title: string;
  summary: string;
  listed_at: string;
  daily_usage_limit: number;
  rate_limit_per_minute: number;
}

interface AuditLogRow {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata_json: string;
  created_at: string;
}

interface AccessGrantRow {
  id: string;
  bot_id: string;
  user_id: string | null;
  invitation_token_hash: string | null;
  access_level: BotAccessGrant["accessLevel"];
  status: BotAccessGrant["status"];
  usage_limit: number | null;
  rate_limit_per_minute: number | null;
  expires_at: string | null;
  created_at: string;
}

interface WorkflowExecutionRow {
  tenant_id: string;
  bot_id: string;
  skill_id: string;
  execution_key: string;
  state_ref: string;
  next_step: number;
  version: number;
  status: WorkflowExecution["status"];
  lease_token: string | null;
  lease_until: string;
  expires_at: string;
  updated_at: string;
}

interface ToolExecutionRow {
  tenant_id: string;
  bot_id: string;
  execution_key: string;
  tool_name: string;
  input_hash: string;
  status: "running" | "succeeded";
  recovery_status: "none" | "ambiguous" | "retry_approved" | "closed";
  ambiguous_at: string | null;
  result_ref: string | null;
  lease_token: string | null;
  lease_until: string;
  expires_at: string;
  updated_at: string;
}

interface TenantMemberRow {
  user_id: string;
  role: TenantRole;
  status: "active" | "inactive";
  created_at: string;
  owned_bot_count: number;
}

interface TenantInvitationRow {
  id: string;
  tenant_id: string;
  role: Exclude<TenantRole, "owner">;
  status: "pending" | "accepted" | "revoked";
  created_by: string;
  created_at: string;
  expires_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
}

interface BotOwnershipTransferRow {
  id: string;
  bot_id: string;
  from_owner_id: string;
  to_owner_id: string;
  status: BotOwnershipTransfer["status"];
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

/** D1 implementation of the same tenant-scoped contracts used by Bun SQLite. */
export class CloudflareD1Repositories
  implements
    BotRepository,
    BotManagementRepository,
    ConversationRepository,
    ConversationHistoryRepository,
    ApiConversationRepository,
    BotAccessRepository,
    AuditLogRepository,
    ApiAuthorizationDenialRepository,
    TelegramRepository,
    ScheduledTaskRepository,
    UsageRepository,
    MemoryRepository,
    BotDraftPublisher,
    BotOwnershipTransferRepository
{
  readonly sessions: CreationSessionRepository;
  readonly creationApprovals: CreationApprovalRepository;
  readonly botCredentialApprovals: BotCredentialApprovalRepository;
  readonly secretRecords: SecretRecordRepository;
  readonly apiTokens: ApiTokenRepository;
  readonly telegramAuth: TelegramAuthRepository;
  readonly masterBot: MasterBotRepository;
  readonly skills: SkillRepository;
  readonly skillRateLimiter: SkillRateLimiter;
  readonly workflowExecutions: WorkflowExecutionRepository;
  readonly toolExecutions: ToolExecutionRepository;
  readonly tenantMembers: TenantMembershipRepository;
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
    this.botCredentialApprovals = {
      create: (input) => this.createBotCredentialApproval(input),
      consume: (input) => this.consumeBotCredentialApproval(input),
    };
    this.secretRecords = {
      get: (tenantId, reference) => this.getSecret(tenantId, reference),
      create: (record) => this.createSecret(record),
      delete: (tenantId, reference) => this.deleteSecret(tenantId, reference),
      listPage: (after, limit) => this.listSecrets(after, limit),
      replaceIfUnchanged: (record, expected) => this.replaceSecretIfUnchanged(record, expected),
    };
    this.apiTokens = {
      findActive: (tokenHash, now) => this.findActiveApiToken(tokenHash, now),
      create: (record) => this.createApiToken(record),
      revoke: (tenantId, ownerId, tokenId, revokedAt) => this.revokeApiToken(tenantId, ownerId, tokenId, revokedAt),
      consumeApiRequest: (input) => this.consumeApiRequest(input),
      recordApiMutation: (input) => this.recordApiMutation(input),
    };
    this.telegramAuth = {
      claimInitData: (input) => this.claimTelegramInitData(input),
      getOrCreateOwner: (input) => this.getOrCreateTelegramOwner(input),
    };
    this.masterBot = {
      getSession: (telegramUserId) => this.getMasterBotSession(telegramUserId),
      saveSession: (session) => this.saveMasterBotSession(session),
      deleteSession: (telegramUserId) => this.deleteMasterBotSession(telegramUserId),
      reserveUpdate: (input) => this.reserveMasterBotUpdate(input),
      saveUpdateReply: (input) => this.saveMasterBotUpdateReply(input),
      completeUpdate: (input) => this.completeMasterBotUpdate(input),
      releaseUpdate: (input) => this.releaseMasterBotUpdate(input),
    };
    this.skills = {
      listCatalog: (tenantId) => this.listSkillCatalog(tenantId),
      getCatalogSkill: (tenantId, skillId) => this.getCatalogSkill(tenantId, skillId),
      listGlobalCatalog: () => this.listGlobalSkillCatalog(),
      publishGlobalCatalogSkill: (input) => this.publishGlobalSkillCatalogItem(input),
      setGlobalCatalogSkillEnabled: (skillId, enabled) => this.setGlobalSkillCatalogEnabled(skillId, enabled),
      publishCatalogSkill: (input) => this.publishCatalogSkill(input),
      listInstalled: (tenantId, botId) => this.listInstalledSkills(tenantId, botId),
      install: (input) => this.installSkill(input),
      setEnabled: (input) => this.setSkillEnabled(input),
      uninstall: (input) => this.uninstallSkill(input),
    };
    this.skillRateLimiter = {
      consume: (input) => this.consumeSkillRateLimit(input),
    };
    this.workflowExecutions = {
      acquire: (input) => this.acquireWorkflowExecution(input),
      checkpoint: (input) => this.checkpointWorkflowExecution(input),
      complete: (input) => this.completeWorkflowExecution(input),
      release: (input) => this.releaseWorkflowExecution(input),
      purgeExpired: (tenantId, now, limit) => this.purgeWorkflowExecutions(tenantId, now, limit),
    };
    this.toolExecutions = {
      acquire: (input) => this.acquireToolExecution(input),
      complete: (input) => this.completeToolExecution(input),
      release: (input) => this.releaseToolExecution(input),
      listOwnedRecoveries: (input) => this.listOwnedToolExecutionRecoveries(input),
      resolveOwnedRecovery: (input) => this.resolveOwnedToolExecutionRecovery(input),
      purgeExpired: (tenantId, now, limit) => this.purgeToolExecutions(tenantId, now, limit),
    };
    this.tenantMembers = {
      listMembers: (input) => this.listTenantMembers(input),
      listWorkspacesForUser: (userId) => this.listWorkspacesForUser(userId),
      getActiveRole: (input) => this.getActiveTenantRole(input),
      addMember: (input) => this.addTenantMember(input),
      changeMemberRole: (input) => this.changeTenantMemberRole(input),
      deactivateMember: (input) => this.deactivateTenantMember(input),
      listInvitations: (input) => this.listTenantInvitations(input),
      createInvitation: (input) => this.createTenantInvitation(input),
      revokeInvitation: (input) => this.revokeTenantInvitation(input),
      acceptInvitation: (input) => this.acceptTenantInvitation(input),
    };
    this.mcp = {
      listServers: (tenantId, botId) => this.listMcpServers(tenantId, botId),
      getServer: (tenantId, botId, serverId) => this.getMcpServer(tenantId, botId, serverId),
      createServer: (input) => this.createMcpServer(input),
      setServerStatus: (input) => this.setMcpServerStatus(input),
      setServerCredentialRef: (input) => this.setMcpServerCredentialRef(input),
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

  async listVersions(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly limit: number;
  }): Promise<readonly BotVersionHistoryItem[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new AppError("VALIDATION_ERROR", "Version page size must be between 1 and 100.", 400);
    }
    const result = await this.db
      .prepare(`
        SELECT v.bot_id, v.version, b.current_version, v.configuration_json, v.created_at
        FROM bots AS b
        JOIN bot_versions AS v ON v.bot_id = b.id AND v.tenant_id = b.tenant_id
        WHERE b.tenant_id = ? AND b.owner_id = ? AND b.id = ?
        ORDER BY v.version DESC
        LIMIT ?
      `)
      .bind(input.tenantId, input.ownerId, input.botId, input.limit)
      .all<BotVersionRow>();
    if (!result.results.length) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    return result.results.map((row) =>
      mapBotVersionHistoryItem({
        botId: row.bot_id as BotId,
        version: row.version,
        configurationJson: row.configuration_json,
        createdAt: row.created_at,
        current: row.version === row.current_version,
      }),
    );
  }

  async listPublicBots(input: { query?: string; limit: number }): Promise<readonly PublicBotListing[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new AppError("VALIDATION_ERROR", "Public bot page size must be between 1 and 50.", 400);
    }
    const query = input.query?.trim().toLowerCase() ?? "";
    const result = await this.db
      .prepare(`
        SELECT p.bot_id, p.slug, p.title, p.summary, p.listed_at,
               p.daily_usage_limit, p.rate_limit_per_minute
        FROM public_bot_listings AS p
        JOIN bots AS b ON b.id = p.bot_id AND b.tenant_id = p.tenant_id
        WHERE b.status = 'published' AND b.visibility = 'public'
          AND (? = '' OR lower(p.title) LIKE ? OR lower(p.summary) LIKE ?)
        ORDER BY p.listed_at DESC, p.slug
        LIMIT ?
      `)
      .bind(query, `%${query}%`, `%${query}%`, input.limit)
      .all<PublicListingRow>();
    return result.results.map(mapPublicListing);
  }

  async getPublicBotBySlug(slug: string): Promise<BotDefinition | undefined> {
    const row = await this.db
      .prepare(`
        SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
               b.visibility, b.current_version, b.created_at, b.updated_at, v.configuration_json
        FROM public_bot_listings AS p
        JOIN bots AS b ON b.id = p.bot_id AND b.tenant_id = p.tenant_id
        JOIN bot_versions AS v ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
        WHERE p.slug = ? AND b.status = 'published' AND b.visibility = 'public'
      `)
      .bind(slug)
      .first<BotRow>();
    return row ? mapBot(row) : undefined;
  }

  async getSharedBot(input: { botId: BotId; userId: UserId; now: string }): Promise<BotDefinition | undefined> {
    const row = await this.db
      .prepare(`
        SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
               b.visibility, b.current_version, b.created_at, b.updated_at, v.configuration_json
        FROM bots AS b
        JOIN bot_versions AS v ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
        WHERE b.id = ? AND b.status = 'published' AND b.visibility IN ('private', 'shared', 'invitation')
          AND EXISTS (
            SELECT 1 FROM bot_access_grants AS g
            WHERE g.tenant_id = b.tenant_id AND g.bot_id = b.id AND g.user_id = ?
              AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > ?)
              AND g.access_level IN ('use', 'manage')
          )
      `)
      .bind(input.botId, input.userId, input.now)
      .first<BotRow>();
    return row ? mapBot(row) : undefined;
  }

  async listOwnedAccessGrants(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
  }): Promise<readonly BotAccessGrant[]> {
    await this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    const result = await this.db
      .prepare(`
        SELECT id, bot_id, user_id, invitation_token_hash, access_level, status,
               usage_limit, rate_limit_per_minute, expires_at, created_at
        FROM bot_access_grants WHERE tenant_id = ? AND bot_id = ?
        ORDER BY created_at DESC, id
      `)
      .bind(input.tenantId, input.botId)
      .all<AccessGrantRow>();
    return result.results.map(mapAccessGrant);
  }

  async getOwnedPublicBotAccessPolicy(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
  }): Promise<PublicBotListing | undefined> {
    const bot = await this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    if (bot.visibility !== "public") return undefined;
    const row = await this.db
      .prepare(`
        SELECT bot_id, slug, title, summary, listed_at, daily_usage_limit, rate_limit_per_minute
        FROM public_bot_listings WHERE tenant_id = ? AND bot_id = ?
      `)
      .bind(input.tenantId, input.botId)
      .first<PublicListingRow>();
    return row ? mapPublicListing(row) : undefined;
  }

  async setPublicBotAccessPolicy(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    dailyUsageLimit: number;
    rateLimitPerMinute: number;
    now: string;
  }): Promise<PublicBotListing> {
    validateAccessLimits(input.dailyUsageLimit, input.rateLimitPerMinute);
    const bot = await this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    if (bot.visibility !== "public") throw new AppError("CONFLICT", "Only public bots have public access limits.", 409);
    const result = await this.db
      .prepare(`
        UPDATE public_bot_listings SET daily_usage_limit = ?, rate_limit_per_minute = ?, listed_at = ?
        WHERE tenant_id = ? AND bot_id = ?
      `)
      .bind(input.dailyUsageLimit, input.rateLimitPerMinute, input.now, input.tenantId, input.botId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("CONFLICT", "Public bot listing is not available yet.", 409);
    const row = await this.db
      .prepare(`
        SELECT bot_id, slug, title, summary, listed_at, daily_usage_limit, rate_limit_per_minute
        FROM public_bot_listings WHERE tenant_id = ? AND bot_id = ?
      `)
      .bind(input.tenantId, input.botId)
      .first<PublicListingRow>();
    if (!row) throw new AppError("INTERNAL_ERROR", "Public bot settings could not be loaded.", 500);
    return mapPublicListing(row);
  }

  async createOwnedAccessGrant(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    userId?: UserId;
    invitationTokenHash?: string;
    dailyUsageLimit?: number;
    rateLimitPerMinute?: number;
    expiresAt?: string;
    now: string;
  }): Promise<BotAccessGrant> {
    if (Boolean(input.userId) === Boolean(input.invitationTokenHash)) {
      throw new AppError("VALIDATION_ERROR", "Specify one user or one invitation token.", 400);
    }
    if (input.dailyUsageLimit !== undefined || input.rateLimitPerMinute !== undefined) {
      validateAccessLimits(input.dailyUsageLimit ?? 100, input.rateLimitPerMinute ?? 10);
    }
    const bot = await this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    if (bot.visibility === "private" && !input.userId) {
      throw new AppError("CONFLICT", "Private bots can only grant access directly to a named user.", 409);
    }
    if (
      input.expiresAt !== undefined &&
      (!Number.isFinite(Date.parse(input.expiresAt)) || input.expiresAt <= input.now)
    ) {
      throw new AppError("VALIDATION_ERROR", "Grant expiry must be a future timestamp.", 400);
    }
    const id = `grant_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      if (input.userId) {
        await this.db
          .prepare(`
            INSERT INTO bot_access_grants (
              id, tenant_id, bot_id, user_id, invitation_token_hash, access_level, status,
              usage_limit, rate_limit_per_minute, expires_at, created_at
            ) VALUES (?, ?, ?, ?, NULL, 'use', 'active', ?, ?, ?, ?)
            ON CONFLICT(bot_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET
              status = 'active', access_level = 'use', usage_limit = excluded.usage_limit,
              rate_limit_per_minute = excluded.rate_limit_per_minute,
              expires_at = excluded.expires_at, created_at = excluded.created_at
          `)
          .bind(
            id,
            input.tenantId,
            input.botId,
            input.userId,
            input.dailyUsageLimit ?? null,
            input.rateLimitPerMinute ?? null,
            input.expiresAt ?? null,
            input.now,
          )
          .run();
      } else {
        await this.db
          .prepare(`
            INSERT INTO bot_access_grants (
              id, tenant_id, bot_id, user_id, invitation_token_hash, access_level, status,
              usage_limit, rate_limit_per_minute, expires_at, created_at
            ) VALUES (?, ?, ?, NULL, ?, 'use', 'active', ?, ?, ?, ?)
          `)
          .bind(
            id,
            input.tenantId,
            input.botId,
            input.invitationTokenHash,
            input.dailyUsageLimit ?? null,
            input.rateLimitPerMinute ?? null,
            input.expiresAt ?? null,
            input.now,
          )
          .run();
      }
    } catch (cause) {
      throw new AppError("CONFLICT", "Bot access grant could not be created.", 409, { cause });
    }
    const row = input.userId
      ? await this.db
          .prepare(`
            SELECT id, bot_id, user_id, invitation_token_hash, access_level, status,
                   usage_limit, rate_limit_per_minute, expires_at, created_at
            FROM bot_access_grants WHERE tenant_id = ? AND bot_id = ? AND user_id = ?
          `)
          .bind(input.tenantId, input.botId, input.userId)
          .first<AccessGrantRow>()
      : await this.db
          .prepare(`
            SELECT id, bot_id, user_id, invitation_token_hash, access_level, status,
                   usage_limit, rate_limit_per_minute, expires_at, created_at
            FROM bot_access_grants WHERE id = ?
          `)
          .bind(id)
          .first<AccessGrantRow>();
    if (!row) throw new AppError("INTERNAL_ERROR", "Created access grant could not be loaded.", 500);
    return mapAccessGrant(row);
  }

  async revokeOwnedAccessGrant(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    grantId: string;
  }): Promise<boolean> {
    await this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    const result = await this.db
      .prepare(`
        UPDATE bot_access_grants SET status = 'revoked', invitation_token_hash = NULL
        WHERE tenant_id = ? AND bot_id = ? AND id = ? AND status != 'revoked'
      `)
      .bind(input.tenantId, input.botId, input.grantId)
      .run();
    return result.meta.changes === 1;
  }

  async acceptBotInvitation(input: {
    invitationTokenHash: string;
    userId: UserId;
    now: string;
  }): Promise<BotAccessGrant | undefined> {
    const grant = await this.db
      .prepare(`
        SELECT g.id FROM bot_access_grants AS g
        JOIN bots AS b ON b.id = g.bot_id AND b.tenant_id = g.tenant_id
        WHERE g.invitation_token_hash = ? AND g.status = 'active'
          AND (g.expires_at IS NULL OR g.expires_at > ?)
          AND b.status = 'published' AND b.visibility IN ('shared', 'invitation')
      `)
      .bind(input.invitationTokenHash, input.now)
      .first<{ id: string }>();
    if (!grant) return undefined;
    let updated: D1Result;
    try {
      updated = await this.db
        .prepare(`
          UPDATE bot_access_grants SET user_id = ?, invitation_token_hash = NULL
          WHERE id = ? AND invitation_token_hash = ? AND user_id IS NULL AND status = 'active'
            AND (expires_at IS NULL OR expires_at > ?)
        `)
        .bind(input.userId, grant.id, input.invitationTokenHash, input.now)
        .run();
    } catch (cause) {
      throw new AppError("CONFLICT", "Invitation could not be accepted for this account.", 409, { cause });
    }
    if (updated.meta.changes !== 1) return undefined;
    const row = await this.db
      .prepare(`
        SELECT id, bot_id, user_id, invitation_token_hash, access_level, status,
               usage_limit, rate_limit_per_minute, expires_at, created_at
        FROM bot_access_grants WHERE id = ? AND user_id = ?
      `)
      .bind(grant.id, input.userId)
      .first<AccessGrantRow>();
    return row ? mapAccessGrant(row) : undefined;
  }

  async consumeBotUse(input: {
    botId: BotId;
    userId: UserId;
    accessMode: "public" | "shared";
    now: string;
  }): Promise<BotAccessDecision> {
    const timestamp = Date.parse(input.now);
    if (!Number.isFinite(timestamp)) throw new AppError("VALIDATION_ERROR", "Access request time is invalid.", 400);
    const minuteWindow = Math.floor(timestamp / 60_000);
    const dayWindow = Math.floor(timestamp / 86_400_000);
    const result = await this.db
      .prepare(`
        INSERT INTO bot_access_usage (
          tenant_id, bot_id, user_id, minute_window, minute_count, day_window, day_count,
          rate_limit_per_minute, daily_usage_limit, updated_at
        )
        SELECT b.tenant_id, b.id, ?, ?, 1, ?, 1,
               COALESCE(g.rate_limit_per_minute, p.rate_limit_per_minute, 10),
               COALESCE(g.usage_limit, p.daily_usage_limit, 100), ?
        FROM bots AS b
        LEFT JOIN public_bot_listings AS p ON p.tenant_id = b.tenant_id AND p.bot_id = b.id
        LEFT JOIN bot_access_grants AS g ON g.tenant_id = b.tenant_id AND g.bot_id = b.id
          AND g.user_id = ? AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > ?)
        WHERE b.id = ? AND b.status = 'published' AND (
          (? = 'public' AND b.visibility = 'public' AND p.bot_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM bot_access_grants AS banned WHERE banned.tenant_id = b.tenant_id
                AND banned.bot_id = b.id AND banned.user_id = ? AND banned.status = 'revoked'
            ))
            OR (? = 'shared' AND b.visibility IN ('private', 'shared', 'invitation') AND g.id IS NOT NULL)
        )
        ON CONFLICT(tenant_id, bot_id, user_id) DO UPDATE SET
          minute_window = excluded.minute_window,
          minute_count = CASE WHEN bot_access_usage.minute_window = excluded.minute_window
            THEN bot_access_usage.minute_count + 1 ELSE 1 END,
          day_window = excluded.day_window,
          day_count = CASE WHEN bot_access_usage.day_window = excluded.day_window
            THEN bot_access_usage.day_count + 1 ELSE 1 END,
          rate_limit_per_minute = excluded.rate_limit_per_minute,
          daily_usage_limit = excluded.daily_usage_limit,
          updated_at = excluded.updated_at
        WHERE (bot_access_usage.minute_window != excluded.minute_window
          OR bot_access_usage.minute_count < excluded.rate_limit_per_minute)
          AND (bot_access_usage.day_window != excluded.day_window
            OR bot_access_usage.day_count < excluded.daily_usage_limit)
      `)
      .bind(
        input.userId,
        minuteWindow,
        dayWindow,
        input.now,
        input.userId,
        input.now,
        input.botId,
        input.accessMode,
        input.userId,
        input.accessMode,
      )
      .run();
    if (result.meta.changes === 1) {
      await this.recordBotAccessDecision(input, "allowed");
      return "allowed";
    }

    const access = await this.getBotAccessLimits(input);
    if (!access) {
      await this.recordBotAccessDecision(input, "forbidden");
      return "forbidden";
    }
    const usage = await this.db
      .prepare(`
        SELECT minute_window, minute_count, day_window, day_count
        FROM bot_access_usage WHERE tenant_id = ? AND bot_id = ? AND user_id = ?
      `)
      .bind(access.tenantId, input.botId, input.userId)
      .first<{ minute_window: number; minute_count: number; day_window: number; day_count: number }>();
    const decision: BotAccessDecision =
      usage?.day_window === dayWindow && usage.day_count >= access.dailyLimit
        ? "quota_exceeded"
        : usage?.minute_window === minuteWindow && usage.minute_count >= access.rateLimit
          ? "rate_limited"
          : "forbidden";
    await this.recordBotAccessDecision(input, decision);
    return decision;
  }

  private async recordBotAccessDecision(
    input: {
      readonly botId: BotId;
      readonly userId: UserId;
      readonly accessMode: "public" | "shared";
      readonly now: string;
    },
    decision: BotAccessDecision,
  ): Promise<void> {
    const id = `audit_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, b.tenant_id, ?, 'bot.access.decision', 'bot', b.id, ?, ?
          FROM bots AS b WHERE b.id = ?
        `)
        .bind(
          id,
          input.userId,
          JSON.stringify({ outcome: decision, accessMode: input.accessMode }),
          input.now,
          input.botId,
        )
        .run();
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Security event could not be recorded.", 503, { cause });
    }
  }

  private async requireOwnedAccessBot(
    tenantId: TenantId,
    ownerId: UserId,
    botId: BotId,
  ): Promise<{ visibility: BotVisibility }> {
    const bot = await this.db
      .prepare("SELECT owner_id, visibility FROM bots WHERE tenant_id = ? AND id = ?")
      .bind(tenantId, botId)
      .first<{ owner_id: string; visibility: BotVisibility }>();
    if (!bot || bot.owner_id !== ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    return { visibility: bot.visibility };
  }

  private async getBotAccessLimits(input: {
    botId: BotId;
    userId: UserId;
    accessMode: "public" | "shared";
    now: string;
  }): Promise<{ tenantId: TenantId; dailyLimit: number; rateLimit: number } | undefined> {
    const row = await this.db
      .prepare(`
        SELECT b.tenant_id,
          COALESCE(g.usage_limit, p.daily_usage_limit, 100) AS daily_limit,
          COALESCE(g.rate_limit_per_minute, p.rate_limit_per_minute, 10) AS rate_limit
        FROM bots AS b
        LEFT JOIN public_bot_listings AS p ON p.tenant_id = b.tenant_id AND p.bot_id = b.id
        LEFT JOIN bot_access_grants AS g ON g.tenant_id = b.tenant_id AND g.bot_id = b.id
          AND g.user_id = ? AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > ?)
        WHERE b.id = ? AND b.status = 'published' AND (
          (? = 'public' AND b.visibility = 'public' AND p.bot_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM bot_access_grants AS banned WHERE banned.tenant_id = b.tenant_id
                AND banned.bot_id = b.id AND banned.user_id = ? AND banned.status = 'revoked'
            ))
          OR (? = 'shared' AND b.visibility IN ('private', 'shared', 'invitation') AND g.id IS NOT NULL)
        )
      `)
      .bind(input.userId, input.now, input.botId, input.accessMode, input.userId, input.accessMode)
      .first<{ tenant_id: string; daily_limit: number; rate_limit: number }>();
    return row
      ? { tenantId: row.tenant_id as TenantId, dailyLimit: row.daily_limit, rateLimit: row.rate_limit }
      : undefined;
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

  async create(input: {
    tenantId: TenantId;
    botId: BotId;
    fromOwnerId: UserId;
    toOwnerId: UserId;
    transferId: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<BotOwnershipTransfer> {
    await this.db
      .prepare(`
        UPDATE bot_ownership_transfers SET status = 'expired', token_hash = NULL
        WHERE tenant_id = ? AND bot_id = ? AND status = 'pending' AND expires_at <= ?
      `)
      .bind(input.tenantId, input.botId, input.createdAt)
      .run();
    const bot = await this.db
      .prepare("SELECT owner_id FROM bots WHERE tenant_id = ? AND id = ?")
      .bind(input.tenantId, input.botId)
      .first<{ owner_id: string }>();
    if (!bot || bot.owner_id !== input.fromOwnerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    if (input.fromOwnerId === input.toOwnerId) {
      throw new AppError("VALIDATION_ERROR", "Choose another active workspace member.", 400);
    }
    const recipient = await this.db
      .prepare("SELECT status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?")
      .bind(input.tenantId, input.toOwnerId)
      .first<{ status: string }>();
    if (recipient?.status !== "active") {
      throw new AppError("NOT_FOUND", "The recipient must be an active member of this workspace.", 404);
    }
    const pending = await this.db
      .prepare("SELECT id FROM bot_ownership_transfers WHERE tenant_id = ? AND bot_id = ? AND status = 'pending'")
      .bind(input.tenantId, input.botId)
      .first<{ id: string }>();
    if (pending) throw new AppError("CONFLICT", "This bot already has a pending ownership transfer.", 409);
    try {
      const results = await this.db.batch([
        this.db
          .prepare(`
            INSERT INTO bot_ownership_transfers (
              id, tenant_id, bot_id, from_owner_id, to_owner_id, token_hash, status, created_at, expires_at
            )
            SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
            WHERE EXISTS (SELECT 1 FROM bots WHERE tenant_id = ? AND id = ? AND owner_id = ?)
              AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active')
              AND NOT EXISTS (
                SELECT 1 FROM bot_ownership_transfers WHERE tenant_id = ? AND bot_id = ? AND status = 'pending'
              )
          `)
          .bind(
            input.transferId,
            input.tenantId,
            input.botId,
            input.fromOwnerId,
            input.toOwnerId,
            input.tokenHash,
            input.createdAt,
            input.expiresAt,
            input.tenantId,
            input.botId,
            input.fromOwnerId,
            input.tenantId,
            input.toOwnerId,
            input.tenantId,
            input.botId,
          ),
        this.db
          .prepare(`
            INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
            SELECT ?, ?, ?, 'bot.ownership_transfer.created', 'bot', ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND status = 'pending')
          `)
          .bind(
            crypto.randomUUID(),
            input.tenantId,
            input.fromOwnerId,
            input.botId,
            JSON.stringify({ transferId: input.transferId, toOwnerId: input.toOwnerId }),
            input.createdAt,
            input.transferId,
          ),
      ]);
      if (results[0]?.meta.changes !== 1) {
        throw new AppError("CONFLICT", "Bot ownership changed before the transfer could be created.", 409);
      }
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      const message = String(cause).toLowerCase();
      if (message.includes("unique") || message.includes("constraint")) {
        throw new AppError("CONFLICT", "This bot already has a pending ownership transfer.", 409, { cause });
      }
      throw cause;
    }
    return {
      id: input.transferId,
      botId: input.botId,
      fromOwnerId: input.fromOwnerId,
      toOwnerId: input.toOwnerId,
      status: "pending",
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
  }

  async getPending(input: {
    tenantId: TenantId;
    botId: BotId;
    ownerId: UserId;
    now: string;
  }): Promise<BotOwnershipTransfer | undefined> {
    const row = await this.db
      .prepare(`
        SELECT x.id, x.bot_id, x.from_owner_id, x.to_owner_id, x.status, x.created_at, x.expires_at,
               x.accepted_at, x.revoked_at
        FROM bot_ownership_transfers AS x
        WHERE x.tenant_id = ? AND x.bot_id = ? AND x.from_owner_id = ? AND x.status = 'pending' AND x.expires_at > ?
          AND EXISTS (
            SELECT 1 FROM bots AS b WHERE b.tenant_id = x.tenant_id AND b.id = x.bot_id AND b.owner_id = x.from_owner_id
          )
      `)
      .bind(input.tenantId, input.botId, input.ownerId, input.now)
      .first<BotOwnershipTransferRow>();
    return row ? mapBotOwnershipTransfer(row) : undefined;
  }

  async revoke(input: {
    tenantId: TenantId;
    botId: BotId;
    ownerId: UserId;
    transferId: string;
    now: string;
  }): Promise<BotOwnershipTransfer> {
    const row = await this.db
      .prepare(`
        SELECT id, bot_id, from_owner_id, to_owner_id, status, created_at, expires_at, accepted_at, revoked_at
        FROM bot_ownership_transfers
        WHERE tenant_id = ? AND bot_id = ? AND from_owner_id = ? AND id = ?
      `)
      .bind(input.tenantId, input.botId, input.ownerId, input.transferId)
      .first<BotOwnershipTransferRow>();
    if (!row) throw new AppError("NOT_FOUND", "Ownership transfer was not found.", 404);
    const bot = await this.db
      .prepare("SELECT owner_id FROM bots WHERE tenant_id = ? AND id = ?")
      .bind(input.tenantId, input.botId)
      .first<{ owner_id: string }>();
    if (!bot || bot.owner_id !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    if (row.status === "pending" && row.expires_at <= input.now) {
      await this.db
        .prepare(
          "UPDATE bot_ownership_transfers SET status = 'expired', token_hash = NULL WHERE id = ? AND status = 'pending'",
        )
        .bind(row.id)
        .run();
      return { ...mapBotOwnershipTransfer(row), status: "expired" };
    }
    if (row.status === "revoked") return mapBotOwnershipTransfer(row);
    if (row.status !== "pending") throw new AppError("CONFLICT", "Ownership transfer is no longer pending.", 409);
    const results = await this.db.batch([
      this.db
        .prepare(`
          UPDATE bot_ownership_transfers SET status = 'revoked', token_hash = NULL, revoked_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'pending' AND expires_at > ?
            AND EXISTS (SELECT 1 FROM bots WHERE tenant_id = ? AND id = ? AND owner_id = ?)
        `)
        .bind(input.now, row.id, input.tenantId, input.now, input.tenantId, input.botId, input.ownerId),
      this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, ?, ?, 'bot.ownership_transfer.revoked', 'bot', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND status = 'revoked' AND revoked_at = ?)
        `)
        .bind(
          crypto.randomUUID(),
          input.tenantId,
          input.ownerId,
          input.botId,
          JSON.stringify({ transferId: input.transferId, toOwnerId: row.to_owner_id }),
          input.now,
          row.id,
          input.now,
        ),
    ]);
    if (results[0]?.meta.changes !== 1)
      throw new AppError("CONFLICT", "Ownership transfer changed before revocation.", 409);
    return { ...mapBotOwnershipTransfer(row), status: "revoked", revokedAt: input.now };
  }

  async accept(input: {
    tenantId: TenantId;
    tokenHash: string;
    recipientId: UserId;
    now: string;
  }): Promise<BotOwnershipTransfer> {
    const row = await this.db
      .prepare(`
        SELECT id, bot_id, from_owner_id, to_owner_id, status, created_at, expires_at, accepted_at, revoked_at
        FROM bot_ownership_transfers
        WHERE tenant_id = ? AND token_hash = ? AND to_owner_id = ? AND status = 'pending' AND expires_at > ?
      `)
      .bind(input.tenantId, input.tokenHash, input.recipientId, input.now)
      .first<BotOwnershipTransferRow>();
    if (!row) throw new AppError("NOT_FOUND", "Transfer is invalid, expired, or not addressed to this account.", 404);
    const recipient = await this.db
      .prepare("SELECT status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?")
      .bind(input.tenantId, input.recipientId)
      .first<{ status: string }>();
    if (recipient?.status !== "active") {
      throw new AppError("FORBIDDEN", "Join this workspace before accepting its bot transfer.", 403);
    }
    const running = await this.db
      .prepare(`
        SELECT jobs.id FROM jobs
        JOIN scheduled_tasks ON scheduled_tasks.tenant_id = jobs.tenant_id
          AND json_extract(jobs.payload_json, '$.taskId') = scheduled_tasks.id
        WHERE jobs.tenant_id = ? AND scheduled_tasks.bot_id = ?
          AND jobs.kind = 'scheduled_task' AND jobs.status = 'running' LIMIT 1
      `)
      .bind(input.tenantId, row.bot_id)
      .first<{ id: string }>();
    if (running) {
      throw new AppError(
        "CONFLICT",
        "A scheduled run is active. Wait for it to finish before accepting the transfer.",
        409,
      );
    }
    const results = await this.db.batch([
      this.db
        .prepare(`
          UPDATE bots SET owner_id = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND owner_id = ?
            AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active')
            AND EXISTS (
              SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND tenant_id = ? AND token_hash = ?
                AND status = 'pending' AND expires_at > ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM jobs
              JOIN scheduled_tasks ON scheduled_tasks.tenant_id = jobs.tenant_id
                AND json_extract(jobs.payload_json, '$.taskId') = scheduled_tasks.id
              WHERE jobs.tenant_id = ? AND scheduled_tasks.bot_id = ?
                AND jobs.kind = 'scheduled_task' AND jobs.status = 'running'
            )
        `)
        .bind(
          input.recipientId,
          input.now,
          input.tenantId,
          row.bot_id,
          row.from_owner_id,
          input.tenantId,
          input.recipientId,
          row.id,
          input.tenantId,
          input.tokenHash,
          input.now,
          input.tenantId,
          row.bot_id,
        ),
      this.db
        .prepare(`
          DELETE FROM creation_approvals
          WHERE tenant_id = ? AND session_id IN (
            SELECT id FROM factory_sessions WHERE tenant_id = ? AND bot_id = ?
          )
            AND EXISTS (SELECT 1 FROM bots WHERE tenant_id = ? AND id = ? AND owner_id = ?)
            AND EXISTS (SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND status = 'pending' AND token_hash = ?)
        `)
        .bind(
          input.tenantId,
          input.tenantId,
          row.bot_id,
          input.tenantId,
          row.bot_id,
          input.recipientId,
          row.id,
          input.tokenHash,
        ),
      this.db
        .prepare(`
          UPDATE factory_sessions SET owner_id = ?, updated_at = ?
          WHERE tenant_id = ? AND bot_id = ? AND owner_id = ?
            AND EXISTS (SELECT 1 FROM bots WHERE tenant_id = ? AND id = ? AND owner_id = ?)
            AND EXISTS (SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND status = 'pending' AND token_hash = ?)
        `)
        .bind(
          input.recipientId,
          input.now,
          input.tenantId,
          row.bot_id,
          row.from_owner_id,
          input.tenantId,
          row.bot_id,
          input.recipientId,
          row.id,
          input.tokenHash,
        ),
      this.db
        .prepare(`
          UPDATE scheduled_tasks
          SET owner_id = ?, status = CASE WHEN status = 'active' THEN 'paused' ELSE status END,
              next_run_at = CASE WHEN status = 'active' THEN NULL ELSE next_run_at END, updated_at = ?
          WHERE tenant_id = ? AND bot_id = ?
            AND EXISTS (SELECT 1 FROM bots WHERE tenant_id = ? AND id = ? AND owner_id = ?)
            AND EXISTS (SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND status = 'pending' AND token_hash = ?)
        `)
        .bind(
          input.recipientId,
          input.now,
          input.tenantId,
          row.bot_id,
          input.tenantId,
          row.bot_id,
          input.recipientId,
          row.id,
          input.tokenHash,
        ),
      this.db
        .prepare(`
          UPDATE jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?
          WHERE tenant_id = ? AND kind = 'scheduled_task' AND status IN ('queued', 'retrying')
            AND json_extract(payload_json, '$.taskId') IN (
              SELECT id FROM scheduled_tasks WHERE tenant_id = ? AND bot_id = ?
            )
            AND EXISTS (SELECT 1 FROM bots WHERE tenant_id = ? AND id = ? AND owner_id = ?)
            AND EXISTS (SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND status = 'pending' AND token_hash = ?)
        `)
        .bind(
          input.now,
          input.tenantId,
          input.tenantId,
          row.bot_id,
          input.tenantId,
          row.bot_id,
          input.recipientId,
          row.id,
          input.tokenHash,
        ),
      this.db
        .prepare(`
          UPDATE bot_access_grants SET status = 'revoked', invitation_token_hash = NULL
          WHERE tenant_id = ? AND bot_id = ? AND user_id = ? AND status = 'active'
            AND EXISTS (SELECT 1 FROM bots WHERE tenant_id = ? AND id = ? AND owner_id = ?)
            AND EXISTS (SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND status = 'pending' AND token_hash = ?)
        `)
        .bind(
          input.tenantId,
          row.bot_id,
          row.from_owner_id,
          input.tenantId,
          row.bot_id,
          input.recipientId,
          row.id,
          input.tokenHash,
        ),
      this.db
        .prepare(`
          UPDATE bot_ownership_transfers SET status = 'accepted', token_hash = NULL, accepted_at = ?
          WHERE id = ? AND tenant_id = ? AND token_hash = ? AND status = 'pending' AND expires_at > ?
            AND EXISTS (SELECT 1 FROM bots WHERE tenant_id = ? AND id = ? AND owner_id = ?)
        `)
        .bind(
          input.now,
          row.id,
          input.tenantId,
          input.tokenHash,
          input.now,
          input.tenantId,
          row.bot_id,
          input.recipientId,
        ),
      this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, ?, ?, 'bot.ownership_transfer.accepted', 'bot', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND status = 'accepted' AND accepted_at = ?)
        `)
        .bind(
          crypto.randomUUID(),
          input.tenantId,
          input.recipientId,
          row.bot_id,
          JSON.stringify({ transferId: row.id, fromOwnerId: row.from_owner_id }),
          input.now,
          row.id,
          input.now,
        ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[6]?.meta.changes !== 1) {
      const activeRun = await this.db
        .prepare(`
          SELECT jobs.id FROM jobs
          JOIN scheduled_tasks ON scheduled_tasks.tenant_id = jobs.tenant_id
            AND json_extract(jobs.payload_json, '$.taskId') = scheduled_tasks.id
          WHERE jobs.tenant_id = ? AND scheduled_tasks.bot_id = ?
            AND jobs.kind = 'scheduled_task' AND jobs.status = 'running' LIMIT 1
        `)
        .bind(input.tenantId, row.bot_id)
        .first<{ id: string }>();
      if (activeRun) {
        throw new AppError(
          "CONFLICT",
          "A scheduled run is active. Wait for it to finish before accepting the transfer.",
          409,
        );
      }
      throw new AppError("CONFLICT", "Bot ownership changed before this transfer was accepted.", 409);
    }
    return { ...mapBotOwnershipTransfer(row), status: "accepted", acceptedAt: input.now };
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
        ...(input.answers.imageModel ? { imageModel: input.answers.imageModel } : {}),
        ...(input.answers.searchModel ? { searchModel: input.answers.searchModel } : {}),
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

  async listOwnedConversations(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    limit: number;
    offset: number;
  }): Promise<readonly ConversationSummary[]> {
    const bot = await this.db
      .prepare("SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?")
      .bind(input.tenantId, input.ownerId, input.botId)
      .first<{ id: string }>();
    if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    const result = await this.db
      .prepare(`
        SELECT c.id, c.platform, c.created_at, c.updated_at,
          (SELECT count(*) FROM messages AS m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id) AS message_count,
          COALESCE((
            SELECT substr(m.content, 1, 280) FROM messages AS m
            WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.role IN ('user', 'assistant')
            ORDER BY m.sequence DESC LIMIT 1
          ), '') AS preview
        FROM conversations AS c
        JOIN bots AS b ON b.id = c.bot_id AND b.tenant_id = c.tenant_id
        WHERE c.tenant_id = ? AND b.owner_id = ? AND c.bot_id = ?
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ? OFFSET ?
      `)
      .bind(input.tenantId, input.ownerId, input.botId, input.limit, input.offset)
      .all<{
        id: string;
        platform: ConversationSummary["platform"];
        message_count: number;
        preview: string;
        created_at: string;
        updated_at: string;
      }>();
    return result.results.map((row) => ({
      id: row.id as ConversationId,
      platform: row.platform,
      messageCount: row.message_count,
      preview: row.preview,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getOwnedConversationMessages(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    conversationId: ConversationId;
    limit: number;
    beforeSequence?: number;
  }): Promise<{ items: readonly StoredConversationMessage[]; hasMore: boolean } | undefined> {
    const exists = await this.db
      .prepare(`
        SELECT c.id FROM conversations AS c
        JOIN bots AS b ON b.id = c.bot_id AND b.tenant_id = c.tenant_id
        WHERE c.tenant_id = ? AND b.owner_id = ? AND c.bot_id = ? AND c.id = ?
      `)
      .bind(input.tenantId, input.ownerId, input.botId, input.conversationId)
      .first<{ id: string }>();
    if (!exists) return undefined;
    const before = input.beforeSequence ?? null;
    const result = await this.db
      .prepare(`
        SELECT id, sequence, role, content, metadata_json, created_at FROM (
          SELECT id, sequence, role, content, metadata_json, created_at
          FROM messages
          WHERE tenant_id = ? AND conversation_id = ? AND (? IS NULL OR sequence < ?)
          ORDER BY sequence DESC LIMIT ?
        ) ORDER BY sequence ASC
      `)
      .bind(input.tenantId, input.conversationId, before, before, input.limit + 1)
      .all<ConversationHistoryMessageRow>();
    const hasMore = result.results.length > input.limit;
    const rows = hasMore ? result.results.slice(1) : result.results;
    return { items: rows.map(mapStoredConversationMessage), hasMore };
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO usage_records (
          id, tenant_id, bot_id, actor_id, provider_id, model, input_tokens, output_tokens, usage_reported, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        record.id,
        record.tenantId,
        record.botId,
        record.actorId ?? null,
        record.providerId,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.usageReported ? 1 : 0,
        record.createdAt,
      )
      .run();
  }

  async recordModelRetry(record: Parameters<UsageRepository["recordModelRetry"]>[0]): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO model_retry_events (
          id, tenant_id, bot_id, attempt, max_attempts, delay_ms, status_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        record.id,
        record.tenantId,
        record.botId,
        record.attempt,
        record.maxAttempts,
        record.delayMs,
        record.statusCode,
        record.createdAt,
      )
      .run();
  }

  async getOwnedUsageSummary(input: {
    tenantId: TenantId;
    ownerId: UserId;
    from: string;
    through: string;
  }): Promise<UsageSummary> {
    const [dailyResult, botResult, retryDailyResult, retryBotResult, retryStatusResult] = await Promise.all([
      this.db
        .prepare(`
          SELECT substr(u.created_at, 1, 10) AS date, count(*) AS requests,
            sum(u.usage_reported) AS reported_requests,
            sum(CASE WHEN u.usage_reported = 1 THEN u.input_tokens ELSE 0 END) AS input_tokens,
            sum(CASE WHEN u.usage_reported = 1 THEN u.output_tokens ELSE 0 END) AS output_tokens
          FROM usage_records AS u JOIN bots AS b ON b.id = u.bot_id AND b.tenant_id = u.tenant_id
          WHERE u.tenant_id = ? AND b.owner_id = ? AND u.created_at >= ? AND u.created_at <= ?
          GROUP BY substr(u.created_at, 1, 10) ORDER BY date ASC
        `)
        .bind(input.tenantId, input.ownerId, input.from, input.through)
        .all<UsageAggregateRow>(),
      this.db
        .prepare(`
          SELECT b.id AS bot_id, b.name AS bot_name, count(*) AS requests,
            sum(u.usage_reported) AS reported_requests,
            sum(CASE WHEN u.usage_reported = 1 THEN u.input_tokens ELSE 0 END) AS input_tokens,
            sum(CASE WHEN u.usage_reported = 1 THEN u.output_tokens ELSE 0 END) AS output_tokens
          FROM usage_records AS u JOIN bots AS b ON b.id = u.bot_id AND b.tenant_id = u.tenant_id
          WHERE u.tenant_id = ? AND b.owner_id = ? AND u.created_at >= ? AND u.created_at <= ?
          GROUP BY b.id ORDER BY requests DESC, b.name ASC LIMIT 100
        `)
        .bind(input.tenantId, input.ownerId, input.from, input.through)
        .all<UsageBotAggregateRow>(),
      this.db
        .prepare(`
          SELECT substr(r.created_at, 1, 10) AS date, count(*) AS retries
          FROM model_retry_events AS r JOIN bots AS b ON b.id = r.bot_id AND b.tenant_id = r.tenant_id
          WHERE r.tenant_id = ? AND b.owner_id = ? AND r.created_at >= ? AND r.created_at <= ?
          GROUP BY substr(r.created_at, 1, 10) ORDER BY date ASC
        `)
        .bind(input.tenantId, input.ownerId, input.from, input.through)
        .all<ModelRetryAggregateRow>(),
      this.db
        .prepare(`
          SELECT b.id AS bot_id, b.name AS bot_name, count(*) AS retries
          FROM model_retry_events AS r JOIN bots AS b ON b.id = r.bot_id AND b.tenant_id = r.tenant_id
          WHERE r.tenant_id = ? AND b.owner_id = ? AND r.created_at >= ? AND r.created_at <= ?
          GROUP BY b.id ORDER BY retries DESC, b.name ASC LIMIT 100
        `)
        .bind(input.tenantId, input.ownerId, input.from, input.through)
        .all<ModelRetryBotAggregateRow>(),
      this.db
        .prepare(`
          SELECT r.status_code, count(*) AS retries
          FROM model_retry_events AS r JOIN bots AS b ON b.id = r.bot_id AND b.tenant_id = r.tenant_id
          WHERE r.tenant_id = ? AND b.owner_id = ? AND r.created_at >= ? AND r.created_at <= ?
          GROUP BY r.status_code ORDER BY retries DESC, r.status_code ASC
        `)
        .bind(input.tenantId, input.ownerId, input.from, input.through)
        .all<ModelRetryStatusAggregateRow>(),
    ]);
    const total = dailyResult.results.reduce(
      (sum, row) => ({
        requests: sum.requests + row.requests,
        reportedRequests: sum.reportedRequests + row.reported_requests,
        inputTokens: sum.inputTokens + row.input_tokens,
        outputTokens: sum.outputTokens + row.output_tokens,
      }),
      { requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0 },
    );
    return {
      from: input.from,
      through: input.through,
      total,
      byDay: dailyResult.results.map((row) => ({
        date: row.date,
        requests: row.requests,
        reportedRequests: row.reported_requests,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
      byBot: botResult.results.map((row) => ({
        botId: row.bot_id as BotId,
        botName: row.bot_name,
        requests: row.requests,
        reportedRequests: row.reported_requests,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
      modelRetries: {
        total: retryDailyResult.results.reduce((sum, row) => sum + row.retries, 0),
        byDay: retryDailyResult.results.map((row) => ({ date: row.date, retries: row.retries })),
        byBot: retryBotResult.results.map((row) => ({
          botId: row.bot_id as BotId,
          botName: row.bot_name,
          retries: row.retries,
        })),
        byStatusCode: retryStatusResult.results.map((row) => ({
          statusCode: row.status_code,
          retries: row.retries,
        })),
      },
    };
  }

  async listOwnedBotMemory(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
  }): Promise<readonly StoredBotMemoryRecord[]> {
    const bot = await this.db
      .prepare("SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?")
      .bind(input.tenantId, input.ownerId, input.botId)
      .first<{ id: string }>();
    if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    const rows = await this.db
      .prepare(`
        SELECT id, bot_id, memory_key, value_json, encrypted_value, expires_at, created_at, updated_at
        FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL
        ORDER BY updated_at DESC, memory_key ASC LIMIT 16
      `)
      .bind(input.tenantId, input.botId)
      .all<MemoryRow>();
    return rows.results.map(mapBotMemory);
  }

  async listActiveBotMemory(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    now: string;
  }): Promise<readonly StoredBotMemoryRecord[]> {
    const bot = await this.db
      .prepare("SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?")
      .bind(input.tenantId, input.ownerId, input.botId)
      .first<{ id: string }>();
    if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    const rows = await this.db
      .prepare(`
        SELECT id, bot_id, memory_key, value_json, encrypted_value, expires_at, created_at, updated_at
        FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL
        ORDER BY updated_at DESC, memory_key ASC LIMIT 16
      `)
      .bind(input.tenantId, input.botId)
      .all<MemoryRow>();
    return rows.results.map(mapBotMemory);
  }

  async putOwnedBotMemory(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    key: string;
    value: string;
    encryptedValue?: boolean;
    expiresAt?: string;
    now: string;
  }): Promise<StoredBotMemoryRecord> {
    const bot = await this.db
      .prepare("SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?")
      .bind(input.tenantId, input.ownerId, input.botId)
      .first<{ id: string }>();
    if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    await this.db
      .prepare("DELETE FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND expires_at <= ?")
      .bind(input.tenantId, input.botId, input.now)
      .run();
    const existing = await this.db
      .prepare(
        "SELECT id FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND memory_key = ?",
      )
      .bind(input.tenantId, input.botId, input.key)
      .first<{ id: string }>();
    if (!existing) {
      const count = await this.db
        .prepare("SELECT count(*) AS count FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL")
        .bind(input.tenantId, input.botId)
        .first<{ count: number }>();
      if ((count?.count ?? 0) >= 16) throw new AppError("CONFLICT", "A bot can store at most 16 memory records.", 409);
      await this.db
        .prepare(`
          INSERT INTO memory_records (id, tenant_id, bot_id, actor_id, memory_key, value_json, encrypted_value, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          `memory_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.botId,
          input.key,
          JSON.stringify(input.value),
          input.encryptedValue ? 1 : 0,
          input.expiresAt ?? null,
          input.now,
          input.now,
        )
        .run();
    } else {
      await this.db
        .prepare(`
          UPDATE memory_records SET value_json = ?, encrypted_value = ?, expires_at = ?, updated_at = ?
          WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND memory_key = ?
        `)
        .bind(
          JSON.stringify(input.value),
          input.encryptedValue ? 1 : 0,
          input.expiresAt ?? null,
          input.now,
          input.tenantId,
          input.botId,
          input.key,
        )
        .run();
    }
    const row = await this.db
      .prepare(`
        SELECT id, bot_id, memory_key, value_json, encrypted_value, expires_at, created_at, updated_at
        FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND memory_key = ?
      `)
      .bind(input.tenantId, input.botId, input.key)
      .first<MemoryRow>();
    if (!row) throw new AppError("INTERNAL_ERROR", "Saved memory could not be loaded.", 500);
    return mapBotMemory(row);
  }

  async deleteOwnedBotMemory(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    key: string;
  }): Promise<boolean> {
    const bot = await this.db
      .prepare("SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?")
      .bind(input.tenantId, input.ownerId, input.botId)
      .first<{ id: string }>();
    if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    const result = await this.db
      .prepare("DELETE FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND memory_key = ?")
      .bind(input.tenantId, input.botId, input.key)
      .run();
    return result.meta.changes > 0;
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
      input.telegramUserIds.length === 0
        ? this.db.prepare("DELETE FROM telegram_allowed_users WHERE deployment_id = ?").bind(input.deploymentId)
        : this.db
            .prepare(
              `DELETE FROM telegram_allowed_users WHERE deployment_id = ? AND telegram_user_id NOT IN (${input.telegramUserIds.map(() => "?").join(", ")})`,
            )
            .bind(input.deploymentId, ...input.telegramUserIds),
      ...input.telegramUserIds.map((telegramUserId) =>
        this.db
          .prepare(
            "INSERT INTO telegram_allowed_users (deployment_id, telegram_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          )
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

  async listTelegramToolGrants(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
  }): Promise<readonly string[]> {
    validateTelegramUserId(input.telegramUserId);
    const result = await this.db
      .prepare(`
        SELECT g.tool_ref FROM telegram_tool_grants AS g
        JOIN telegram_allowed_users AS a
          ON a.deployment_id = g.deployment_id AND a.telegram_user_id = g.telegram_user_id
        WHERE g.deployment_id = ? AND g.telegram_user_id = ? ORDER BY g.tool_ref
      `)
      .bind(input.deploymentId, input.telegramUserId)
      .all<{ tool_ref: string }>();
    return result.results.map(({ tool_ref }) => tool_ref);
  }

  async replaceTelegramToolGrants(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
    toolRefs: readonly string[];
    now: string;
  }): Promise<void> {
    validateTelegramUserId(input.telegramUserId);
    validateTelegramToolRefs(input.toolRefs);
    const allowed = await this.db
      .prepare(`
        SELECT 1 AS allowed FROM bot_deployments AS d
        JOIN telegram_allowed_users AS a ON a.deployment_id = d.id
        WHERE d.id = ? AND d.interface = 'telegram' AND d.status = 'active' AND a.telegram_user_id = ?
      `)
      .bind(input.deploymentId, input.telegramUserId)
      .first<{ allowed: number }>();
    if (!allowed) throw new AppError("FORBIDDEN", "Telegram tool grants require an approved sender.", 403);
    const statements = [
      this.db
        .prepare("DELETE FROM telegram_tool_grants WHERE deployment_id = ? AND telegram_user_id = ?")
        .bind(input.deploymentId, input.telegramUserId),
      ...input.toolRefs.map((toolRef) =>
        this.db
          .prepare(
            "INSERT INTO telegram_tool_grants (deployment_id, telegram_user_id, tool_ref, created_at) VALUES (?, ?, ?, ?)",
          )
          .bind(input.deploymentId, input.telegramUserId, toolRef, input.now),
      ),
    ];
    try {
      await this.db.batch(statements);
    } catch {
      throw new AppError("CONFLICT", "Telegram tool grants could not be updated.", 409);
    }
  }

  async isTelegramToolAllowed(input: {
    deploymentId: TelegramDeploymentId;
    telegramUserId: number;
    toolRef: string;
  }): Promise<boolean> {
    validateTelegramUserId(input.telegramUserId);
    const row = await this.db
      .prepare(`
        SELECT 1 AS allowed FROM telegram_tool_grants AS g
        JOIN telegram_allowed_users AS a
          ON a.deployment_id = g.deployment_id AND a.telegram_user_id = g.telegram_user_id
        JOIN bot_deployments AS d ON d.id = g.deployment_id AND d.interface = 'telegram'
        WHERE g.deployment_id = ? AND g.telegram_user_id = ? AND g.tool_ref = ? AND d.status = 'active'
      `)
      .bind(input.deploymentId, input.telegramUserId, input.toolRef)
      .first<{ allowed: number }>();
    return row !== null;
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
        INSERT INTO telegram_updates (
          deployment_id, update_id, state, response_text, response_attachments_json, lease_until, created_at, updated_at
        )
        VALUES (?, ?, 'processing', NULL, '[]', ?, ?, ?)
        ON CONFLICT(deployment_id, update_id) DO UPDATE SET
          state = CASE WHEN telegram_updates.state = 'ready' THEN 'ready' ELSE 'processing' END,
          response_text = CASE WHEN telegram_updates.state = 'ready' THEN telegram_updates.response_text ELSE NULL END,
          response_attachments_json = CASE WHEN telegram_updates.state = 'ready'
            THEN telegram_updates.response_attachments_json ELSE '[]' END,
          lease_until = excluded.lease_until,
          updated_at = excluded.updated_at
        WHERE telegram_updates.state != 'completed' AND telegram_updates.lease_until <= ?
      `)
      .bind(input.deploymentId, input.updateId, input.leaseUntil, input.now, input.now, input.now)
      .run();
    const row = await this.db
      .prepare(
        `SELECT state, response_text, response_attachments_json, lease_until
         FROM telegram_updates WHERE deployment_id = ? AND update_id = ?`,
      )
      .bind(input.deploymentId, input.updateId)
      .first<TelegramUpdateRow>();
    if (!row) throw new AppError("CONFLICT", "Telegram update reservation failed.", 409);
    if (row.state === "completed") {
      const attachmentRefs = parseTelegramAttachmentRefs(row.response_attachments_json);
      return {
        state: "completed" as const,
        ...(attachmentRefs.length ? { attachmentRefs } : {}),
      };
    }
    if (result.meta.changes === 0 || row.lease_until !== input.leaseUntil) return { state: "busy" as const };
    if (row.state === "ready") {
      const attachmentRefs = parseTelegramAttachmentRefs(row.response_attachments_json);
      return {
        state: "ready" as const,
        responseText: row.response_text ?? "",
        ...(attachmentRefs.length ? { attachmentRefs } : {}),
      };
    }
    return { state: "acquired" as const };
  }

  async saveTelegramUpdateResponse(input: {
    deploymentId: TelegramDeploymentId;
    updateId: number;
    responseText: string;
    attachmentRefs?: readonly { readonly kind: "image"; readonly secretRef: string }[];
    leaseUntil: string;
    now: string;
  }): Promise<void> {
    if (input.responseText.length > 100_000)
      throw new AppError("VALIDATION_ERROR", "Telegram response is too large.", 400);
    const attachmentRefs = validateTelegramAttachmentRefs(input.attachmentRefs ?? []);
    const result = await this.db
      .prepare(`
        UPDATE telegram_updates SET state = 'ready', response_text = ?, response_attachments_json = ?,
          lease_until = ?, updated_at = ?
        WHERE deployment_id = ? AND update_id = ? AND state = 'processing'
      `)
      .bind(
        input.responseText,
        JSON.stringify(attachmentRefs),
        input.leaseUntil,
        input.now,
        input.deploymentId,
        input.updateId,
      )
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

  async clearTelegramUpdateAttachments(input: { deploymentId: TelegramDeploymentId; updateId: number }): Promise<void> {
    await this.db
      .prepare(`
        UPDATE telegram_updates SET response_attachments_json = '[]'
        WHERE deployment_id = ? AND update_id = ? AND state = 'completed'
      `)
      .bind(input.deploymentId, input.updateId)
      .run();
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

  async retryFailedScheduledTask(input: {
    tenantId: TenantId;
    ownerId: UserId;
    taskId: ScheduledTaskId;
    now: string;
  }): Promise<JobId | undefined> {
    const job = await this.db
      .prepare(`
        SELECT jobs.id FROM jobs
        JOIN scheduled_tasks
          ON scheduled_tasks.tenant_id = jobs.tenant_id
          AND json_extract(jobs.payload_json, '$.taskId') = scheduled_tasks.id
        WHERE jobs.tenant_id = ? AND jobs.kind = 'scheduled_task' AND jobs.status = 'failed'
          AND scheduled_tasks.tenant_id = ? AND scheduled_tasks.owner_id = ?
          AND scheduled_tasks.id = ? AND scheduled_tasks.status = 'failed'
        ORDER BY jobs.updated_at DESC, jobs.id DESC LIMIT 1
      `)
      .bind(input.tenantId, input.tenantId, input.ownerId, input.taskId)
      .first<{ id: string }>();
    if (!job) return undefined;
    const results = await this.db.batch([
      this.db
        .prepare(`
          UPDATE jobs SET status = 'queued', attempts = 0, available_at = ?, lease_until = NULL, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND kind = 'scheduled_task' AND status = 'failed'
            AND EXISTS (
              SELECT 1 FROM scheduled_tasks
              WHERE tenant_id = ? AND owner_id = ? AND id = ? AND status = 'failed'
            )
        `)
        .bind(input.now, input.now, job.id, input.tenantId, input.tenantId, input.ownerId, input.taskId),
      this.db
        .prepare(`
          UPDATE scheduled_tasks SET status = 'active', next_run_at = ?, updated_at = ?
          WHERE tenant_id = ? AND owner_id = ? AND id = ? AND status = 'failed'
            AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'queued')
        `)
        .bind(input.now, input.now, input.tenantId, input.ownerId, input.taskId, job.id),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new AppError("CONFLICT", "Failed scheduled run changed before it could be retried.", 409);
    }
    return job.id as JobId;
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

  async listSecrets(
    after: { readonly tenantId: TenantId; readonly reference: string } | undefined,
    limit: number,
  ): Promise<readonly EncryptedSecretRecord[]> {
    const query = after
      ? this.db
          .prepare(`
            SELECT tenant_id, reference, key_id, nonce, ciphertext, envelope_version, created_at
            FROM encrypted_secrets
            WHERE tenant_id > ? OR (tenant_id = ? AND reference > ?)
            ORDER BY tenant_id, reference LIMIT ?
          `)
          .bind(after.tenantId, after.tenantId, after.reference, limit)
      : this.db
          .prepare(`
            SELECT tenant_id, reference, key_id, nonce, ciphertext, envelope_version, created_at
            FROM encrypted_secrets ORDER BY tenant_id, reference LIMIT ?
          `)
          .bind(limit);
    const result = await query.all<SecretRow>();
    return (result.results ?? []).map(mapSecretRow);
  }

  async replaceSecretIfUnchanged(
    record: EncryptedSecretRecord,
    expected: { readonly keyId: string; readonly nonce: string; readonly ciphertext: string },
  ): Promise<boolean> {
    const result = await this.db
      .prepare(`
        UPDATE encrypted_secrets
        SET key_id = ?, nonce = ?, ciphertext = ?, envelope_version = ?, created_at = ?
        WHERE tenant_id = ? AND reference = ? AND key_id = ? AND nonce = ? AND ciphertext = ?
      `)
      .bind(
        record.keyId,
        record.nonce,
        record.ciphertext,
        record.version,
        record.createdAt,
        record.tenantId,
        record.reference,
        expected.keyId,
        expected.nonce,
        expected.ciphertext,
      )
      .run();
    return result.meta.changes === 1;
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
        SELECT t.id, t.tenant_id, t.owner_id, t.scopes_json, t.expires_at, m.role
        FROM api_tokens AS t
        JOIN tenant_memberships AS m
          ON m.tenant_id = t.tenant_id AND m.user_id = t.owner_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND m.status = 'active'
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
      tenantRole: row.role,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    };
  }

  async listWorkspacesForUser(userId: UserId): Promise<readonly TenantWorkspace[]> {
    const result = await this.db
      .prepare(`
        SELECT t.id AS tenant_id, t.name, m.role, m.created_at
        FROM tenant_memberships AS m
        JOIN tenants AS t ON t.id = m.tenant_id
        WHERE m.user_id = ? AND m.status = 'active'
        ORDER BY m.created_at ASC, t.id ASC
      `)
      .bind(userId)
      .all<{ tenant_id: string; name: string; role: TenantRole; created_at: string }>();
    return result.results.map((row) => ({
      tenantId: row.tenant_id as TenantId,
      name: row.name,
      role: row.role,
      createdAt: row.created_at,
    }));
  }

  async getActiveTenantRole(input: {
    readonly tenantId: TenantId;
    readonly userId: UserId;
  }): Promise<TenantRole | undefined> {
    const row = await this.db
      .prepare(`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND status = 'active'
      `)
      .bind(input.tenantId, input.userId)
      .first<{ role: TenantRole }>();
    return row?.role;
  }

  async listTenantMembers(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
  }): Promise<readonly TenantMember[]> {
    const actor = await this.db
      .prepare(`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND status = 'active'
      `)
      .bind(input.tenantId, input.actorId)
      .first<{ role: TenantRole }>();
    if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
      throw new AppError("FORBIDDEN", "Tenant owner or admin role is required to list members.", 403);
    }
    const result = await this.db
      .prepare(`
        SELECT m.user_id, m.role, m.status, m.created_at,
               (SELECT COUNT(*) FROM bots AS b
                WHERE b.tenant_id = m.tenant_id AND b.owner_id = m.user_id) AS owned_bot_count
        FROM tenant_memberships AS m
        WHERE m.tenant_id = ?
        ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.role, m.created_at, m.user_id
      `)
      .bind(input.tenantId)
      .all<TenantMemberRow>();
    return result.results.map(mapTenantMember);
  }

  async addTenantMember(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly memberId: UserId;
    readonly role: Exclude<TenantRole, "owner">;
    readonly now: string;
  }): Promise<TenantMember> {
    await this.#assertTenantOwner(input.tenantId, input.actorId);
    const user = await this.db
      .prepare("SELECT id FROM users WHERE id = ?")
      .bind(input.memberId)
      .first<{ id: string }>();
    if (!user) throw new AppError("NOT_FOUND", "User account was not found.", 404);
    const existing = await this.db
      .prepare("SELECT role, status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?")
      .bind(input.tenantId, input.memberId)
      .first<{ role: TenantRole; status: "active" | "inactive" }>();
    if (existing?.status === "active") throw new AppError("CONFLICT", "User is already an active tenant member.", 409);
    const action = existing ? "tenant.member.reactivated" : "tenant.member.added";
    const metadata = JSON.stringify({
      role: input.role,
      ...(existing ? { previousRole: existing.role } : {}),
    });
    const memberMutation = existing
      ? this.db
          .prepare(`
            UPDATE tenant_memberships SET role = ?, status = 'active'
            WHERE tenant_id = ? AND user_id = ? AND status = 'inactive'
              AND EXISTS (
                SELECT 1 FROM tenant_memberships AS actor
                WHERE actor.tenant_id = ? AND actor.user_id = ? AND actor.role = 'owner' AND actor.status = 'active'
              )
          `)
          .bind(input.role, input.tenantId, input.memberId, input.tenantId, input.actorId)
      : this.db
          .prepare(`
            INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at, status)
            SELECT ?, ?, ?, ?, 'active'
            WHERE EXISTS (
              SELECT 1 FROM tenant_memberships AS actor
              WHERE actor.tenant_id = ? AND actor.user_id = ? AND actor.role = 'owner' AND actor.status = 'active'
            )
            ON CONFLICT (tenant_id, user_id) DO NOTHING
          `)
          .bind(input.tenantId, input.memberId, input.role, input.now, input.tenantId, input.actorId);
    const results = await this.db.batch([
      memberMutation,
      this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, ?, ?, ?, 'tenant_member', ?, ?, ?
          WHERE changes() = 1
        `)
        .bind(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.actorId,
          action,
          input.memberId,
          metadata,
          input.now,
        ),
    ]);
    if (results[0]?.meta.changes !== 1)
      throw new AppError("CONFLICT", "Membership changed before it could be added.", 409);
    return this.#getTenantMember(input.tenantId, input.memberId);
  }

  async changeTenantMemberRole(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly memberId: UserId;
    readonly role: TenantRole;
    readonly now: string;
  }): Promise<TenantMember> {
    await this.#assertTenantOwner(input.tenantId, input.actorId);
    const member = await this.db
      .prepare("SELECT role, status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?")
      .bind(input.tenantId, input.memberId)
      .first<{ role: TenantRole; status: "active" | "inactive" }>();
    if (member?.status !== "active") throw new AppError("NOT_FOUND", "Active tenant member was not found.", 404);
    if (member.role === input.role) return this.#getTenantMember(input.tenantId, input.memberId);
    const results = await this.db.batch([
      this.db
        .prepare(`
          UPDATE tenant_memberships SET role = ?
          WHERE tenant_id = ? AND user_id = ? AND status = 'active' AND role = ?
            AND EXISTS (
              SELECT 1 FROM tenant_memberships AS actor
              WHERE actor.tenant_id = ? AND actor.user_id = ? AND actor.role = 'owner' AND actor.status = 'active'
            )
            AND (role != 'owner' OR ? = 'owner' OR (
              SELECT COUNT(*) FROM tenant_memberships
              WHERE tenant_id = ? AND status = 'active' AND role = 'owner'
            ) > 1)
        `)
        .bind(
          input.role,
          input.tenantId,
          input.memberId,
          member.role,
          input.tenantId,
          input.actorId,
          input.role,
          input.tenantId,
        ),
      this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, ?, ?, 'tenant.member.role_changed', 'tenant_member', ?, ?, ? WHERE changes() = 1
        `)
        .bind(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.actorId,
          input.memberId,
          JSON.stringify({ previousRole: member.role, role: input.role }),
          input.now,
        ),
    ]);
    if (results[0]?.meta.changes !== 1) {
      if (member.role === "owner" && input.role !== "owner") {
        const owners = await this.#activeOwnerCount(input.tenantId);
        if (owners <= 1) throw new AppError("CONFLICT", "A tenant must retain at least one active owner.", 409);
      }
      throw new AppError("CONFLICT", "Membership changed before its role could be updated.", 409);
    }
    return this.#getTenantMember(input.tenantId, input.memberId);
  }

  async deactivateTenantMember(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly memberId: UserId;
    readonly now: string;
  }): Promise<TenantMember> {
    await this.#assertTenantOwner(input.tenantId, input.actorId);
    const member = await this.db
      .prepare("SELECT role, status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?")
      .bind(input.tenantId, input.memberId)
      .first<{ role: TenantRole; status: "active" | "inactive" }>();
    if (member?.status !== "active") throw new AppError("NOT_FOUND", "Active tenant member was not found.", 404);
    const auditId = `audit_${crypto.randomUUID().replaceAll("-", "")}`;
    const results = await this.db.batch([
      this.db
        .prepare(`
          UPDATE tenant_memberships SET status = 'inactive'
          WHERE tenant_id = ? AND user_id = ? AND status = 'active' AND role = ?
            AND EXISTS (
              SELECT 1 FROM tenant_memberships AS actor
              WHERE actor.tenant_id = ? AND actor.user_id = ? AND actor.role = 'owner' AND actor.status = 'active'
            )
            AND (role != 'owner' OR (
              SELECT COUNT(*) FROM tenant_memberships
              WHERE tenant_id = ? AND status = 'active' AND role = 'owner'
            ) > 1)
        `)
        .bind(input.tenantId, input.memberId, member.role, input.tenantId, input.actorId, input.tenantId),
      this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, ?, ?, 'tenant.member.deactivated', 'tenant_member', ?,
                 json_object('role', ?, 'revokedTokens', (
                   SELECT COUNT(*) FROM api_tokens WHERE tenant_id = ? AND owner_id = ? AND revoked_at IS NULL
                 )), ?
          WHERE changes() = 1
        `)
        .bind(
          auditId,
          input.tenantId,
          input.actorId,
          input.memberId,
          member.role,
          input.tenantId,
          input.memberId,
          input.now,
        ),
      this.db
        .prepare(`
          UPDATE api_tokens SET revoked_at = ?
          WHERE tenant_id = ? AND owner_id = ? AND revoked_at IS NULL
            AND EXISTS (
              SELECT 1 FROM audit_logs WHERE id = ? AND action = 'tenant.member.deactivated'
            )
        `)
        .bind(input.now, input.tenantId, input.memberId, auditId),
    ]);
    if (results[0]?.meta.changes !== 1) {
      if (member.role === "owner" && (await this.#activeOwnerCount(input.tenantId)) <= 1) {
        throw new AppError("CONFLICT", "A tenant must retain at least one active owner.", 409);
      }
      throw new AppError("CONFLICT", "Membership changed before it could be deactivated.", 409);
    }
    return this.#getTenantMember(input.tenantId, input.memberId);
  }

  async listTenantInvitations(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly now: string;
  }): Promise<readonly TenantInvitation[]> {
    const actor = await this.db
      .prepare(`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND status = 'active'
      `)
      .bind(input.tenantId, input.actorId)
      .first<{ role: TenantRole }>();
    if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
      throw new AppError("FORBIDDEN", "Tenant owner or admin role is required to list invitations.", 403);
    }
    const result = await this.db
      .prepare(`
        SELECT id, tenant_id, role, status, created_by, created_at, expires_at, accepted_by, accepted_at
        FROM tenant_invitations
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `)
      .bind(input.tenantId)
      .all<TenantInvitationRow>();
    return result.results.map((row) => mapTenantInvitation(row, input.now));
  }

  async createTenantInvitation(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly invitationId: string;
    readonly tokenHash: string;
    readonly role: Exclude<TenantRole, "owner">;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<TenantInvitation> {
    await this.#assertTenantOwner(input.tenantId, input.actorId);
    const results = await this.db.batch([
      this.db
        .prepare(`
          INSERT INTO tenant_invitations
            (id, tenant_id, token_hash, role, status, created_by, created_at, expires_at)
          SELECT ?, ?, ?, ?, 'pending', ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM tenant_memberships
            WHERE tenant_id = ? AND user_id = ? AND role = 'owner' AND status = 'active'
          )
        `)
        .bind(
          input.invitationId,
          input.tenantId,
          input.tokenHash,
          input.role,
          input.actorId,
          input.createdAt,
          input.expiresAt,
          input.tenantId,
          input.actorId,
        ),
      this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, ?, ?, 'tenant.invitation.created', 'tenant_invitation', ?, ?, ? WHERE changes() = 1
        `)
        .bind(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.actorId,
          input.invitationId,
          JSON.stringify({ role: input.role, expiresAt: input.expiresAt }),
          input.createdAt,
        ),
    ]);
    if (results[0]?.meta.changes !== 1) {
      throw new AppError("CONFLICT", "Invitation could not be created for this workspace.", 409);
    }
    return this.#getTenantInvitation(input.tenantId, input.invitationId, input.createdAt);
  }

  async revokeTenantInvitation(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly invitationId: string;
    readonly now: string;
  }): Promise<TenantInvitation> {
    await this.#assertTenantOwner(input.tenantId, input.actorId);
    const results = await this.db.batch([
      this.db
        .prepare(`
          UPDATE tenant_invitations SET status = 'revoked'
          WHERE tenant_id = ? AND id = ? AND status = 'pending'
            AND EXISTS (
              SELECT 1 FROM tenant_memberships
              WHERE tenant_id = ? AND user_id = ? AND role = 'owner' AND status = 'active'
            )
        `)
        .bind(input.tenantId, input.invitationId, input.tenantId, input.actorId),
      this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, ?, ?, 'tenant.invitation.revoked', 'tenant_invitation', ?,
                 json_object('role', (SELECT role FROM tenant_invitations WHERE tenant_id = ? AND id = ?)), ?
          WHERE changes() = 1
        `)
        .bind(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.actorId,
          input.invitationId,
          input.tenantId,
          input.invitationId,
          input.now,
        ),
    ]);
    if (results[0]?.meta.changes !== 1) {
      throw new AppError("NOT_FOUND", "Pending invitation was not found.", 404);
    }
    return this.#getTenantInvitation(input.tenantId, input.invitationId, input.now);
  }

  async acceptTenantInvitation(input: {
    readonly tokenHash: string;
    readonly userId: UserId;
    readonly now: string;
  }): Promise<{ readonly tenantId: TenantId; readonly role: Exclude<TenantRole, "owner"> }> {
    const invitation = await this.db
      .prepare(`
        SELECT id, tenant_id, role, status, created_by, created_at, expires_at, accepted_by, accepted_at
        FROM tenant_invitations WHERE token_hash = ?
      `)
      .bind(input.tokenHash)
      .first<TenantInvitationRow>();
    if (!invitation || invitation.status !== "pending" || invitation.expires_at <= input.now) {
      throw new AppError("NOT_FOUND", "Invitation is invalid, expired, or already used.", 404);
    }
    if (await this.getActiveTenantRole({ tenantId: invitation.tenant_id as TenantId, userId: input.userId })) {
      throw new AppError("CONFLICT", "This account already belongs to the invited workspace.", 409);
    }
    const results = await this.db.batch([
      this.db
        .prepare(`
          UPDATE tenant_invitations SET status = 'accepted', accepted_by = ?, accepted_at = ?
          WHERE token_hash = ? AND status = 'pending' AND expires_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM tenant_memberships
              WHERE tenant_id = ? AND user_id = ? AND status = 'active'
            )
        `)
        .bind(input.userId, input.now, input.tokenHash, input.now, invitation.tenant_id, input.userId),
      this.db
        .prepare(`
          INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at, status)
          SELECT tenant_id, ?, role, ?, 'active' FROM tenant_invitations
          WHERE token_hash = ? AND status = 'accepted' AND accepted_by = ? AND accepted_at = ? AND changes() = 1
          ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = excluded.role, status = 'active'
          WHERE tenant_memberships.status = 'inactive'
        `)
        .bind(input.userId, input.now, input.tokenHash, input.userId, input.now),
      this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, ?, ?, 'tenant.invitation.accepted', 'tenant_invitation', ?, json_object('role', ?), ?
          WHERE changes() = 1
        `)
        .bind(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          invitation.tenant_id,
          input.userId,
          invitation.id,
          invitation.role,
          input.now,
        ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      if (await this.getActiveTenantRole({ tenantId: invitation.tenant_id as TenantId, userId: input.userId })) {
        throw new AppError("CONFLICT", "This account already belongs to the invited workspace.", 409);
      }
      throw new AppError("NOT_FOUND", "Invitation is invalid, expired, or already used.", 404);
    }
    return { tenantId: invitation.tenant_id as TenantId, role: invitation.role };
  }

  async #assertTenantOwner(tenantId: TenantId, actorId: UserId): Promise<void> {
    const row = await this.db
      .prepare(`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND status = 'active'
      `)
      .bind(tenantId, actorId)
      .first<{ role: TenantRole }>();
    if (row?.role !== "owner") throw new AppError("FORBIDDEN", "Only a tenant owner can change membership.", 403);
  }

  async #activeOwnerCount(tenantId: TenantId): Promise<number> {
    const row = await this.db
      .prepare(`
        SELECT COUNT(*) AS count FROM tenant_memberships
        WHERE tenant_id = ? AND status = 'active' AND role = 'owner'
      `)
      .bind(tenantId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async #getTenantMember(tenantId: TenantId, memberId: UserId): Promise<TenantMember> {
    const row = await this.db
      .prepare(`
        SELECT m.user_id, m.role, m.status, m.created_at,
               (SELECT COUNT(*) FROM bots AS b
                WHERE b.tenant_id = m.tenant_id AND b.owner_id = m.user_id) AS owned_bot_count
        FROM tenant_memberships AS m WHERE m.tenant_id = ? AND m.user_id = ?
      `)
      .bind(tenantId, memberId)
      .first<TenantMemberRow>();
    if (!row) throw new AppError("INTERNAL_ERROR", "Tenant member could not be loaded after an update.", 500);
    return mapTenantMember(row);
  }

  async #getTenantInvitation(tenantId: TenantId, invitationId: string, now: string): Promise<TenantInvitation> {
    const row = await this.db
      .prepare(`
        SELECT id, tenant_id, role, status, created_by, created_at, expires_at, accepted_by, accepted_at
        FROM tenant_invitations WHERE tenant_id = ? AND id = ?
      `)
      .bind(tenantId, invitationId)
      .first<TenantInvitationRow>();
    if (!row) throw new AppError("INTERNAL_ERROR", "Tenant invitation could not be loaded after an update.", 500);
    return mapTenantInvitation(row, now);
  }

  async consumeApiRequest(input: {
    tenantId: TenantId;
    ownerId: UserId;
    now: string;
    limitPerMinute: number;
  }): Promise<boolean> {
    const timestamp = Date.parse(input.now);
    if (!Number.isFinite(timestamp)) throw new AppError("VALIDATION_ERROR", "API request time is invalid.", 400);
    if (!Number.isSafeInteger(input.limitPerMinute) || input.limitPerMinute < 1 || input.limitPerMinute > 10_000) {
      throw new AppError("VALIDATION_ERROR", "API request limit is invalid.", 400);
    }
    const minuteWindow = Math.floor(timestamp / 60_000);
    const result = await this.db
      .prepare(`
        INSERT INTO api_request_usage (tenant_id, owner_id, minute_window, request_count, updated_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(tenant_id, owner_id) DO UPDATE SET
          minute_window = excluded.minute_window,
          request_count = CASE WHEN api_request_usage.minute_window = excluded.minute_window
            THEN api_request_usage.request_count + 1 ELSE 1 END,
          updated_at = excluded.updated_at
        WHERE api_request_usage.minute_window != excluded.minute_window
          OR api_request_usage.request_count < ?
      `)
      .bind(input.tenantId, input.ownerId, minuteWindow, input.now, input.limitPerMinute)
      .run();
    return result.meta.changes === 1;
  }

  async recordApiMutation(input: {
    tenantId: TenantId;
    ownerId: UserId;
    tokenId: string;
    method: string;
    pathname: string;
    createdAt: string;
  }): Promise<void> {
    const method = input.method.toUpperCase().slice(0, 16);
    const pathname = input.pathname.slice(0, 512);
    const id = `audit_${crypto.randomUUID().replaceAll("-", "")}`;
    const metadata = JSON.stringify({ tokenId: input.tokenId, method, path: pathname });
    try {
      await this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'api.mutation_attempt', 'http_api', ?, ?, ?)
        `)
        .bind(id, input.tenantId, input.ownerId, `${method} ${pathname}`.slice(0, 512), metadata, input.createdAt)
        .run();
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Security event could not be recorded.", 503, { cause });
    }
  }

  async recordApiAuthorizationDenial(input: {
    tenantId: TenantId;
    ownerId: UserId;
    tokenId: string;
    method: string;
    pathname: string;
    denialType: "scope" | "resource";
    errorCode: "FORBIDDEN" | "NOT_FOUND";
    requiredScope?: string;
    createdAt: string;
  }): Promise<void> {
    const method = input.method.toUpperCase().slice(0, 16);
    const pathname = input.pathname.slice(0, 512);
    const requiredScope = input.requiredScope?.slice(0, 64);
    const id = `audit_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, ?, 'http_api', ?, ?, ?)
        `)
        .bind(
          id,
          input.tenantId,
          input.ownerId,
          `authorization.${input.denialType}_denied`,
          `${method} ${pathname}`.slice(0, 512),
          JSON.stringify({
            tokenId: input.tokenId,
            method,
            errorCode: input.errorCode,
            ...(input.requiredScope ? { requiredScope } : {}),
            outcome: "denied",
          }),
          input.createdAt,
        )
        .run();
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Security event could not be recorded.", 503, { cause });
    }
  }

  async recordPermissionDecision(input: {
    tenantId: TenantId;
    botId: BotId;
    category: "skill" | "mcp";
    permission: string;
    outcome: "allowed" | "denied";
    createdAt: string;
  }): Promise<void> {
    const id = `audit_${crypto.randomUUID().replaceAll("-", "")}`;
    const permission = [...input.permission]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f;
      })
      .join("")
      .slice(0, 128);
    try {
      await this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, b.tenant_id, 'authorization.permission_decision', 'bot', b.id, ?, ?
          FROM bots AS b WHERE b.tenant_id = ? AND b.id = ?
        `)
        .bind(
          id,
          JSON.stringify({ category: input.category, permission, outcome: input.outcome }),
          input.createdAt,
          input.tenantId,
          input.botId,
        )
        .run();
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Security event could not be recorded.", 503, { cause });
    }
  }

  async listOwnedAuditLogs(input: {
    tenantId: TenantId;
    ownerId: UserId;
    limit: number;
  }): Promise<readonly AuditLogEvent[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new AppError("VALIDATION_ERROR", "Audit log page size must be between 1 and 100.", 400);
    }
    const result = await this.db
      .prepare(`
        SELECT id, action, resource_type, resource_id, metadata_json, created_at
        FROM audit_logs AS a WHERE a.tenant_id = ? AND (
          a.actor_id = ? OR (a.resource_type = 'bot' AND EXISTS (
            SELECT 1 FROM bots AS b
            WHERE b.tenant_id = a.tenant_id AND b.id = a.resource_id AND b.owner_id = ?
          )) OR EXISTS (
            SELECT 1 FROM tenant_memberships AS viewer
            WHERE viewer.tenant_id = a.tenant_id AND viewer.user_id = ?
              AND viewer.role = 'owner' AND viewer.status = 'active'
          )
        )
        ORDER BY created_at DESC, id DESC LIMIT ?
      `)
      .bind(input.tenantId, input.ownerId, input.ownerId, input.ownerId, input.limit)
      .all<AuditLogRow>();
    return result.results.map(mapAuditLog);
  }

  async claimTelegramInitData(input: { dataHash: string; expiresAt: string; now: string }): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM telegram_auth_nonces WHERE expires_at <= ?").bind(input.now),
      this.db
        .prepare(`
          INSERT INTO telegram_auth_nonces (data_hash, expires_at, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT (data_hash) DO NOTHING
        `)
        .bind(input.dataHash, input.expiresAt, input.now),
    ]);
    return results[1]?.meta.changes === 1;
  }

  async getOrCreateTelegramOwner(input: {
    telegramUserId: number;
    ownerId: UserId;
    tenantId: TenantId;
    workspaceName: string;
    now: string;
  }): Promise<{ ownerId: UserId; tenantId: TenantId }> {
    const findAccount = () =>
      this.db
        .prepare(`
          SELECT m.user_id AS owner_id, m.tenant_id
          FROM users AS u
          JOIN tenant_memberships AS m ON m.user_id = u.id
          WHERE u.auth_issuer = 'telegram-miniapp' AND u.auth_subject = ? AND m.role = 'owner'
          ORDER BY m.created_at ASC
          LIMIT 1
        `)
        .bind(String(input.telegramUserId))
        .first<{ owner_id: string; tenant_id: string }>();
    const existing = await findAccount();
    if (existing) return { ownerId: existing.owner_id as UserId, tenantId: existing.tenant_id as TenantId };

    await this.db.batch([
      this.db
        .prepare(
          "INSERT OR IGNORE INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'telegram-miniapp', ?, ?)",
        )
        .bind(input.ownerId, String(input.telegramUserId), input.now),
      this.db
        .prepare("INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)")
        .bind(input.tenantId, input.workspaceName, input.now),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        )
        .bind(input.tenantId, input.ownerId, input.now),
    ]);

    const account = await findAccount();
    if (!account) throw new AppError("CONFLICT", "Telegram workspace could not be created.", 409);
    return { ownerId: account.owner_id as UserId, tenantId: account.tenant_id as TenantId };
  }

  async getMasterBotSession(telegramUserId: number): Promise<MasterBotSession | undefined> {
    validateMasterTelegramUserId(telegramUserId);
    const row = await this.db
      .prepare(`
        SELECT telegram_user_id, chat_id, tenant_id, owner_id, session_id, updated_at
        FROM master_bot_sessions WHERE telegram_user_id = ?
      `)
      .bind(telegramUserId)
      .first<MasterBotSessionRow>();
    return row
      ? {
          telegramUserId: row.telegram_user_id,
          chatId: row.chat_id,
          tenantId: row.tenant_id as TenantId,
          ownerId: row.owner_id as UserId,
          sessionId: row.session_id,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async saveMasterBotSession(session: MasterBotSession): Promise<void> {
    validateMasterTelegramUserId(session.telegramUserId);
    await this.db
      .prepare(`
        INSERT INTO master_bot_sessions (telegram_user_id, chat_id, tenant_id, owner_id, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          chat_id = excluded.chat_id, tenant_id = excluded.tenant_id, owner_id = excluded.owner_id,
          session_id = excluded.session_id, updated_at = excluded.updated_at
      `)
      .bind(
        session.telegramUserId,
        session.chatId,
        session.tenantId,
        session.ownerId,
        session.sessionId,
        session.updatedAt,
      )
      .run();
  }

  async deleteMasterBotSession(telegramUserId: number): Promise<void> {
    validateMasterTelegramUserId(telegramUserId);
    await this.db.prepare("DELETE FROM master_bot_sessions WHERE telegram_user_id = ?").bind(telegramUserId).run();
  }

  async reserveMasterBotUpdate(input: {
    updateId: number;
    leaseUntil: string;
    now: string;
  }): Promise<MasterBotUpdateReservation> {
    validateMasterUpdateId(input.updateId);
    const retentionBoundary = new Date(Date.parse(input.now) - 30 * 24 * 60 * 60 * 1000).toISOString();
    await this.db.prepare("DELETE FROM master_bot_updates WHERE created_at < ?").bind(retentionBoundary).run();
    const result = await this.db
      .prepare(`
        INSERT INTO master_bot_updates (update_id, state, response_json, lease_until, created_at, updated_at)
        VALUES (?, 'processing', NULL, ?, ?, ?)
        ON CONFLICT(update_id) DO UPDATE SET
          state = CASE WHEN master_bot_updates.state = 'ready' THEN 'ready' ELSE 'processing' END,
          response_json = CASE WHEN master_bot_updates.state = 'ready' THEN master_bot_updates.response_json ELSE NULL END,
          lease_until = excluded.lease_until,
          updated_at = excluded.updated_at
        WHERE master_bot_updates.state != 'completed' AND master_bot_updates.lease_until <= ?
      `)
      .bind(input.updateId, input.leaseUntil, input.now, input.now, input.now)
      .run();
    const row = await this.db
      .prepare("SELECT state, response_json, lease_until FROM master_bot_updates WHERE update_id = ?")
      .bind(input.updateId)
      .first<MasterBotUpdateRow>();
    if (!row) throw new AppError("CONFLICT", "Master bot update reservation failed.", 409);
    if (row.state === "completed") return { state: "completed" };
    if (result.meta.changes === 0 || row.lease_until !== input.leaseUntil) return { state: "busy" };
    if (row.state === "ready") return { state: "ready", reply: parseMasterBotReply(row.response_json) };
    return { state: "acquired" };
  }

  async saveMasterBotUpdateReply(input: {
    updateId: number;
    reply: MasterBotReply;
    leaseUntil: string;
    now: string;
  }): Promise<void> {
    validateMasterUpdateId(input.updateId);
    const serialized = JSON.stringify(input.reply);
    if (serialized.length > 20_000) throw new AppError("VALIDATION_ERROR", "Master bot reply is too large.", 400);
    const result = await this.db
      .prepare(`
        UPDATE master_bot_updates SET state = 'ready', response_json = ?, lease_until = ?, updated_at = ?
        WHERE update_id = ? AND state = 'processing'
      `)
      .bind(serialized, input.leaseUntil, input.now, input.updateId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("CONFLICT", "Master bot update lease was lost.", 409);
  }

  async completeMasterBotUpdate(input: { updateId: number; now: string }): Promise<void> {
    const result = await this.db
      .prepare(`
        UPDATE master_bot_updates SET state = 'completed', response_json = NULL, updated_at = ?
        WHERE update_id = ? AND state = 'ready'
      `)
      .bind(input.now, input.updateId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("CONFLICT", "Master bot update could not be completed.", 409);
  }

  async releaseMasterBotUpdate(input: { updateId: number; now: string }): Promise<void> {
    await this.db
      .prepare(
        "UPDATE master_bot_updates SET lease_until = ?, updated_at = ? WHERE update_id = ? AND state != 'completed'",
      )
      .bind(input.now, input.now, input.updateId)
      .run();
  }

  async createCreationApproval(record: CreationApprovalRecord): Promise<void> {
    try {
      await this.db.batch([
        this.db
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
          ),
        this.db
          .prepare(`
            INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
            VALUES (?, ?, ?, 'creation.approval_issued', 'factory_session', ?, ?, ?)
          `)
          .bind(
            `audit_${crypto.randomUUID().replaceAll("-", "")}`,
            record.tenantId,
            record.ownerId,
            record.sessionId,
            JSON.stringify({ approvalAction: record.action, expiresAt: record.expiresAt }),
            record.createdAt,
          ),
      ]);
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Approval could not be issued and audited.", 503, { cause });
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
    try {
      const results = await this.db.batch([
        this.db
          .prepare(`
            UPDATE creation_approvals SET consumed_at = ?
            WHERE approval_hash = ? AND tenant_id = ? AND owner_id = ? AND session_id = ? AND action = ?
              AND consumed_at IS NULL AND expires_at > ?
          `)
          .bind(input.now, input.approvalHash, input.tenantId, input.ownerId, input.sessionId, input.action, input.now),
        this.db
          .prepare(`
            INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
            SELECT ?, COALESCE((SELECT tenant_id FROM creation_approvals WHERE approval_hash = ?), ?), ?,
              CASE WHEN changes() = 1 THEN 'creation.approval_consumed' ELSE 'creation.approval_rejected' END,
              'factory_session', ?, ?, ?
          `)
          .bind(
            `audit_${crypto.randomUUID().replaceAll("-", "")}`,
            input.approvalHash,
            input.tenantId,
            input.ownerId,
            input.sessionId,
            JSON.stringify({ approvalAction: input.action }),
            input.now,
          ),
      ]);
      return results[0]?.meta.changes === 1;
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Approval attempt could not be audited.", 503, { cause });
    }
  }

  async createBotCredentialApproval(input: {
    readonly approvalHash: string;
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<void> {
    try {
      await this.db.batch([
        this.db
          .prepare(`
            INSERT INTO bot_credential_approvals (
              approval_hash, tenant_id, owner_id, bot_id, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `)
          .bind(input.approvalHash, input.tenantId, input.ownerId, input.botId, input.createdAt, input.expiresAt),
        this.db
          .prepare(`
            INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
            VALUES (?, ?, ?, 'bot.credential_approval_issued', 'bot', ?, ?, ?)
          `)
          .bind(
            `audit_${crypto.randomUUID().replaceAll("-", "")}`,
            input.tenantId,
            input.ownerId,
            input.botId,
            JSON.stringify({ expiresAt: input.expiresAt }),
            input.createdAt,
          ),
      ]);
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Credential update approval could not be stored.", 503, { cause });
    }
  }

  async consumeBotCredentialApproval(input: {
    readonly approvalHash: string;
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly now: string;
  }): Promise<boolean> {
    try {
      const results = await this.db.batch([
        this.db
          .prepare(`
            UPDATE bot_credential_approvals SET consumed_at = ?
            WHERE approval_hash = ? AND tenant_id = ? AND owner_id = ? AND bot_id = ?
              AND consumed_at IS NULL AND expires_at > ?
          `)
          .bind(input.now, input.approvalHash, input.tenantId, input.ownerId, input.botId, input.now),
        this.db
          .prepare(`
            INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
            VALUES (?, ?, ?, CASE WHEN changes() = 1 THEN 'bot.credential_approval_consumed' ELSE 'bot.credential_approval_rejected' END,
              'bot', ?, '{}', ?)
          `)
          .bind(
            `audit_${crypto.randomUUID().replaceAll("-", "")}`,
            input.tenantId,
            input.ownerId,
            input.botId,
            input.now,
          ),
      ]);
      return results[0]?.meta.changes === 1;
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Credential update approval attempt could not be audited.", 503, {
        cause,
      });
    }
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

  async setMcpServerCredentialRef(input: Parameters<McpRepository["setServerCredentialRef"]>[0]): Promise<void> {
    const result = await this.db
      .prepare(`
        UPDATE mcp_servers SET credential_ref = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND id = ? AND credential_ref = ?
      `)
      .bind(
        input.credentialRef,
        new Date().toISOString(),
        input.tenantId,
        input.botId,
        input.serverId,
        input.expectedCredentialRef,
      )
      .run();
    if (result.meta.changes === 1) return;
    const server = await this.getMcpServer(input.tenantId, input.botId, input.serverId);
    if (!server) throw new AppError("NOT_FOUND", "MCP server was not found for this bot.", 404);
    throw new AppError("CONFLICT", "MCP credentials changed during OAuth state persistence.", 409);
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

  async listGlobalSkillCatalog(): Promise<readonly SkillDefinition[]> {
    const result = await this.db
      .prepare(`
        SELECT id, tenant_id, name, version, author, category, description, execution_type,
               input_schema_json, output_schema_json, permissions_json, definition_json, enabled
        FROM skills WHERE tenant_id IS NULL
        ORDER BY category, name, version
      `)
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

  async publishCatalogSkill(input: {
    readonly tenantId: TenantId;
    readonly definition: SkillCatalogPublication;
  }): Promise<void> {
    const definition = input.definition;
    try {
      const result = await this.db
        .prepare(`
          INSERT INTO skills (
            id, tenant_id, name, version, author, category, description, execution_type,
            input_schema_json, output_schema_json, permissions_json, definition_json, enabled, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `)
        .bind(
          definition.id,
          input.tenantId,
          definition.name,
          definition.version,
          definition.author,
          definition.category,
          definition.description,
          definition.executionType,
          JSON.stringify(definition.inputSchema),
          JSON.stringify(definition.outputSchema),
          JSON.stringify(definition.requiredPermissions),
          JSON.stringify({
            configuration: definition.configuration,
            timeoutMs: definition.timeoutMs,
            rateLimit: definition.rateLimit,
            retryPolicy: definition.retryPolicy,
          }),
          new Date().toISOString(),
        )
        .run();
      if (result.meta.changes !== 1) {
        throw new AppError("INTERNAL_ERROR", "D1 did not insert the catalog skill.", 500);
      }
    } catch (cause) {
      if (cause instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(cause.message)) {
        throw new AppError("CONFLICT", "Skill ID or version is already present in the catalog.", 409, { cause });
      }
      throw cause;
    }
  }

  async publishGlobalSkillCatalogItem(input: { readonly definition: SkillCatalogPublication }): Promise<void> {
    const definition = input.definition;
    try {
      const result = await this.db
        .prepare(`
          INSERT INTO skills (
            id, tenant_id, name, version, author, category, description, execution_type,
            input_schema_json, output_schema_json, permissions_json, definition_json, enabled, created_at
          ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `)
        .bind(
          definition.id,
          definition.name,
          definition.version,
          definition.author,
          definition.category,
          definition.description,
          definition.executionType,
          JSON.stringify(definition.inputSchema),
          JSON.stringify(definition.outputSchema),
          JSON.stringify(definition.requiredPermissions),
          JSON.stringify({
            configuration: definition.configuration,
            timeoutMs: definition.timeoutMs,
            rateLimit: definition.rateLimit,
            retryPolicy: definition.retryPolicy,
          }),
          new Date().toISOString(),
        )
        .run();
      if (result.meta.changes !== 1) throw new AppError("INTERNAL_ERROR", "D1 did not insert the catalog skill.", 500);
    } catch (cause) {
      if (cause instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(cause.message)) {
        throw new AppError("CONFLICT", "Skill ID or version is already present in the catalog.", 409, { cause });
      }
      throw cause;
    }
  }

  async setGlobalSkillCatalogEnabled(skillId: string, enabled: boolean): Promise<void> {
    const result = await this.db
      .prepare("UPDATE skills SET enabled = ? WHERE id = ? AND tenant_id IS NULL")
      .bind(Number(enabled), skillId)
      .run();
    if (result.meta.changes !== 1) throw new AppError("NOT_FOUND", "Global catalog skill was not found.", 404);
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

  async acquireWorkflowExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly executionKey: string;
    readonly initialStateRef: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseUntil: string;
    readonly expiresAt: string;
  }): Promise<WorkflowExecutionAcquisition> {
    const select = () =>
      this.db
        .prepare(`
          SELECT tenant_id, bot_id, skill_id, execution_key, state_ref, next_step, version, status,
                 lease_token, lease_until, expires_at, updated_at
          FROM workflow_executions WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
        `)
        .bind(input.tenantId, input.botId, input.skillId, input.executionKey)
        .first<WorkflowExecutionRow>();
    let row = await select();
    let replacedStateRef: string | undefined;
    if (!row) {
      const insert = await this.db
        .prepare(`
          INSERT INTO workflow_executions (
            tenant_id, bot_id, skill_id, execution_key, state_ref, next_step, version, status,
            lease_token, lease_until, expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, 1, 'running', ?, ?, ?, ?)
          ON CONFLICT (tenant_id, bot_id, skill_id, execution_key) DO NOTHING
        `)
        .bind(
          input.tenantId,
          input.botId,
          input.skillId,
          input.executionKey,
          input.initialStateRef,
          input.leaseToken,
          input.leaseUntil,
          input.expiresAt,
          input.now,
        )
        .run();
      row = await select();
      if (insert.meta.changes === 1 && row) return { state: "acquired", execution: mapWorkflowExecution(row) };
    }
    if (!row) throw new AppError("CONFLICT", "Workflow execution could not be acquired.", 409);
    if (row.expires_at <= input.now) {
      replacedStateRef = row.state_ref;
      await this.db
        .prepare(`
          UPDATE workflow_executions
          SET state_ref = ?, next_step = 0, version = version + 1, status = 'running', lease_token = ?,
              lease_until = ?, expires_at = ?, updated_at = ?
          WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ? AND expires_at <= ?
        `)
        .bind(
          input.initialStateRef,
          input.leaseToken,
          input.leaseUntil,
          input.expiresAt,
          input.now,
          input.tenantId,
          input.botId,
          input.skillId,
          input.executionKey,
          input.now,
        )
        .run();
      row = await select();
      if (row?.status === "running" && row.lease_token === input.leaseToken) {
        return {
          state: "acquired",
          execution: mapWorkflowExecution(row),
          replacedStateRef,
        };
      }
    }
    if (!row) throw new AppError("CONFLICT", "Workflow execution could not be acquired.", 409);
    if (row.status === "succeeded") return { state: "completed", execution: mapWorkflowExecution(row) };
    if (row.lease_until > input.now) return { state: "busy" };
    const update = await this.db
      .prepare(`
        UPDATE workflow_executions
        SET lease_token = ?, lease_until = ?, expires_at = ?, updated_at = ?, version = version + 1
        WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          AND status = 'running' AND lease_until <= ?
      `)
      .bind(
        input.leaseToken,
        input.leaseUntil,
        input.expiresAt,
        input.now,
        input.tenantId,
        input.botId,
        input.skillId,
        input.executionKey,
        input.now,
      )
      .run();
    row = await select();
    if (row?.status === "succeeded") return { state: "completed", execution: mapWorkflowExecution(row) };
    if (update.meta.changes !== 1 || !row || row.lease_token !== input.leaseToken) {
      return { state: "busy" };
    }
    return {
      state: "acquired",
      execution: mapWorkflowExecution(row),
      ...(replacedStateRef === undefined ? {} : { replacedStateRef }),
    };
  }

  async acquireToolExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly executionKey: string;
    readonly toolName: string;
    readonly inputHash: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseUntil: string;
    readonly expiresAt: string;
  }): Promise<ToolExecutionAcquisition> {
    const select = () =>
      this.db
        .prepare(`
          SELECT tenant_id, bot_id, execution_key, tool_name, input_hash, status, result_ref,
                 lease_token, lease_until, expires_at, updated_at, recovery_status, ambiguous_at
          FROM tool_executions WHERE tenant_id = ? AND bot_id = ? AND execution_key = ?
        `)
        .bind(input.tenantId, input.botId, input.executionKey)
        .first<ToolExecutionRow>();

    let row = await select();
    if (!row) {
      const inserted = await this.db
        .prepare(`
          INSERT INTO tool_executions (
            tenant_id, bot_id, execution_key, tool_name, input_hash, status, result_ref,
            lease_token, lease_until, expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, bot_id, execution_key) DO NOTHING
        `)
        .bind(
          input.tenantId,
          input.botId,
          input.executionKey,
          input.toolName,
          input.inputHash,
          input.leaseToken,
          input.leaseUntil,
          input.expiresAt,
          input.now,
        )
        .run();
      row = await select();
      if (inserted.meta.changes === 1 && row?.lease_token === input.leaseToken) {
        return { state: "acquired", leaseToken: input.leaseToken };
      }
    }
    if (!row) throw new AppError("CONFLICT", "Tool execution could not be acquired.", 409);
    if (row.tool_name !== input.toolName || row.input_hash !== input.inputHash) {
      throw new AppError("CONFLICT", "Tool execution identity was reused with different input.", 409);
    }
    if (row.status === "succeeded" && row.expires_at > input.now) {
      if (!row.result_ref) throw new AppError("INTERNAL_ERROR", "Completed tool result is missing.", 500);
      return { state: "completed", resultRef: row.result_ref };
    }

    const replacedResultRef = row.expires_at <= input.now ? (row.result_ref ?? undefined) : undefined;
    let updateChanges = 0;
    if (row.expires_at <= input.now) {
      const update = await this.db
        .prepare(`
          UPDATE tool_executions
          SET status = 'running', result_ref = NULL, lease_token = ?, lease_until = ?, expires_at = ?, updated_at = ?,
              recovery_status = 'none', ambiguous_at = NULL
          WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND expires_at <= ?
        `)
        .bind(
          input.leaseToken,
          input.leaseUntil,
          input.expiresAt,
          input.now,
          input.tenantId,
          input.botId,
          input.executionKey,
          input.now,
        )
        .run();
      updateChanges = update.meta.changes;
    } else if (row.status === "running" && row.lease_until <= input.now) {
      if (row.recovery_status === "closed") return { state: "closed" };
      if (row.recovery_status === "ambiguous") return { state: "ambiguous" };
      if (row.recovery_status === "none") {
        await this.db
          .prepare(`
            UPDATE tool_executions SET recovery_status = 'ambiguous', ambiguous_at = COALESCE(ambiguous_at, ?),
              lease_until = ?, updated_at = ?
            WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND status = 'running'
              AND recovery_status = 'none' AND lease_until <= ? AND expires_at > ?
          `)
          .bind(input.now, input.now, input.now, input.tenantId, input.botId, input.executionKey, input.now, input.now)
          .run();
        row = await select();
        if (row?.recovery_status === "ambiguous") return { state: "ambiguous" };
        if (row?.recovery_status === "closed") return { state: "closed" };
        if (row?.status === "succeeded" && row.result_ref && row.expires_at > input.now) {
          return { state: "completed", resultRef: row.result_ref };
        }
        return { state: "busy" };
      }
      const update = await this.db
        .prepare(`
          UPDATE tool_executions SET lease_token = ?, lease_until = ?, expires_at = ?, updated_at = ?,
            recovery_status = 'none', ambiguous_at = NULL
          WHERE tenant_id = ? AND bot_id = ? AND execution_key = ?
            AND status = 'running' AND recovery_status = 'retry_approved' AND lease_until <= ? AND expires_at > ?
        `)
        .bind(
          input.leaseToken,
          input.leaseUntil,
          input.expiresAt,
          input.now,
          input.tenantId,
          input.botId,
          input.executionKey,
          input.now,
          input.now,
        )
        .run();
      updateChanges = update.meta.changes;
    } else {
      return { state: "busy" };
    }
    row = await select();
    if (updateChanges === 1 && row?.status === "running" && row.lease_token === input.leaseToken) {
      return {
        state: "acquired",
        leaseToken: input.leaseToken,
        ...(replacedResultRef === undefined ? {} : { replacedResultRef }),
      };
    }
    if (row?.status === "succeeded" && row.result_ref && row.expires_at > input.now) {
      return { state: "completed", resultRef: row.result_ref };
    }
    return { state: "busy" };
  }

  async completeToolExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly resultRef: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(`
        UPDATE tool_executions
        SET status = 'succeeded', result_ref = ?, lease_token = NULL, lease_until = ?, expires_at = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND status = 'running'
          AND recovery_status = 'none' AND lease_token = ?
      `)
      .bind(
        input.resultRef,
        input.now,
        input.expiresAt,
        input.now,
        input.tenantId,
        input.botId,
        input.executionKey,
        input.leaseToken,
      )
      .run();
    return result.meta.changes === 1;
  }

  async releaseToolExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<void> {
    await this.db
      .prepare(`
        UPDATE tool_executions SET recovery_status = 'ambiguous', ambiguous_at = COALESCE(ambiguous_at, ?),
          lease_until = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND status = 'running'
          AND recovery_status = 'none' AND lease_token = ?
      `)
      .bind(input.now, input.now, input.now, input.tenantId, input.botId, input.executionKey, input.leaseToken)
      .run();
  }

  async listOwnedToolExecutionRecoveries(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly ToolExecutionRecovery[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new AppError("VALIDATION_ERROR", "Tool recovery page size is invalid.", 400);
    }
    await this.db
      .prepare(`
        UPDATE tool_executions SET recovery_status = 'ambiguous',
          ambiguous_at = COALESCE(ambiguous_at, ?), updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND status = 'running' AND recovery_status = 'none'
          AND lease_until <= ? AND expires_at > ?
          AND EXISTS (SELECT 1 FROM bots WHERE bots.tenant_id = tool_executions.tenant_id
            AND bots.id = tool_executions.bot_id AND bots.owner_id = ?)
      `)
      .bind(input.now, input.now, input.tenantId, input.botId, input.now, input.now, input.ownerId)
      .run();
    const rows = await this.db
      .prepare(`
        SELECT execution.bot_id, execution.execution_key, execution.tool_name,
               execution.recovery_status, execution.ambiguous_at, execution.updated_at
        FROM tool_executions AS execution
        JOIN bots ON bots.tenant_id = execution.tenant_id AND bots.id = execution.bot_id
        WHERE execution.tenant_id = ? AND bots.owner_id = ? AND execution.bot_id = ?
          AND execution.status = 'running' AND execution.recovery_status IN ('ambiguous', 'retry_approved')
          AND execution.expires_at > ?
        ORDER BY execution.ambiguous_at ASC, execution.execution_key ASC LIMIT ?
      `)
      .bind(input.tenantId, input.ownerId, input.botId, input.now, input.limit)
      .all<{
        bot_id: string;
        execution_key: string;
        tool_name: string;
        recovery_status: ToolExecutionRecovery["status"];
        ambiguous_at: string | null;
        updated_at: string;
      }>();
    return rows.results.map(mapToolExecutionRecovery);
  }

  async resolveOwnedToolExecutionRecovery(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly executionKey: string;
    readonly resolution: "retry" | "close";
    readonly now: string;
  }): Promise<"retry_approved" | "closed" | undefined> {
    const prior = await this.db
      .prepare(`
        SELECT execution.tool_name
        FROM tool_executions AS execution
        JOIN bots ON bots.tenant_id = execution.tenant_id AND bots.id = execution.bot_id
        WHERE execution.tenant_id = ? AND bots.owner_id = ? AND execution.bot_id = ?
          AND execution.execution_key = ? AND execution.status = 'running'
          AND execution.recovery_status = 'ambiguous' AND execution.lease_until <= ?
          AND execution.expires_at > ?
      `)
      .bind(input.tenantId, input.ownerId, input.botId, input.executionKey, input.now, input.now)
      .first<{ tool_name: string }>();
    if (!prior) return undefined;
    const status = input.resolution === "retry" ? "retry_approved" : "closed";
    const auditAction = input.resolution === "retry" ? "tool.execution_retry_approved" : "tool.execution_closed";
    const [update] = await this.db.batch([
      this.db
        .prepare(`
          UPDATE tool_executions SET recovery_status = ?, updated_at = ?
          WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND status = 'running'
            AND recovery_status = 'ambiguous' AND lease_until <= ? AND expires_at > ?
            AND EXISTS (SELECT 1 FROM bots WHERE bots.tenant_id = tool_executions.tenant_id
              AND bots.id = tool_executions.bot_id AND bots.owner_id = ?)
        `)
        .bind(status, input.now, input.tenantId, input.botId, input.executionKey, input.now, input.now, input.ownerId),
      this.db
        .prepare(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, ?, ?, ?, 'tool_execution', ?, ?, ?
          WHERE changes() = 1 AND EXISTS (
            SELECT 1 FROM tool_executions WHERE tenant_id = ? AND bot_id = ? AND execution_key = ?
              AND recovery_status = ? AND updated_at = ?
          )
        `)
        .bind(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.ownerId,
          auditAction,
          input.executionKey,
          JSON.stringify({ botId: input.botId, toolName: prior.tool_name, resolution: input.resolution }),
          input.now,
          input.tenantId,
          input.botId,
          input.executionKey,
          status,
          input.now,
        ),
    ]);
    return update?.meta.changes === 1 ? status : undefined;
  }

  async purgeToolExecutions(tenantId: TenantId, now: string, limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new AppError("VALIDATION_ERROR", "Tool execution cleanup page size is invalid.", 400);
    }
    const selected = await this.db
      .prepare(`
        SELECT tenant_id, bot_id, execution_key, tool_name, input_hash, status, result_ref,
               lease_token, lease_until, expires_at, updated_at, recovery_status, ambiguous_at
        FROM tool_executions WHERE tenant_id = ? AND expires_at <= ? ORDER BY expires_at LIMIT ?
      `)
      .bind(tenantId, now, limit)
      .all<ToolExecutionRow>();
    if (!selected.results.length) return [];
    const results = await this.db.batch(
      selected.results.map((row) =>
        this.db
          .prepare(`
            DELETE FROM tool_executions
            WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND expires_at <= ?
          `)
          .bind(row.tenant_id, row.bot_id, row.execution_key, now),
      ),
    );
    return selected.results
      .filter((_row, index) => results[index]?.meta.changes === 1)
      .flatMap((row) => (row.result_ref ? [row.result_ref] : []));
  }

  async checkpointWorkflowExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly expectedVersion: number;
    readonly stateRef: string;
    readonly nextStep: number;
    readonly now: string;
    readonly leaseUntil: string;
    readonly expiresAt: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(`
        UPDATE workflow_executions
        SET state_ref = ?, next_step = ?, version = version + 1, lease_until = ?, expires_at = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          AND status = 'running' AND lease_token = ? AND version = ?
      `)
      .bind(
        input.stateRef,
        input.nextStep,
        input.leaseUntil,
        input.expiresAt,
        input.now,
        input.tenantId,
        input.botId,
        input.skillId,
        input.executionKey,
        input.leaseToken,
        input.expectedVersion,
      )
      .run();
    return result.meta.changes === 1;
  }

  async completeWorkflowExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly expectedVersion: number;
    readonly stateRef: string;
    readonly nextStep: number;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(`
        UPDATE workflow_executions
        SET state_ref = ?, next_step = ?, status = 'succeeded', lease_token = NULL,
            lease_until = ?, expires_at = ?, updated_at = ?, version = version + 1
        WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          AND status = 'running' AND lease_token = ? AND version = ?
      `)
      .bind(
        input.stateRef,
        input.nextStep,
        input.now,
        input.expiresAt,
        input.now,
        input.tenantId,
        input.botId,
        input.skillId,
        input.executionKey,
        input.leaseToken,
        input.expectedVersion,
      )
      .run();
    return result.meta.changes === 1;
  }

  async releaseWorkflowExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<void> {
    await this.db
      .prepare(`
        UPDATE workflow_executions SET lease_until = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          AND status = 'running' AND lease_token = ?
      `)
      .bind(input.now, input.now, input.tenantId, input.botId, input.skillId, input.executionKey, input.leaseToken)
      .run();
  }

  async purgeWorkflowExecutions(tenantId: TenantId, now: string, limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new AppError("VALIDATION_ERROR", "Workflow cleanup page size is invalid.", 400);
    }
    const selected = await this.db
      .prepare(`
        SELECT tenant_id, bot_id, skill_id, execution_key, state_ref, next_step, version, status,
               lease_token, lease_until, expires_at, updated_at
        FROM workflow_executions WHERE tenant_id = ? AND expires_at <= ? ORDER BY expires_at LIMIT ?
      `)
      .bind(tenantId, now, limit)
      .all<WorkflowExecutionRow>();
    if (!selected.results.length) return [];
    const results = await this.db.batch(
      selected.results.map((row) =>
        this.db
          .prepare(`
            DELETE FROM workflow_executions
            WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ? AND expires_at <= ?
          `)
          .bind(row.tenant_id, row.bot_id, row.skill_id, row.execution_key, now),
      ),
    );
    return selected.results.filter((_row, index) => results[index]?.meta.changes === 1).map((row) => row.state_ref);
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

function mapWorkflowExecution(row: WorkflowExecutionRow): WorkflowExecution {
  return {
    tenantId: row.tenant_id as TenantId,
    botId: row.bot_id as BotId,
    skillId: row.skill_id,
    executionKey: row.execution_key,
    stateRef: row.state_ref,
    nextStep: row.next_step,
    version: row.version,
    status: row.status,
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    leaseUntil: row.lease_until,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
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

function validateTelegramAttachmentRefs(
  value: unknown,
): readonly { readonly kind: "image"; readonly secretRef: string }[] {
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    value.some(
      (item) =>
        !isRecord(item) ||
        item.kind !== "image" ||
        typeof item.secretRef !== "string" ||
        !/^secret_[a-f0-9]{32}$/.test(item.secretRef),
    )
  ) {
    throw new AppError("VALIDATION_ERROR", "Telegram response attachments are invalid.", 400);
  }
  return value as readonly { readonly kind: "image"; readonly secretRef: string }[];
}

function parseTelegramAttachmentRefs(value: string): readonly { readonly kind: "image"; readonly secretRef: string }[] {
  return validateTelegramAttachmentRefs(parseJson<unknown>(value, "Telegram response attachments"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMasterTelegramUserId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError("VALIDATION_ERROR", "Telegram user ID must be a positive safe integer.", 400);
  }
}

function validateMasterUpdateId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("VALIDATION_ERROR", "Master bot update ID is invalid.", 400);
  }
}

function parseMasterBotReply(value: string | null): MasterBotReply {
  if (!value) throw new AppError("INTERNAL_ERROR", "Stored master bot reply is missing.", 500);
  const reply = parseJson<unknown>(value, "master bot reply");
  if (
    !isRecord(reply) ||
    !Number.isSafeInteger(reply.chat_id) ||
    typeof reply.text !== "string" ||
    (reply.reply_markup !== undefined && !isRecord(reply.reply_markup))
  ) {
    throw new AppError("INTERNAL_ERROR", "Stored master bot reply is invalid.", 500);
  }
  return reply as unknown as MasterBotReply;
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

function mapPublicListing(row: PublicListingRow): PublicBotListing {
  return {
    botId: row.bot_id as BotId,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    listedAt: row.listed_at,
    dailyUsageLimit: row.daily_usage_limit,
    rateLimitPerMinute: row.rate_limit_per_minute,
  };
}

function mapAccessGrant(row: AccessGrantRow): BotAccessGrant {
  return {
    id: row.id,
    botId: row.bot_id as BotId,
    ...(row.user_id === null ? {} : { userId: row.user_id as UserId }),
    invitationAvailable: row.invitation_token_hash !== null,
    accessLevel: row.access_level,
    status: row.status,
    ...(row.usage_limit === null ? {} : { dailyUsageLimit: row.usage_limit }),
    ...(row.rate_limit_per_minute === null ? {} : { rateLimitPerMinute: row.rate_limit_per_minute }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    createdAt: row.created_at,
  };
}

function mapTenantMember(row: TenantMemberRow): TenantMember {
  return {
    userId: row.user_id as UserId,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    ownedBotCount: row.owned_bot_count,
  };
}

function mapTenantInvitation(row: TenantInvitationRow, now: string): TenantInvitation {
  const status = row.status === "pending" && row.expires_at <= now ? "expired" : row.status;
  return {
    id: row.id,
    role: row.role,
    status,
    createdBy: row.created_by as UserId,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.accepted_by === null ? {} : { acceptedBy: row.accepted_by as UserId }),
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
  };
}

function mapBotOwnershipTransfer(row: BotOwnershipTransferRow): BotOwnershipTransfer {
  return {
    id: row.id,
    botId: row.bot_id as BotId,
    fromOwnerId: row.from_owner_id as UserId,
    toOwnerId: row.to_owner_id as UserId,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

function mapAuditLog(row: AuditLogRow): AuditLogEvent {
  const metadata = parseJson<unknown>(row.metadata_json, "audit metadata");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AppError("INTERNAL_ERROR", "Stored audit metadata is invalid.", 500);
  }
  return {
    id: row.id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: metadata as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function validateAccessLimits(dailyUsageLimit: number, rateLimitPerMinute: number): void {
  if (!Number.isSafeInteger(dailyUsageLimit) || dailyUsageLimit < 1 || dailyUsageLimit > 10_000) {
    throw new AppError("VALIDATION_ERROR", "Daily usage limit must be between 1 and 10000.", 400);
  }
  if (!Number.isSafeInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 600) {
    throw new AppError("VALIDATION_ERROR", "Rate limit must be between 1 and 600 requests per minute.", 400);
  }
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

function mapStoredConversationMessage(row: ConversationHistoryMessageRow): StoredConversationMessage {
  return {
    ...mapMessage(row),
    id: row.id,
    sequence: row.sequence,
    createdAt: row.created_at,
  };
}

function mapBotMemory(row: MemoryRow): StoredBotMemoryRecord {
  const value = parseJson<unknown>(row.value_json, "bot memory");
  if (typeof value !== "string") throw new AppError("INTERNAL_ERROR", "Stored bot memory is invalid.", 500);
  return {
    id: row.id,
    botId: row.bot_id as BotId,
    key: row.memory_key,
    value,
    encryptedValue: row.encrypted_value === 1,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

function mapToolExecutionRecovery(row: {
  bot_id: string;
  execution_key: string;
  tool_name: string;
  recovery_status: ToolExecutionRecovery["status"];
  ambiguous_at: string | null;
  updated_at: string;
}): ToolExecutionRecovery {
  if (!row.ambiguous_at) throw new AppError("INTERNAL_ERROR", "Tool recovery timestamp is missing.", 500);
  return {
    botId: row.bot_id as BotId,
    executionKey: row.execution_key,
    toolName: row.tool_name,
    status: row.recovery_status,
    ambiguousAt: row.ambiguous_at,
    updatedAt: row.updated_at,
  };
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

function mapSecretRow(row: SecretRow): EncryptedSecretRecord {
  return {
    tenantId: row.tenant_id as TenantId,
    reference: row.reference,
    keyId: row.key_id,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    version: row.envelope_version,
    createdAt: row.created_at,
  };
}

function configurationFromBot(bot: BotDefinition): Record<string, unknown> {
  return {
    name: bot.name,
    description: bot.description,
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
