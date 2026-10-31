import type { Database } from "bun:sqlite";
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
  BotDraftPublisher,
  BotManagementRepository,
  BotCollaboratorSettingsPatch,
  BotVersionHistoryItem,
  BotCollaborator,
  BotCollaboratorRole,
  CollaboratedBot,
  BotRepository,
  BotSettingsPatch,
  ConversationRepository,
  ConversationHistoryRepository,
  CreationApprovalAction,
  CreationApprovalRecord,
  CreationApprovalRepository,
  CreationSessionRepository,
  EncryptedSecretRecord,
  SecretRecordRepository,
  SkillRateLimiter,
  SkillCatalogPublication,
  SkillRepository,
  McpRepository,
  MemoryRepository,
  MasterBotRepository,
  MasterBotReply,
  MasterBotSession,
  MasterBotUpdateReservation,
  NetworkRequestRateLimiter,
  ScheduledTaskRepository,
  TelegramRepository,
  TelegramAuthRepository,
  UsageRepository,
  WorkflowExecution,
  WorkflowExecutionAcquisition,
  WorkflowExecutionRepository,
  ToolExecutionAcquisition,
  ToolExecutionRecovery,
  ToolExecutionRepository,
  TenantMembershipRepository,
  BotOwnershipTransferRepository,
} from "@aihat/core";
import type {
  AgentRequest,
  BotDefinition,
  BotId,
  BotVisibility,
  ConversationId,
  ConversationMessage,
  ConversationSummary,
  StoredConversationMessage,
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
  UsageRecord,
  UsageSummary,
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

interface BotCollaboratorRow {
  user_id: string;
  role: BotCollaboratorRole;
  member_status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  role: ConversationMessage["role"];
  content: string;
  metadata_json: string;
}

interface ConversationHistoryRow extends ConversationRow {
  id: string;
  sequence: number;
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
  reconnect_attempts: number;
  reconnect_after: string | null;
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
  date?: string;
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
  date?: string;
  retries: number;
}

interface ModelRetryBotAggregateRow extends Omit<ModelRetryAggregateRow, "date"> {
  bot_id: string;
  bot_name: string;
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
  conversation_id: string | null;
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

/** Bun-specific SQLite repositories. Every read and write carries the owning tenant. */
export class BunSqliteRepositories
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
  readonly #db: Database;
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
  readonly networkRateLimiter: NetworkRequestRateLimiter;

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
    this.networkRateLimiter = {
      consume: (input) => this.consumeNetworkRequest(input),
    };
    this.telegramAuth = {
      claimInitData: (input) => this.claimTelegramInitData(input),
      getOrCreateOwner: (input) => this.getOrCreateTelegramOwner(input),
    };
    this.masterBot = {
      getSession: (telegramUserId) => this.getMasterBotSession(telegramUserId),
      saveSession: (session) => this.saveMasterBotSession(session),
      deleteSession: (telegramUserId) => this.deleteMasterBotSession(telegramUserId),
      consumeUserRequest: (input) => this.consumeMasterBotUserRequest(input),
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
      claimServerReconnect: (input) => this.claimMcpServerReconnect(input),
      failServerReconnect: (input) => this.failMcpServerReconnect(input),
      setServerCredentialRef: (input) => this.setMcpServerCredentialRef(input),
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

  async listCollaborated(input: {
    readonly tenantId: TenantId;
    readonly userId: UserId;
  }): Promise<readonly CollaboratedBot[]> {
    const rows = this.#db
      .query<BotRow & { collaborator_role: BotCollaboratorRole }, [string, string]>(`
        SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
               b.visibility, b.current_version, b.created_at, b.updated_at,
               v.configuration_json, c.role AS collaborator_role
        FROM bot_collaborators AS c
        JOIN tenant_memberships AS m
          ON m.tenant_id = c.tenant_id AND m.user_id = c.user_id AND m.status = 'active'
        JOIN bots AS b ON b.id = c.bot_id AND b.tenant_id = c.tenant_id
        JOIN bot_versions AS v
          ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
        WHERE c.tenant_id = ? AND c.user_id = ? AND b.owner_id <> c.user_id
        ORDER BY b.updated_at DESC, b.id
      `)
      .all(input.tenantId, input.userId);
    return rows.map((row) => ({ bot: mapBot(row), role: row.collaborator_role }));
  }

  async getCollaborated(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly userId: UserId;
  }): Promise<CollaboratedBot | undefined> {
    const row = this.#db
      .query<BotRow & { collaborator_role: BotCollaboratorRole }, [string, string, string]>(`
        SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
               b.visibility, b.current_version, b.created_at, b.updated_at,
               v.configuration_json, c.role AS collaborator_role
        FROM bot_collaborators AS c
        JOIN tenant_memberships AS m
          ON m.tenant_id = c.tenant_id AND m.user_id = c.user_id AND m.status = 'active'
        JOIN bots AS b ON b.id = c.bot_id AND b.tenant_id = c.tenant_id
        JOIN bot_versions AS v
          ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
        WHERE c.tenant_id = ? AND c.bot_id = ? AND c.user_id = ? AND b.owner_id <> c.user_id
      `)
      .get(input.tenantId, input.botId, input.userId);
    return row ? { bot: mapBot(row), role: row.collaborator_role } : undefined;
  }

  async listBotCollaborators(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<readonly BotCollaborator[]> {
    this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    const rows = this.#db
      .query<BotCollaboratorRow, [string, string]>(`
        SELECT c.user_id, c.role, m.status AS member_status, c.created_at, c.updated_at
        FROM bot_collaborators AS c
        JOIN tenant_memberships AS m ON m.tenant_id = c.tenant_id AND m.user_id = c.user_id
        WHERE c.tenant_id = ? AND c.bot_id = ?
          AND c.user_id <> (SELECT owner_id FROM bots WHERE tenant_id = c.tenant_id AND id = c.bot_id)
        ORDER BY c.created_at, c.user_id
      `)
      .all(input.tenantId, input.botId);
    return rows.map(mapBotCollaborator);
  }

  async setBotCollaborator(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly userId: UserId;
    readonly role: BotCollaboratorRole;
    readonly now: string;
  }): Promise<BotCollaborator> {
    if (input.userId === input.ownerId) {
      throw new AppError("VALIDATION_ERROR", "The bot owner cannot be added as a collaborator.", 400);
    }
    const set = this.#db.transaction(() => {
      this.requireActiveBotOwner(input.tenantId, input.ownerId, input.botId);
      const member = this.#db
        .query<{ status: "active" | "inactive" }, [string, string]>(`
          SELECT status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?
        `)
        .get(input.tenantId, input.userId);
      if (member?.status !== "active") {
        throw new AppError("NOT_FOUND", "Active workspace member was not found.", 404);
      }
      this.#db
        .query(`
          INSERT INTO bot_collaborators (tenant_id, bot_id, user_id, role, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, bot_id, user_id)
          DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
        `)
        .run(input.tenantId, input.botId, input.userId, input.role, input.now, input.now);
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'bot.collaborator.set', 'bot', ?, ?, ?)
        `)
        .run(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.ownerId,
          input.botId,
          JSON.stringify({ userId: input.userId, role: input.role }),
          input.now,
        );
      return this.getBotCollaborator(input.tenantId, input.botId, input.userId);
    });
    return set.immediate();
  }

  async removeBotCollaborator(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly userId: UserId;
    readonly now: string;
  }): Promise<void> {
    const remove = this.#db.transaction(() => {
      this.requireActiveBotOwner(input.tenantId, input.ownerId, input.botId);
      const result = this.#db
        .query("DELETE FROM bot_collaborators WHERE tenant_id = ? AND bot_id = ? AND user_id = ?")
        .run(input.tenantId, input.botId, input.userId);
      if (result.changes !== 1) throw new AppError("NOT_FOUND", "Bot collaborator was not found.", 404);
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'bot.collaborator.removed', 'bot', ?, ?, ?)
        `)
        .run(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.ownerId,
          input.botId,
          JSON.stringify({ userId: input.userId }),
          input.now,
        );
    });
    remove.immediate();
  }

  async updateCollaborated(input: {
    readonly tenantId: TenantId;
    readonly userId: UserId;
    readonly botId: BotId;
    readonly expectedVersion: number;
    readonly patch: BotCollaboratorSettingsPatch;
  }): Promise<BotDefinition> {
    const keys = Object.keys(input.patch);
    if (keys.length === 0 || keys.some((key) => !["name", "description", "systemPrompt"].includes(key))) {
      throw new AppError("VALIDATION_ERROR", "Collaborators can update only bot identity settings.", 400);
    }
    const patch = validateBotSettingsPatch(input.patch);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AppError("VALIDATION_ERROR", "Expected bot version is invalid.", 400);
    }
    const update = this.#db.transaction(() => {
      const row = this.#db
        .query<BotRow & { collaborator_role: BotCollaboratorRole }, [string, string, string]>(`
          SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
                 b.visibility, b.current_version, b.created_at, b.updated_at,
                 v.configuration_json, c.role AS collaborator_role
          FROM bot_collaborators AS c
          JOIN tenant_memberships AS cm
            ON cm.tenant_id = c.tenant_id AND cm.user_id = c.user_id AND cm.status = 'active'
          JOIN bots AS b ON b.id = c.bot_id AND b.tenant_id = c.tenant_id
          JOIN tenant_memberships AS om
            ON om.tenant_id = b.tenant_id AND om.user_id = b.owner_id AND om.status = 'active'
          JOIN bot_versions AS v
            ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
          WHERE c.tenant_id = ? AND c.bot_id = ? AND c.user_id = ? AND b.owner_id <> c.user_id
        `)
        .get(input.tenantId, input.botId, input.userId);
      if (!row) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
      if (row.collaborator_role !== "editor") {
        throw new AppError("FORBIDDEN", "Editor access is required to change bot identity settings.", 403);
      }
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
      this.#db
        .query(`
          INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
          SELECT ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM bot_collaborators AS c
            JOIN tenant_memberships AS m ON m.tenant_id = c.tenant_id AND m.user_id = c.user_id
            WHERE c.tenant_id = ? AND c.bot_id = ? AND c.user_id = ? AND c.role = 'editor'
              AND c.user_id <> (SELECT owner_id FROM bots WHERE tenant_id = c.tenant_id AND id = c.bot_id)
              AND m.status = 'active'
          )
        `)
        .run(
          updated.id,
          updated.tenantId,
          updated.version,
          JSON.stringify(configurationFromBot(updated)),
          input.userId,
          updated.updatedAt,
          input.tenantId,
          input.botId,
          input.userId,
        );
      const result = this.#db
        .query(`
          UPDATE bots SET name = ?, description = ?, current_version = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND current_version = ?
            AND EXISTS (
              SELECT 1 FROM bot_collaborators AS c
              JOIN tenant_memberships AS cm ON cm.tenant_id = c.tenant_id AND cm.user_id = c.user_id
              JOIN tenant_memberships AS om ON om.tenant_id = bots.tenant_id AND om.user_id = bots.owner_id
              WHERE c.tenant_id = bots.tenant_id AND c.bot_id = bots.id AND c.user_id = ?
                AND c.role = 'editor' AND c.user_id <> bots.owner_id
                AND cm.status = 'active' AND om.status = 'active'
            )
        `)
        .run(
          updated.name,
          updated.description,
          updated.version,
          updated.updatedAt,
          input.tenantId,
          input.botId,
          input.expectedVersion,
          input.userId,
        );
      if (result.changes !== 1) throw new AppError("CONFLICT", "Bot changed; reload it before applying edits.", 409);
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'bot.collaborator.settings_updated', 'bot', ?, ?, ?)
        `)
        .run(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.userId,
          input.botId,
          JSON.stringify({ fields: keys.sort() }),
          updated.updatedAt,
        );
      return updated;
    });
    return update.immediate();
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
    const rows = this.#db
      .query<BotVersionRow, [string, string, string, number]>(`
        SELECT v.bot_id, v.version, b.current_version, v.configuration_json, v.created_at
        FROM bots AS b
        JOIN bot_versions AS v ON v.bot_id = b.id AND v.tenant_id = b.tenant_id
        WHERE b.tenant_id = ? AND b.owner_id = ? AND b.id = ?
        ORDER BY v.version DESC
        LIMIT ?
      `)
      .all(input.tenantId, input.ownerId, input.botId, input.limit);
    if (!rows.length) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    return rows.map((row) =>
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
    const rows = this.#db
      .query<PublicListingRow, [string, string, string, number]>(`
        SELECT p.bot_id, p.slug, p.title, p.summary, p.listed_at,
               p.daily_usage_limit, p.rate_limit_per_minute
        FROM public_bot_listings AS p
        JOIN bots AS b ON b.id = p.bot_id AND b.tenant_id = p.tenant_id
        WHERE b.status = 'published' AND b.visibility = 'public'
          AND (? = '' OR lower(p.title) LIKE ? OR lower(p.summary) LIKE ?)
        ORDER BY p.listed_at DESC, p.slug
        LIMIT ?
      `)
      .all(query, `%${query}%`, `%${query}%`, input.limit);
    return rows.map(mapPublicListing);
  }

  async getPublicBotBySlug(slug: string): Promise<BotDefinition | undefined> {
    const row = this.#db
      .query<BotRow, [string]>(`
        SELECT b.id, b.tenant_id, b.owner_id, b.name, b.description, b.status,
               b.visibility, b.current_version, b.created_at, b.updated_at, v.configuration_json
        FROM public_bot_listings AS p
        JOIN bots AS b ON b.id = p.bot_id AND b.tenant_id = p.tenant_id
        JOIN bot_versions AS v ON v.bot_id = b.id AND v.tenant_id = b.tenant_id AND v.version = b.current_version
        WHERE p.slug = ? AND b.status = 'published' AND b.visibility = 'public'
      `)
      .get(slug);
    return row ? mapBot(row) : undefined;
  }

  async getSharedBot(input: { botId: BotId; userId: UserId; now: string }): Promise<BotDefinition | undefined> {
    const row = this.#db
      .query<BotRow, [string, string, string]>(`
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
      .get(input.botId, input.userId, input.now);
    return row ? mapBot(row) : undefined;
  }

  async listOwnedAccessGrants(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
  }): Promise<readonly BotAccessGrant[]> {
    this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    return this.#db
      .query<AccessGrantRow, [string, string]>(`
        SELECT id, bot_id, user_id, invitation_token_hash, access_level, status,
               usage_limit, rate_limit_per_minute, expires_at, created_at
        FROM bot_access_grants WHERE tenant_id = ? AND bot_id = ?
        ORDER BY created_at DESC, id
      `)
      .all(input.tenantId, input.botId)
      .map(mapAccessGrant);
  }

  async getOwnedPublicBotAccessPolicy(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
  }): Promise<PublicBotListing | undefined> {
    const bot = this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    if (bot.visibility !== "public") return undefined;
    const row = this.#db
      .query<PublicListingRow, [string, string]>(`
        SELECT bot_id, slug, title, summary, listed_at, daily_usage_limit, rate_limit_per_minute
        FROM public_bot_listings WHERE tenant_id = ? AND bot_id = ?
      `)
      .get(input.tenantId, input.botId);
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
    const bot = this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    if (bot.visibility !== "public") throw new AppError("CONFLICT", "Only public bots have public access limits.", 409);
    const result = this.#db
      .query(`
        UPDATE public_bot_listings SET daily_usage_limit = ?, rate_limit_per_minute = ?, listed_at = ?
        WHERE tenant_id = ? AND bot_id = ?
      `)
      .run(input.dailyUsageLimit, input.rateLimitPerMinute, input.now, input.tenantId, input.botId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Public bot listing is not available yet.", 409);
    const row = this.#db
      .query<PublicListingRow, [string, string]>(`
        SELECT bot_id, slug, title, summary, listed_at, daily_usage_limit, rate_limit_per_minute
        FROM public_bot_listings WHERE tenant_id = ? AND bot_id = ?
      `)
      .get(input.tenantId, input.botId);
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
    const bot = this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
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
        this.#db
          .query(`
            INSERT INTO bot_access_grants (
              id, tenant_id, bot_id, user_id, invitation_token_hash, access_level, status,
              usage_limit, rate_limit_per_minute, expires_at, created_at
            ) VALUES (?, ?, ?, ?, NULL, 'use', 'active', ?, ?, ?, ?)
            ON CONFLICT(bot_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET
              status = 'active', access_level = 'use', usage_limit = excluded.usage_limit,
              rate_limit_per_minute = excluded.rate_limit_per_minute,
              expires_at = excluded.expires_at, created_at = excluded.created_at
          `)
          .run(
            id,
            input.tenantId,
            input.botId,
            input.userId,
            input.dailyUsageLimit ?? null,
            input.rateLimitPerMinute ?? null,
            input.expiresAt ?? null,
            input.now,
          );
      } else {
        const invitationTokenHash = input.invitationTokenHash;
        if (!invitationTokenHash) {
          throw new AppError("VALIDATION_ERROR", "Invitation token hash is required.", 400);
        }
        this.#db
          .query(`
            INSERT INTO bot_access_grants (
              id, tenant_id, bot_id, user_id, invitation_token_hash, access_level, status,
              usage_limit, rate_limit_per_minute, expires_at, created_at
            ) VALUES (?, ?, ?, NULL, ?, 'use', 'active', ?, ?, ?, ?)
          `)
          .run(
            id,
            input.tenantId,
            input.botId,
            invitationTokenHash,
            input.dailyUsageLimit ?? null,
            input.rateLimitPerMinute ?? null,
            input.expiresAt ?? null,
            input.now,
          );
      }
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("CONFLICT", "Bot access grant could not be created.", 409, { cause });
    }
    const row = input.userId
      ? this.#db
          .query<AccessGrantRow, [string, string, string]>(`
            SELECT id, bot_id, user_id, invitation_token_hash, access_level, status,
                   usage_limit, rate_limit_per_minute, expires_at, created_at
            FROM bot_access_grants WHERE tenant_id = ? AND bot_id = ? AND user_id = ?
          `)
          .get(input.tenantId, input.botId, input.userId)
      : this.#db
          .query<AccessGrantRow, [string]>(`
            SELECT id, bot_id, user_id, invitation_token_hash, access_level, status,
                   usage_limit, rate_limit_per_minute, expires_at, created_at
            FROM bot_access_grants WHERE id = ?
          `)
          .get(id);
    if (!row) throw new AppError("INTERNAL_ERROR", "Created access grant could not be loaded.", 500);
    return mapAccessGrant(row);
  }

  async revokeOwnedAccessGrant(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    grantId: string;
  }): Promise<boolean> {
    this.requireOwnedAccessBot(input.tenantId, input.ownerId, input.botId);
    const result = this.#db
      .query(`
        UPDATE bot_access_grants SET status = 'revoked', invitation_token_hash = NULL
        WHERE tenant_id = ? AND bot_id = ? AND id = ? AND status != 'revoked'
      `)
      .run(input.tenantId, input.botId, input.grantId);
    return result.changes === 1;
  }

  async acceptBotInvitation(input: {
    invitationTokenHash: string;
    userId: UserId;
    now: string;
  }): Promise<BotAccessGrant | undefined> {
    const accept = this.#db.transaction(() => {
      const grant = this.#db
        .query<{ id: string; bot_id: string }, [string, string]>(`
          SELECT g.id, g.bot_id FROM bot_access_grants AS g
          JOIN bots AS b ON b.id = g.bot_id AND b.tenant_id = g.tenant_id
          WHERE g.invitation_token_hash = ? AND g.status = 'active'
            AND (g.expires_at IS NULL OR g.expires_at > ?)
            AND b.status = 'published' AND b.visibility IN ('shared', 'invitation')
        `)
        .get(input.invitationTokenHash, input.now);
      if (!grant) return undefined;
      this.#db
        .query(`
          UPDATE bot_access_grants SET user_id = ?, invitation_token_hash = NULL
          WHERE id = ? AND invitation_token_hash = ? AND user_id IS NULL
        `)
        .run(input.userId, grant.id, input.invitationTokenHash);
      return this.#db
        .query<AccessGrantRow, [string, string]>(`
          SELECT id, bot_id, user_id, invitation_token_hash, access_level, status,
                 usage_limit, rate_limit_per_minute, expires_at, created_at
          FROM bot_access_grants WHERE id = ? AND user_id = ?
        `)
        .get(grant.id, input.userId);
    });
    const row = accept.immediate();
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
    const consume = this.#db.transaction((): BotAccessDecision => {
      const finish = (decision: BotAccessDecision): BotAccessDecision => {
        const id = `audit_${crypto.randomUUID().replaceAll("-", "")}`;
        this.#db
          .query(`
            INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
            SELECT ?, b.tenant_id, ?, 'bot.access.decision', 'bot', b.id, ?, ?
            FROM bots AS b WHERE b.id = ?
          `)
          .run(
            id,
            input.userId,
            JSON.stringify({ outcome: decision, accessMode: input.accessMode }),
            input.now,
            input.botId,
          );
        return decision;
      };
      const entitlement = this.#db
        .query<
          { tenant_id: string; daily_limit: number; rate_limit: number },
          [string, string, string, string, string, string]
        >(`
          SELECT b.tenant_id, COALESCE(g.usage_limit, p.daily_usage_limit, 100) AS daily_limit,
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
        .get(input.userId, input.now, input.botId, input.accessMode, input.userId, input.accessMode);
      if (!entitlement) return finish("forbidden");
      const existing = this.#db
        .query<
          {
            minute_window: number;
            minute_count: number;
            day_window: number;
            day_count: number;
          },
          [string, string, string]
        >(`
          SELECT minute_window, minute_count, day_window, day_count
          FROM bot_access_usage WHERE tenant_id = ? AND bot_id = ? AND user_id = ?
        `)
        .get(entitlement.tenant_id, input.botId, input.userId);
      const minuteCount = existing?.minute_window === minuteWindow ? existing.minute_count : 0;
      const dayCount = existing?.day_window === dayWindow ? existing.day_count : 0;
      if (dayCount >= entitlement.daily_limit) return finish("quota_exceeded");
      if (minuteCount >= entitlement.rate_limit) return finish("rate_limited");
      const result = this.#db
        .query(`
          INSERT INTO bot_access_usage (
            tenant_id, bot_id, user_id, minute_window, minute_count, day_window, day_count,
            rate_limit_per_minute, daily_usage_limit, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)
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
        .run(
          entitlement.tenant_id,
          input.botId,
          input.userId,
          minuteWindow,
          dayWindow,
          entitlement.rate_limit,
          entitlement.daily_limit,
          input.now,
        );
      if (result.changes !== 1) {
        if (dayCount >= entitlement.daily_limit) return finish("quota_exceeded");
        if (minuteCount >= entitlement.rate_limit) return finish("rate_limited");
        return finish("forbidden");
      }
      return finish("allowed");
    });
    return consume.immediate();
  }

  private requireOwnedAccessBot(tenantId: TenantId, ownerId: UserId, botId: BotId): { visibility: BotVisibility } {
    const bot = this.#db
      .query<{ owner_id: string; visibility: BotVisibility }, [string, string]>(
        "SELECT owner_id, visibility FROM bots WHERE tenant_id = ? AND id = ?",
      )
      .get(tenantId, botId);
    if (!bot || bot.owner_id !== ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    return { visibility: bot.visibility };
  }

  private requireActiveBotOwner(tenantId: TenantId, ownerId: UserId, botId: BotId): void {
    const row = this.#db
      .query<{ owner_id: string }, [string, string, string]>(`
        SELECT b.owner_id FROM bots AS b
        JOIN tenant_memberships AS m ON m.tenant_id = b.tenant_id AND m.user_id = b.owner_id AND m.status = 'active'
        WHERE b.tenant_id = ? AND b.id = ? AND b.owner_id = ?
      `)
      .get(tenantId, botId, ownerId);
    if (!row) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
  }

  private getBotCollaborator(tenantId: TenantId, botId: BotId, userId: UserId): BotCollaborator {
    const row = this.#db
      .query<BotCollaboratorRow, [string, string, string]>(`
        SELECT c.user_id, c.role, m.status AS member_status, c.created_at, c.updated_at
        FROM bot_collaborators AS c
        JOIN tenant_memberships AS m ON m.tenant_id = c.tenant_id AND m.user_id = c.user_id
        WHERE c.tenant_id = ? AND c.bot_id = ? AND c.user_id = ?
      `)
      .get(tenantId, botId, userId);
    if (!row) throw new AppError("INTERNAL_ERROR", "Bot collaborator could not be loaded after it was saved.", 500);
    return mapBotCollaborator(row);
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
    const create = this.#db.transaction((): BotOwnershipTransfer => {
      this.#db
        .query(`
          UPDATE bot_ownership_transfers SET status = 'expired', token_hash = NULL
          WHERE tenant_id = ? AND bot_id = ? AND status = 'pending' AND expires_at <= ?
        `)
        .run(input.tenantId, input.botId, input.createdAt);
      const bot = this.#db
        .query<{ owner_id: string }, [string, string]>("SELECT owner_id FROM bots WHERE tenant_id = ? AND id = ?")
        .get(input.tenantId, input.botId);
      if (!bot || bot.owner_id !== input.fromOwnerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
      if (input.fromOwnerId === input.toOwnerId) {
        throw new AppError("VALIDATION_ERROR", "Choose another active workspace member.", 400);
      }
      const recipient = this.#db
        .query<{ status: string }, [string, string]>(
          "SELECT status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?",
        )
        .get(input.tenantId, input.toOwnerId);
      if (recipient?.status !== "active") {
        throw new AppError("NOT_FOUND", "The recipient must be an active member of this workspace.", 404);
      }
      const pending = this.#db
        .query<{ id: string }, [string, string]>(`
          SELECT id FROM bot_ownership_transfers WHERE tenant_id = ? AND bot_id = ? AND status = 'pending'
        `)
        .get(input.tenantId, input.botId);
      if (pending) throw new AppError("CONFLICT", "This bot already has a pending ownership transfer.", 409);
      this.#db
        .query(`
          INSERT INTO bot_ownership_transfers (
            id, tenant_id, bot_id, from_owner_id, to_owner_id, token_hash,
            status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `)
        .run(
          input.transferId,
          input.tenantId,
          input.botId,
          input.fromOwnerId,
          input.toOwnerId,
          input.tokenHash,
          input.createdAt,
          input.expiresAt,
        );
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'bot.ownership_transfer.created', 'bot', ?, ?, ?)
        `)
        .run(
          crypto.randomUUID(),
          input.tenantId,
          input.fromOwnerId,
          input.botId,
          JSON.stringify({ transferId: input.transferId, toOwnerId: input.toOwnerId }),
          input.createdAt,
        );
      return {
        id: input.transferId,
        botId: input.botId,
        fromOwnerId: input.fromOwnerId,
        toOwnerId: input.toOwnerId,
        status: "pending",
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      };
    });
    try {
      return create.immediate();
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("UNIQUE constraint failed")) {
        throw new AppError("CONFLICT", "This bot already has a pending ownership transfer.", 409, { cause });
      }
      throw cause;
    }
  }

  async getPending(input: {
    tenantId: TenantId;
    botId: BotId;
    ownerId: UserId;
    now: string;
  }): Promise<BotOwnershipTransfer | undefined> {
    const row = this.#db
      .query<BotOwnershipTransferRow, [string, string, string, string]>(`
        SELECT x.id, x.bot_id, x.from_owner_id, x.to_owner_id, x.status, x.created_at, x.expires_at,
               x.accepted_at, x.revoked_at
        FROM bot_ownership_transfers AS x
        WHERE x.tenant_id = ? AND x.bot_id = ? AND x.from_owner_id = ? AND x.status = 'pending' AND x.expires_at > ?
          AND EXISTS (
            SELECT 1 FROM bots AS b WHERE b.tenant_id = x.tenant_id AND b.id = x.bot_id AND b.owner_id = x.from_owner_id
          )
      `)
      .get(input.tenantId, input.botId, input.ownerId, input.now);
    return row ? mapBotOwnershipTransfer(row) : undefined;
  }

  async revoke(input: {
    tenantId: TenantId;
    botId: BotId;
    ownerId: UserId;
    transferId: string;
    now: string;
  }): Promise<BotOwnershipTransfer> {
    const revoke = this.#db.transaction((): BotOwnershipTransfer => {
      const row = this.#db
        .query<BotOwnershipTransferRow, [string, string, string, string]>(`
          SELECT id, bot_id, from_owner_id, to_owner_id, status, created_at, expires_at, accepted_at, revoked_at
          FROM bot_ownership_transfers
          WHERE tenant_id = ? AND bot_id = ? AND from_owner_id = ? AND id = ?
        `)
        .get(input.tenantId, input.botId, input.ownerId, input.transferId);
      if (!row) throw new AppError("NOT_FOUND", "Ownership transfer was not found.", 404);
      const bot = this.#db
        .query<{ owner_id: string }, [string, string]>("SELECT owner_id FROM bots WHERE tenant_id = ? AND id = ?")
        .get(input.tenantId, input.botId);
      if (!bot || bot.owner_id !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
      if (row.status === "pending" && row.expires_at <= input.now) {
        this.#db
          .query(
            "UPDATE bot_ownership_transfers SET status = 'expired', token_hash = NULL WHERE id = ? AND status = 'pending'",
          )
          .run(row.id);
        return { ...mapBotOwnershipTransfer(row), status: "expired" };
      }
      if (row.status === "revoked") return mapBotOwnershipTransfer(row);
      if (row.status !== "pending") throw new AppError("CONFLICT", "Ownership transfer is no longer pending.", 409);
      this.#db
        .query(`
          UPDATE bot_ownership_transfers SET status = 'revoked', token_hash = NULL, revoked_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?
        `)
        .run(input.now, row.id, input.now);
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'bot.ownership_transfer.revoked', 'bot', ?, ?, ?)
        `)
        .run(
          crypto.randomUUID(),
          input.tenantId,
          input.ownerId,
          input.botId,
          JSON.stringify({ transferId: input.transferId, toOwnerId: row.to_owner_id }),
          input.now,
        );
      return { ...mapBotOwnershipTransfer(row), status: "revoked", revokedAt: input.now };
    });
    return revoke.immediate();
  }

  async accept(input: {
    tenantId: TenantId;
    tokenHash: string;
    recipientId: UserId;
    now: string;
  }): Promise<BotOwnershipTransfer> {
    const accept = this.#db.transaction((): BotOwnershipTransfer => {
      const row = this.#db
        .query<BotOwnershipTransferRow & { token_hash: string }, [string, string, string, string]>(`
          SELECT id, bot_id, from_owner_id, to_owner_id, token_hash, status, created_at, expires_at, accepted_at, revoked_at
          FROM bot_ownership_transfers
          WHERE tenant_id = ? AND token_hash = ? AND to_owner_id = ? AND status = 'pending' AND expires_at > ?
        `)
        .get(input.tenantId, input.tokenHash, input.recipientId, input.now);
      if (!row) throw new AppError("NOT_FOUND", "Transfer is invalid, expired, or not addressed to this account.", 404);
      const recipient = this.#db
        .query<{ status: string }, [string, string]>(
          "SELECT status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?",
        )
        .get(input.tenantId, input.recipientId);
      if (recipient?.status !== "active") {
        throw new AppError("FORBIDDEN", "Join this workspace before accepting its bot transfer.", 403);
      }
      const bot = this.#db
        .query<{ owner_id: string }, [string, string]>("SELECT owner_id FROM bots WHERE tenant_id = ? AND id = ?")
        .get(input.tenantId, row.bot_id);
      if (!bot || bot.owner_id !== row.from_owner_id) {
        throw new AppError("CONFLICT", "Bot ownership changed before this transfer was accepted.", 409);
      }
      const running = this.#db
        .query<{ id: string }, [string, string]>(`
          SELECT jobs.id FROM jobs
          JOIN scheduled_tasks ON scheduled_tasks.tenant_id = jobs.tenant_id
            AND json_extract(jobs.payload_json, '$.taskId') = scheduled_tasks.id
          WHERE jobs.tenant_id = ? AND scheduled_tasks.bot_id = ?
            AND jobs.kind = 'scheduled_task' AND jobs.status = 'running' LIMIT 1
        `)
        .get(input.tenantId, row.bot_id);
      if (running) {
        throw new AppError(
          "CONFLICT",
          "A scheduled run is active. Wait for it to finish before accepting the transfer.",
          409,
        );
      }
      const ownership = this.#db
        .query(`
          UPDATE bots SET owner_id = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND owner_id = ?
            AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active')
            AND EXISTS (SELECT 1 FROM bot_ownership_transfers WHERE id = ? AND token_hash = ? AND status = 'pending' AND expires_at > ?)
        `)
        .run(
          input.recipientId,
          input.now,
          input.tenantId,
          row.bot_id,
          row.from_owner_id,
          input.tenantId,
          input.recipientId,
          row.id,
          input.tokenHash,
          input.now,
        );
      if (ownership.changes !== 1) throw new AppError("CONFLICT", "Ownership transfer changed before acceptance.", 409);
      this.#db
        .query(`
          UPDATE bot_files SET owner_id = ?
          WHERE tenant_id = ? AND bot_id = ? AND owner_id = ?
        `)
        .run(input.recipientId, input.tenantId, row.bot_id, row.from_owner_id);
      this.#db
        .query(`
          DELETE FROM creation_approvals
          WHERE tenant_id = ? AND session_id IN (
            SELECT id FROM factory_sessions WHERE tenant_id = ? AND bot_id = ?
          )
        `)
        .run(input.tenantId, input.tenantId, row.bot_id);
      this.#db
        .query(`
          UPDATE factory_sessions SET owner_id = ?, updated_at = ?
          WHERE tenant_id = ? AND bot_id = ? AND owner_id = ?
        `)
        .run(input.recipientId, input.now, input.tenantId, row.bot_id, row.from_owner_id);
      this.#db
        .query(`
          UPDATE scheduled_tasks
          SET owner_id = ?, status = CASE WHEN status = 'active' THEN 'paused' ELSE status END,
              next_run_at = CASE WHEN status = 'active' THEN NULL ELSE next_run_at END, updated_at = ?
          WHERE tenant_id = ? AND bot_id = ?
        `)
        .run(input.recipientId, input.now, input.tenantId, row.bot_id);
      this.#db
        .query(`
          UPDATE jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?
          WHERE tenant_id = ? AND kind = 'scheduled_task' AND status IN ('queued', 'retrying')
            AND json_extract(payload_json, '$.taskId') IN (
              SELECT id FROM scheduled_tasks WHERE tenant_id = ? AND bot_id = ?
            )
        `)
        .run(input.now, input.tenantId, input.tenantId, row.bot_id);
      this.#db
        .query(`
          UPDATE bot_access_grants SET status = 'revoked', invitation_token_hash = NULL
          WHERE tenant_id = ? AND bot_id = ? AND user_id = ? AND status = 'active'
        `)
        .run(input.tenantId, row.bot_id, row.from_owner_id);
      const accepted = this.#db
        .query(`
          UPDATE bot_ownership_transfers SET status = 'accepted', token_hash = NULL, accepted_at = ?
          WHERE id = ? AND tenant_id = ? AND token_hash = ? AND status = 'pending' AND expires_at > ?
        `)
        .run(input.now, row.id, input.tenantId, input.tokenHash, input.now);
      if (accepted.changes !== 1) throw new AppError("CONFLICT", "Ownership transfer changed before acceptance.", 409);
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'bot.ownership_transfer.accepted', 'bot', ?, ?, ?)
        `)
        .run(
          crypto.randomUUID(),
          input.tenantId,
          input.recipientId,
          row.bot_id,
          JSON.stringify({ transferId: row.id, fromOwnerId: row.from_owner_id }),
          input.now,
        );
      return { ...mapBotOwnershipTransfer(row), status: "accepted", acceptedAt: input.now };
    });
    return accept.immediate();
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
          ...(input.answers.imageModel ? { imageModel: input.answers.imageModel } : {}),
          ...(input.answers.searchModel ? { searchModel: input.answers.searchModel } : {}),
          ...(input.answers.audioModel ? { audioModel: input.answers.audioModel } : {}),
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

  async listOwnedConversations(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    limit: number;
    offset: number;
  }): Promise<readonly ConversationSummary[]> {
    const bot = this.#db
      .query<{ id: string }, [string, string, string]>(`
        SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?
      `)
      .get(input.tenantId, input.ownerId, input.botId);
    if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    const rows = this.#db
      .query<
        {
          id: string;
          platform: ConversationSummary["platform"];
          message_count: number;
          preview: string;
          created_at: string;
          updated_at: string;
        },
        [string, string, string, number, number]
      >(`
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
      .all(input.tenantId, input.ownerId, input.botId, input.limit, input.offset);
    return rows.map((row) => ({
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
    const exists = this.#db
      .query<{ id: string }, [string, string, string, string]>(`
        SELECT c.id FROM conversations AS c
        JOIN bots AS b ON b.id = c.bot_id AND b.tenant_id = c.tenant_id
        WHERE c.tenant_id = ? AND b.owner_id = ? AND c.bot_id = ? AND c.id = ?
      `)
      .get(input.tenantId, input.ownerId, input.botId, input.conversationId);
    if (!exists) return undefined;
    const before = input.beforeSequence ?? null;
    const rows = this.#db
      .query<ConversationHistoryRow, [string, string, number | null, number | null, number]>(`
        SELECT id, sequence, role, content, metadata_json, created_at FROM (
          SELECT id, sequence, role, content, metadata_json, created_at
          FROM messages
          WHERE tenant_id = ? AND conversation_id = ? AND (? IS NULL OR sequence < ?)
          ORDER BY sequence DESC LIMIT ?
        ) ORDER BY sequence ASC
      `)
      .all(input.tenantId, input.conversationId, before, before, input.limit + 1);
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(1) : rows;
    return { items: pageRows.map(mapStoredMessage), hasMore };
  }

  async deleteOwnedConversation(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    conversationId: ConversationId;
  }): Promise<boolean> {
    const result = this.#db
      .query(`
        DELETE FROM conversations
        WHERE tenant_id = ? AND bot_id = ? AND id = ?
          AND EXISTS (
            SELECT 1 FROM bots
            WHERE bots.tenant_id = conversations.tenant_id
              AND bots.id = conversations.bot_id
              AND bots.owner_id = ?
          )
      `)
      .run(input.tenantId, input.botId, input.conversationId, input.ownerId);
    return result.changes === 1;
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    this.#db
      .query(
        `INSERT INTO usage_records (
          id, tenant_id, bot_id, actor_id, provider_id, model, input_tokens, output_tokens, usage_reported, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  }

  async recordModelRetry(record: Parameters<UsageRepository["recordModelRetry"]>[0]): Promise<void> {
    this.#db
      .query(
        `INSERT INTO model_retry_events (
          id, tenant_id, bot_id, attempt, max_attempts, delay_ms, status_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenantId,
        record.botId,
        record.attempt,
        record.maxAttempts,
        record.delayMs,
        record.statusCode,
        record.createdAt,
      );
  }

  async getOwnedUsageSummary(input: {
    tenantId: TenantId;
    ownerId: UserId;
    from: string;
    through: string;
  }): Promise<UsageSummary> {
    const params: [string, string, string, string] = [input.tenantId, input.ownerId, input.from, input.through];
    const dailyRows = this.#db
      .query<UsageAggregateRow, [string, string, string, string]>(`
        SELECT substr(u.created_at, 1, 10) AS date, count(*) AS requests,
          sum(u.usage_reported) AS reported_requests,
          sum(CASE WHEN u.usage_reported = 1 THEN u.input_tokens ELSE 0 END) AS input_tokens,
          sum(CASE WHEN u.usage_reported = 1 THEN u.output_tokens ELSE 0 END) AS output_tokens
        FROM usage_records AS u JOIN bots AS b ON b.id = u.bot_id AND b.tenant_id = u.tenant_id
        WHERE u.tenant_id = ? AND b.owner_id = ? AND u.created_at >= ? AND u.created_at <= ?
        GROUP BY substr(u.created_at, 1, 10) ORDER BY date ASC
      `)
      .all(...params);
    const botRows = this.#db
      .query<UsageBotAggregateRow, [string, string, string, string]>(`
        SELECT b.id AS bot_id, b.name AS bot_name, count(*) AS requests,
          sum(u.usage_reported) AS reported_requests,
          sum(CASE WHEN u.usage_reported = 1 THEN u.input_tokens ELSE 0 END) AS input_tokens,
          sum(CASE WHEN u.usage_reported = 1 THEN u.output_tokens ELSE 0 END) AS output_tokens
        FROM usage_records AS u JOIN bots AS b ON b.id = u.bot_id AND b.tenant_id = u.tenant_id
        WHERE u.tenant_id = ? AND b.owner_id = ? AND u.created_at >= ? AND u.created_at <= ?
        GROUP BY b.id ORDER BY requests DESC, b.name ASC LIMIT 100
      `)
      .all(...params);
    const retryDailyRows = this.#db
      .query<ModelRetryAggregateRow, [string, string, string, string]>(`
        SELECT substr(r.created_at, 1, 10) AS date, count(*) AS retries
        FROM model_retry_events AS r JOIN bots AS b ON b.id = r.bot_id AND b.tenant_id = r.tenant_id
        WHERE r.tenant_id = ? AND b.owner_id = ? AND r.created_at >= ? AND r.created_at <= ?
        GROUP BY substr(r.created_at, 1, 10) ORDER BY date ASC
      `)
      .all(...params);
    const retryBotRows = this.#db
      .query<ModelRetryBotAggregateRow, [string, string, string, string]>(`
        SELECT b.id AS bot_id, b.name AS bot_name, count(*) AS retries
        FROM model_retry_events AS r JOIN bots AS b ON b.id = r.bot_id AND b.tenant_id = r.tenant_id
        WHERE r.tenant_id = ? AND b.owner_id = ? AND r.created_at >= ? AND r.created_at <= ?
        GROUP BY b.id ORDER BY retries DESC, b.name ASC LIMIT 100
      `)
      .all(...params);
    const retryStatusRows = this.#db
      .query<ModelRetryStatusAggregateRow, [string, string, string, string]>(`
        SELECT r.status_code, count(*) AS retries
        FROM model_retry_events AS r JOIN bots AS b ON b.id = r.bot_id AND b.tenant_id = r.tenant_id
        WHERE r.tenant_id = ? AND b.owner_id = ? AND r.created_at >= ? AND r.created_at <= ?
        GROUP BY r.status_code ORDER BY retries DESC, r.status_code ASC
      `)
      .all(...params);
    const total = dailyRows.reduce(
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
      byDay: dailyRows.map((row) => ({
        date: row.date ?? "",
        requests: row.requests,
        reportedRequests: row.reported_requests,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
      byBot: botRows.map((row) => ({
        botId: row.bot_id as BotId,
        botName: row.bot_name ?? "",
        requests: row.requests,
        reportedRequests: row.reported_requests,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
      modelRetries: {
        total: retryDailyRows.reduce((sum, row) => sum + row.retries, 0),
        byDay: retryDailyRows.map((row) => ({ date: row.date ?? "", retries: row.retries })),
        byBot: retryBotRows.map((row) => ({
          botId: row.bot_id as BotId,
          botName: row.bot_name ?? "",
          retries: row.retries,
        })),
        byStatusCode: retryStatusRows.map((row) => ({ statusCode: row.status_code, retries: row.retries })),
      },
    };
  }

  async listOwnedBotMemory(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
  }): Promise<readonly StoredBotMemoryRecord[]> {
    const bot = this.#db
      .query<{ id: string }, [string, string, string]>(
        "SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?",
      )
      .get(input.tenantId, input.ownerId, input.botId);
    if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    const rows = this.#db
      .query<MemoryRow, [string, string]>(`
        SELECT id, bot_id, memory_key, value_json, encrypted_value, expires_at, created_at, updated_at
        FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL
        ORDER BY updated_at DESC, memory_key ASC LIMIT 16
      `)
      .all(input.tenantId, input.botId);
    return rows.map(mapBotMemory);
  }

  async listActiveBotMemory(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    now: string;
  }): Promise<readonly StoredBotMemoryRecord[]> {
    const bot = this.#db
      .query<{ id: string }, [string, string, string]>(
        "SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?",
      )
      .get(input.tenantId, input.ownerId, input.botId);
    if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    const rows = this.#db
      .query<MemoryRow, [string, string]>(`
        SELECT id, bot_id, memory_key, value_json, encrypted_value, expires_at, created_at, updated_at
        FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL
        ORDER BY updated_at DESC, memory_key ASC LIMIT 16
      `)
      .all(input.tenantId, input.botId);
    return rows.map(mapBotMemory);
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
    const save = this.#db.transaction(() => {
      const bot = this.#db
        .query<{ id: string }, [string, string, string]>(
          "SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?",
        )
        .get(input.tenantId, input.ownerId, input.botId);
      if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
      this.#db
        .query("DELETE FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND expires_at <= ?")
        .run(input.tenantId, input.botId, input.now);
      const existing = this.#db
        .query<{ id: string }, [string, string, string]>(`
          SELECT id FROM memory_records
          WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND memory_key = ?
        `)
        .get(input.tenantId, input.botId, input.key);
      if (!existing) {
        const count = this.#db
          .query<{ count: number }, [string, string]>(`
            SELECT count(*) AS count FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL
          `)
          .get(input.tenantId, input.botId)?.count;
        if ((count ?? 0) >= 16) {
          throw new AppError("CONFLICT", "A bot can store at most 16 memory records.", 409);
        }
        this.#db
          .query(`
            INSERT INTO memory_records (id, tenant_id, bot_id, actor_id, memory_key, value_json, encrypted_value, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            `memory_${crypto.randomUUID().replaceAll("-", "")}`,
            input.tenantId,
            input.botId,
            input.key,
            JSON.stringify(input.value),
            input.encryptedValue ? 1 : 0,
            input.expiresAt ?? null,
            input.now,
            input.now,
          );
      } else {
        this.#db
          .query(`
            UPDATE memory_records SET value_json = ?, encrypted_value = ?, expires_at = ?, updated_at = ?
            WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND memory_key = ?
          `)
          .run(
            JSON.stringify(input.value),
            input.encryptedValue ? 1 : 0,
            input.expiresAt ?? null,
            input.now,
            input.tenantId,
            input.botId,
            input.key,
          );
      }
      const row = this.#db
        .query<MemoryRow, [string, string, string]>(`
          SELECT id, bot_id, memory_key, value_json, encrypted_value, expires_at, created_at, updated_at
          FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND memory_key = ?
        `)
        .get(input.tenantId, input.botId, input.key);
      if (!row) throw new AppError("INTERNAL_ERROR", "Saved memory could not be loaded.", 500);
      return mapBotMemory(row);
    });
    return save.immediate();
  }

  async deleteOwnedBotMemory(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    key: string;
  }): Promise<boolean> {
    const bot = this.#db
      .query<{ id: string }, [string, string, string]>(
        "SELECT id FROM bots WHERE tenant_id = ? AND owner_id = ? AND id = ?",
      )
      .get(input.tenantId, input.ownerId, input.botId);
    if (!bot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    const result = this.#db
      .query("DELETE FROM memory_records WHERE tenant_id = ? AND bot_id = ? AND actor_id IS NULL AND memory_key = ?")
      .run(input.tenantId, input.botId, input.key);
    return result.changes > 0;
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
    readonly platform?: "api" | "web_chat";
  }): Promise<ConversationId> {
    const key = input.conversationKey.trim();
    const platform = input.platform ?? "api";
    if (!key || key.length > 512) {
      throw new AppError("VALIDATION_ERROR", "API conversation key is invalid.", 400);
    }
    const createOrLoad = this.#db.transaction((): ConversationId => {
      const existing = this.#db
        .query<{ id: string }, [string, string, string, string, string]>(`
          SELECT id FROM conversations
          WHERE tenant_id = ? AND bot_id = ? AND platform = ? AND platform_conversation_id = ? AND actor_id = ?
        `)
        .get(input.tenantId, input.botId, platform, key, input.actorId);
      if (existing) return existing.id as ConversationId;
      const id = `conversation_${crypto.randomUUID()}` as ConversationId;
      const now = new Date().toISOString();
      this.#db
        .query(`
          INSERT INTO conversations (
            id, tenant_id, bot_id, actor_id, platform, platform_conversation_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(id, input.tenantId, input.botId, input.actorId, platform, key, now, now);
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

  async consumeTelegramUserRequest(
    input: Parameters<TelegramRepository["consumeTelegramUserRequest"]>[0],
  ): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(input.actorHash)) {
      throw new AppError("VALIDATION_ERROR", "Telegram rate-limit actor hash is invalid.", 400);
    }
    const timestamp = Date.parse(input.now);
    if (!Number.isFinite(timestamp)) throw new AppError("VALIDATION_ERROR", "Telegram request time is invalid.", 400);
    if (!Number.isSafeInteger(input.limitPerMinute) || input.limitPerMinute < 1 || input.limitPerMinute > 1000) {
      throw new AppError("VALIDATION_ERROR", "Telegram request limit is invalid.", 400);
    }
    const minuteWindow = Math.floor(timestamp / 60_000);
    const consume = this.#db.transaction(() => {
      this.#db
        .query("DELETE FROM telegram_customer_request_usage WHERE deployment_id = ? AND minute_window < ?")
        .run(input.deploymentId, minuteWindow - 1);
      const result = this.#db
        .query(`
          INSERT INTO telegram_customer_request_usage (deployment_id, actor_hash, minute_window, request_count, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(deployment_id, actor_hash) DO UPDATE SET
            minute_window = excluded.minute_window,
            request_count = CASE WHEN telegram_customer_request_usage.minute_window = excluded.minute_window
              THEN telegram_customer_request_usage.request_count + 1 ELSE 1 END,
            updated_at = excluded.updated_at
          WHERE telegram_customer_request_usage.minute_window != excluded.minute_window
            OR telegram_customer_request_usage.request_count < ?
        `)
        .run(input.deploymentId, input.actorHash, minuteWindow, input.now, input.limitPerMinute);
      return result.changes === 1;
    });
    return consume.immediate();
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
          SELECT state, response_text, response_attachments_json, lease_until
          FROM telegram_updates WHERE deployment_id = ? AND update_id = ?
        `)
        .get(input.deploymentId, input.updateId);
      if (row?.state === "completed") {
        const attachmentRefs = parseTelegramAttachmentRefs(row.response_attachments_json);
        return {
          state: "completed" as const,
          ...(attachmentRefs.length ? { attachmentRefs } : {}),
        };
      }
      if (row && row.lease_until > input.now) return { state: "busy" as const };
      if (row?.state === "ready") {
        this.#db
          .query(
            "UPDATE telegram_updates SET lease_until = ?, updated_at = ? WHERE deployment_id = ? AND update_id = ?",
          )
          .run(input.leaseUntil, input.now, input.deploymentId, input.updateId);
        const attachmentRefs = parseTelegramAttachmentRefs(row.response_attachments_json);
        return {
          state: "ready" as const,
          responseText: row.response_text ?? "",
          ...(attachmentRefs.length ? { attachmentRefs } : {}),
        };
      }
      if (row) {
        this.#db
          .query(`
            UPDATE telegram_updates SET state = 'processing', response_text = NULL,
              response_attachments_json = '[]', lease_until = ?, updated_at = ?
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
    attachmentRefs?: readonly { readonly kind: "image"; readonly secretRef: string }[];
    leaseUntil: string;
    now: string;
  }): Promise<void> {
    if (input.responseText.length > 100_000)
      throw new AppError("VALIDATION_ERROR", "Telegram response is too large.", 400);
    const attachmentRefs = validateTelegramAttachmentRefs(input.attachmentRefs ?? []);
    const result = this.#db
      .query(`
        UPDATE telegram_updates SET state = 'ready', response_text = ?, response_attachments_json = ?,
          lease_until = ?, updated_at = ?
        WHERE deployment_id = ? AND update_id = ? AND state = 'processing' AND lease_until = ?
      `)
      .run(
        input.responseText,
        JSON.stringify(attachmentRefs),
        input.leaseUntil,
        input.now,
        input.deploymentId,
        input.updateId,
        input.leaseUntil,
      );
    if (result.changes !== 1) throw new AppError("CONFLICT", "Telegram update lease was lost.", 409);
  }

  async completeTelegramUpdate(input: {
    deploymentId: TelegramDeploymentId;
    updateId: number;
    leaseUntil: string;
    now: string;
  }): Promise<void> {
    const result = this.#db
      .query(`
        UPDATE telegram_updates SET state = 'completed', response_text = NULL, updated_at = ?
        WHERE deployment_id = ? AND update_id = ? AND state = 'ready' AND lease_until = ?
      `)
      .run(input.now, input.deploymentId, input.updateId, input.leaseUntil);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Telegram update could not be completed.", 409);
  }

  async clearTelegramUpdateAttachments(input: { deploymentId: TelegramDeploymentId; updateId: number }): Promise<void> {
    this.#db
      .query(`
        UPDATE telegram_updates SET response_attachments_json = '[]'
        WHERE deployment_id = ? AND update_id = ? AND state = 'completed'
      `)
      .run(input.deploymentId, input.updateId);
  }

  async releaseTelegramUpdate(input: {
    deploymentId: TelegramDeploymentId;
    updateId: number;
    leaseUntil: string;
    now: string;
  }): Promise<void> {
    this.#db
      .query(
        "UPDATE telegram_updates SET lease_until = ?, updated_at = ? WHERE deployment_id = ? AND update_id = ? AND state != 'completed' AND lease_until = ?",
      )
      .run(input.now, input.now, input.deploymentId, input.updateId, input.leaseUntil);
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

  async retryFailedScheduledTask(input: {
    tenantId: TenantId;
    ownerId: UserId;
    taskId: ScheduledTaskId;
    now: string;
  }): Promise<JobId | undefined> {
    const retry = this.#db.transaction(() => {
      const job = this.#db
        .query<{ id: string }, [string, string, string, string]>(`
          SELECT jobs.id FROM jobs
          JOIN scheduled_tasks
            ON scheduled_tasks.tenant_id = jobs.tenant_id
            AND json_extract(jobs.payload_json, '$.taskId') = scheduled_tasks.id
          WHERE jobs.tenant_id = ? AND jobs.kind = 'scheduled_task' AND jobs.status = 'failed'
            AND scheduled_tasks.tenant_id = ? AND scheduled_tasks.owner_id = ?
            AND scheduled_tasks.id = ? AND scheduled_tasks.status = 'failed'
          ORDER BY jobs.updated_at DESC, jobs.id DESC LIMIT 1
        `)
        .get(input.tenantId, input.tenantId, input.ownerId, input.taskId);
      if (!job) return undefined;
      const task = this.#db
        .query(`
          UPDATE scheduled_tasks SET status = 'active', next_run_at = ?, updated_at = ?
          WHERE tenant_id = ? AND owner_id = ? AND id = ? AND status = 'failed'
        `)
        .run(input.now, input.now, input.tenantId, input.ownerId, input.taskId);
      if (task.changes !== 1) throw new AppError("CONFLICT", "Scheduled task changed before it could be retried.", 409);
      const updated = this.#db
        .query(`
          UPDATE jobs SET status = 'queued', attempts = 0, available_at = ?, lease_until = NULL, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND kind = 'scheduled_task' AND status = 'failed'
        `)
        .run(input.now, input.now, job.id, input.tenantId);
      if (updated.changes !== 1) throw new AppError("CONFLICT", "Failed scheduled run changed before retry.", 409);
      return job.id as JobId;
    });
    return retry.immediate();
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

  async listSecrets(
    after: { readonly tenantId: TenantId; readonly reference: string } | undefined,
    limit: number,
  ): Promise<readonly EncryptedSecretRecord[]> {
    const rows = after
      ? this.#db
          .query<SecretRow, [string, string, string, number]>(`
            SELECT tenant_id, reference, key_id, nonce, ciphertext, envelope_version, created_at
            FROM encrypted_secrets
            WHERE tenant_id > ? OR (tenant_id = ? AND reference > ?)
            ORDER BY tenant_id, reference
            LIMIT ?
          `)
          .all(after.tenantId, after.tenantId, after.reference, limit)
      : this.#db
          .query<SecretRow, [number]>(`
            SELECT tenant_id, reference, key_id, nonce, ciphertext, envelope_version, created_at
            FROM encrypted_secrets ORDER BY tenant_id, reference LIMIT ?
          `)
          .all(limit);
    return rows.map(mapSecretRow);
  }

  async replaceSecretIfUnchanged(
    record: EncryptedSecretRecord,
    expected: { readonly keyId: string; readonly nonce: string; readonly ciphertext: string },
  ): Promise<boolean> {
    const result = this.#db
      .query(`
        UPDATE encrypted_secrets
        SET key_id = ?, nonce = ?, ciphertext = ?, envelope_version = ?, created_at = ?
        WHERE tenant_id = ? AND reference = ? AND key_id = ? AND nonce = ? AND ciphertext = ?
      `)
      .run(
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
      );
    return result.changes === 1;
  }

  async deleteSecret(tenantId: TenantId, reference: string): Promise<void> {
    this.#db.query("DELETE FROM encrypted_secrets WHERE tenant_id = ? AND reference = ?").run(tenantId, reference);
  }

  async findActiveApiToken(tokenHash: string, now: string): Promise<ApiTokenPrincipal | undefined> {
    const row = this.#db
      .query<ApiTokenRow, [string, string]>(`
        SELECT t.id, t.tenant_id, t.owner_id, t.scopes_json, t.expires_at, m.role
        FROM api_tokens AS t
        JOIN tenant_memberships AS m
          ON m.tenant_id = t.tenant_id AND m.user_id = t.owner_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND m.status = 'active'
          AND (t.expires_at IS NULL OR t.expires_at > ?)
      `)
      .get(tokenHash, now);
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
    const rows = this.#db
      .query<{ tenant_id: string; name: string; role: TenantRole; created_at: string }, [string]>(`
        SELECT t.id AS tenant_id, t.name, m.role, m.created_at
        FROM tenant_memberships AS m
        JOIN tenants AS t ON t.id = m.tenant_id
        WHERE m.user_id = ? AND m.status = 'active'
        ORDER BY m.created_at ASC, t.id ASC
      `)
      .all(userId);
    return rows.map((row) => ({
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
    return this.#db
      .query<{ role: TenantRole }, [string, string]>(`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND status = 'active'
      `)
      .get(input.tenantId, input.userId)?.role;
  }

  async listTenantMembers(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
  }): Promise<readonly TenantMember[]> {
    const actor = this.#db
      .query<{ role: TenantRole }, [string, string]>(`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND status = 'active'
      `)
      .get(input.tenantId, input.actorId);
    if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
      throw new AppError("FORBIDDEN", "Tenant owner or admin role is required to list members.", 403);
    }
    const rows = this.#db
      .query<TenantMemberRow, [string]>(`
        SELECT m.user_id, m.role, m.status, m.created_at,
               (SELECT COUNT(*) FROM bots AS b
                WHERE b.tenant_id = m.tenant_id AND b.owner_id = m.user_id) AS owned_bot_count
        FROM tenant_memberships AS m
        WHERE m.tenant_id = ?
        ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.role, m.created_at, m.user_id
      `)
      .all(input.tenantId);
    return rows.map(mapTenantMember);
  }

  async addTenantMember(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly memberId: UserId;
    readonly role: Exclude<TenantRole, "owner">;
    readonly now: string;
  }): Promise<TenantMember> {
    const add = this.#db.transaction(() => {
      this.#assertTenantOwner(input.tenantId, input.actorId);
      const user = this.#db.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get(input.memberId);
      if (!user) throw new AppError("NOT_FOUND", "User account was not found.", 404);
      const existing = this.#db
        .query<{ role: TenantRole; status: "active" | "inactive"; created_at: string }, [string, string]>(`
          SELECT role, status, created_at FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?
        `)
        .get(input.tenantId, input.memberId);
      let action: string;
      let previousRole: TenantRole | undefined;
      if (existing?.status === "active")
        throw new AppError("CONFLICT", "User is already an active tenant member.", 409);
      if (existing) {
        previousRole = existing.role;
        action = "tenant.member.reactivated";
        this.#db
          .query("UPDATE tenant_memberships SET role = ?, status = 'active' WHERE tenant_id = ? AND user_id = ?")
          .run(input.role, input.tenantId, input.memberId);
      } else {
        action = "tenant.member.added";
        this.#db
          .query(`
            INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at, status)
            VALUES (?, ?, ?, ?, 'active')
          `)
          .run(input.tenantId, input.memberId, input.role, input.now);
      }
      this.#recordTenantMembershipEvent(input, action, {
        role: input.role,
        ...(previousRole === undefined ? {} : { previousRole }),
      });
      return this.#getTenantMember(input.tenantId, input.memberId);
    });
    return add.immediate();
  }

  async changeTenantMemberRole(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly memberId: UserId;
    readonly role: TenantRole;
    readonly now: string;
  }): Promise<TenantMember> {
    const change = this.#db.transaction(() => {
      this.#assertTenantOwner(input.tenantId, input.actorId);
      const member = this.#db
        .query<{ role: TenantRole; status: "active" | "inactive" }, [string, string]>(`
          SELECT role, status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?
        `)
        .get(input.tenantId, input.memberId);
      if (member?.status !== "active") throw new AppError("NOT_FOUND", "Active tenant member was not found.", 404);
      if (member.role === input.role) return this.#getTenantMember(input.tenantId, input.memberId);
      if (member.role === "owner" && input.role !== "owner") this.#assertAnotherTenantOwner(input.tenantId);
      this.#db
        .query("UPDATE tenant_memberships SET role = ? WHERE tenant_id = ? AND user_id = ? AND status = 'active'")
        .run(input.role, input.tenantId, input.memberId);
      this.#recordTenantMembershipEvent(input, "tenant.member.role_changed", {
        previousRole: member.role,
        role: input.role,
      });
      return this.#getTenantMember(input.tenantId, input.memberId);
    });
    return change.immediate();
  }

  async deactivateTenantMember(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly memberId: UserId;
    readonly now: string;
  }): Promise<TenantMember> {
    const deactivate = this.#db.transaction(() => {
      this.#assertTenantOwner(input.tenantId, input.actorId);
      const member = this.#db
        .query<{ role: TenantRole; status: "active" | "inactive" }, [string, string]>(`
          SELECT role, status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?
        `)
        .get(input.tenantId, input.memberId);
      if (member?.status !== "active") throw new AppError("NOT_FOUND", "Active tenant member was not found.", 404);
      if (member.role === "owner") this.#assertAnotherTenantOwner(input.tenantId);
      this.#db
        .query(
          "UPDATE tenant_memberships SET status = 'inactive' WHERE tenant_id = ? AND user_id = ? AND status = 'active'",
        )
        .run(input.tenantId, input.memberId);
      const revokedTokens = this.#db
        .query("UPDATE api_tokens SET revoked_at = ? WHERE tenant_id = ? AND owner_id = ? AND revoked_at IS NULL")
        .run(input.now, input.tenantId, input.memberId).changes;
      this.#recordTenantMembershipEvent(input, "tenant.member.deactivated", {
        role: member.role,
        revokedTokens,
      });
      return this.#getTenantMember(input.tenantId, input.memberId);
    });
    return deactivate.immediate();
  }

  async listTenantInvitations(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly now: string;
  }): Promise<readonly TenantInvitation[]> {
    const actor = this.#db
      .query<{ role: TenantRole }, [string, string]>(`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND status = 'active'
      `)
      .get(input.tenantId, input.actorId);
    if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
      throw new AppError("FORBIDDEN", "Tenant owner or admin role is required to list invitations.", 403);
    }
    const rows = this.#db
      .query<TenantInvitationRow, [string]>(`
        SELECT id, role, status, created_by, created_at, expires_at, accepted_by, accepted_at
        FROM tenant_invitations
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `)
      .all(input.tenantId);
    return rows.map((row) => mapTenantInvitation(row, input.now));
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
    const create = this.#db.transaction(() => {
      this.#assertTenantOwner(input.tenantId, input.actorId);
      this.#db
        .query(`
          INSERT INTO tenant_invitations
            (id, tenant_id, token_hash, role, status, created_by, created_at, expires_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
        `)
        .run(
          input.invitationId,
          input.tenantId,
          input.tokenHash,
          input.role,
          input.actorId,
          input.createdAt,
          input.expiresAt,
        );
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'tenant.invitation.created', 'tenant_invitation', ?, ?, ?)
        `)
        .run(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.actorId,
          input.invitationId,
          JSON.stringify({ role: input.role, expiresAt: input.expiresAt }),
          input.createdAt,
        );
      return this.#getTenantInvitation(input.tenantId, input.invitationId, input.createdAt);
    });
    return create.immediate();
  }

  async revokeTenantInvitation(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly invitationId: string;
    readonly now: string;
  }): Promise<TenantInvitation> {
    const revoke = this.#db.transaction(() => {
      this.#assertTenantOwner(input.tenantId, input.actorId);
      const row = this.#db
        .query<TenantInvitationRow, [string, string]>(`
          SELECT id, role, status, created_by, created_at, expires_at, accepted_by, accepted_at
          FROM tenant_invitations WHERE tenant_id = ? AND id = ?
        `)
        .get(input.tenantId, input.invitationId);
      if (!row) throw new AppError("NOT_FOUND", "Pending invitation was not found.", 404);
      if (row.status !== "pending") throw new AppError("CONFLICT", "Only pending invitations can be revoked.", 409);
      this.#db
        .query("UPDATE tenant_invitations SET status = 'revoked' WHERE tenant_id = ? AND id = ? AND status = 'pending'")
        .run(input.tenantId, input.invitationId);
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'tenant.invitation.revoked', 'tenant_invitation', ?, ?, ?)
        `)
        .run(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.actorId,
          input.invitationId,
          JSON.stringify({ role: row.role }),
          input.now,
        );
      return this.#getTenantInvitation(input.tenantId, input.invitationId, input.now);
    });
    return revoke.immediate();
  }

  async acceptTenantInvitation(input: {
    readonly tokenHash: string;
    readonly userId: UserId;
    readonly now: string;
  }): Promise<{ readonly tenantId: TenantId; readonly role: Exclude<TenantRole, "owner"> }> {
    const accept = this.#db.transaction(() => {
      const invitation = this.#db
        .query<TenantInvitationRow & { tenant_id: string }, [string]>(`
          SELECT id, tenant_id, role, status, created_by, created_at, expires_at, accepted_by, accepted_at
          FROM tenant_invitations WHERE token_hash = ?
        `)
        .get(input.tokenHash);
      if (invitation?.status !== "pending" || invitation.expires_at <= input.now) {
        throw new AppError("NOT_FOUND", "Invitation is invalid, expired, or already used.", 404);
      }
      const membership = this.#db
        .query<{ status: "active" | "inactive" }, [string, string]>(`
          SELECT status FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?
        `)
        .get(invitation.tenant_id, input.userId);
      if (membership?.status === "active") {
        throw new AppError("CONFLICT", "This account already belongs to the invited workspace.", 409);
      }
      if (membership) {
        this.#db
          .query(
            "UPDATE tenant_memberships SET role = ?, status = 'active' WHERE tenant_id = ? AND user_id = ? AND status = 'inactive'",
          )
          .run(invitation.role, invitation.tenant_id, input.userId);
      } else {
        this.#db
          .query(`
            INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at, status)
            VALUES (?, ?, ?, ?, 'active')
          `)
          .run(invitation.tenant_id, input.userId, invitation.role, input.now);
      }
      const accepted = this.#db
        .query(`
          UPDATE tenant_invitations SET status = 'accepted', accepted_by = ?, accepted_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?
        `)
        .run(input.userId, input.now, invitation.id, input.now);
      if (accepted.changes !== 1)
        throw new AppError("CONFLICT", "Invitation changed before it could be accepted.", 409);
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'tenant.invitation.accepted', 'tenant_invitation', ?, ?, ?)
        `)
        .run(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          invitation.tenant_id,
          input.userId,
          invitation.id,
          JSON.stringify({ role: invitation.role }),
          input.now,
        );
      return { tenantId: invitation.tenant_id as TenantId, role: invitation.role };
    });
    return accept.immediate();
  }

  #assertTenantOwner(tenantId: TenantId, actorId: UserId): void {
    const row = this.#db
      .query<{ role: TenantRole }, [string, string]>(`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND status = 'active'
      `)
      .get(tenantId, actorId);
    if (row?.role !== "owner") throw new AppError("FORBIDDEN", "Only a tenant owner can change membership.", 403);
  }

  #assertAnotherTenantOwner(tenantId: TenantId): void {
    const row = this.#db
      .query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM tenant_memberships
        WHERE tenant_id = ? AND status = 'active' AND role = 'owner'
      `)
      .get(tenantId);
    if ((row?.count ?? 0) <= 1) throw new AppError("CONFLICT", "A tenant must retain at least one active owner.", 409);
  }

  #getTenantMember(tenantId: TenantId, memberId: UserId): TenantMember {
    const row = this.#db
      .query<TenantMemberRow, [string, string]>(`
        SELECT m.user_id, m.role, m.status, m.created_at,
               (SELECT COUNT(*) FROM bots AS b
                WHERE b.tenant_id = m.tenant_id AND b.owner_id = m.user_id) AS owned_bot_count
        FROM tenant_memberships AS m WHERE m.tenant_id = ? AND m.user_id = ?
      `)
      .get(tenantId, memberId);
    if (!row) throw new AppError("INTERNAL_ERROR", "Tenant member could not be loaded after an update.", 500);
    return mapTenantMember(row);
  }

  #getTenantInvitation(tenantId: TenantId, invitationId: string, now: string): TenantInvitation {
    const row = this.#db
      .query<TenantInvitationRow, [string, string]>(`
        SELECT id, role, status, created_by, created_at, expires_at, accepted_by, accepted_at
        FROM tenant_invitations WHERE tenant_id = ? AND id = ?
      `)
      .get(tenantId, invitationId);
    if (!row) throw new AppError("INTERNAL_ERROR", "Tenant invitation could not be loaded after an update.", 500);
    return mapTenantInvitation(row, now);
  }

  #recordTenantMembershipEvent(
    input: { readonly tenantId: TenantId; readonly actorId: UserId; readonly memberId: UserId; readonly now: string },
    action: string,
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    this.#db
      .query(`
        INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, 'tenant_member', ?, ?, ?)
      `)
      .run(
        `audit_${crypto.randomUUID().replaceAll("-", "")}`,
        input.tenantId,
        input.actorId,
        action,
        input.memberId,
        JSON.stringify(metadata),
        input.now,
      );
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
    const result = this.#db
      .query(`
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
      .run(input.tenantId, input.ownerId, minuteWindow, input.now, input.limitPerMinute);
    return result.changes === 1;
  }

  async consumeNetworkRequest(input: { clientHash: string; now: string; limitPerMinute: number }): Promise<boolean> {
    const timestamp = Date.parse(input.now);
    if (!/^[a-f0-9]{64}$/.test(input.clientHash) || !Number.isFinite(timestamp)) {
      throw new AppError("VALIDATION_ERROR", "Network rate limit identity or time is invalid.", 400);
    }
    if (!Number.isSafeInteger(input.limitPerMinute) || input.limitPerMinute < 10 || input.limitPerMinute > 10_000) {
      throw new AppError("VALIDATION_ERROR", "Network request limit is invalid.", 400);
    }
    const minuteWindow = Math.floor(timestamp / 60_000);
    const result = this.#db
      .query<{ request_count: number }, [string, number, string, number]>(`
        INSERT INTO network_request_usage (client_hash, minute_window, request_count, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(client_hash) DO UPDATE SET
          minute_window = excluded.minute_window,
          request_count = CASE WHEN network_request_usage.minute_window = excluded.minute_window
            THEN network_request_usage.request_count + 1 ELSE 1 END,
          updated_at = excluded.updated_at
        WHERE network_request_usage.minute_window != excluded.minute_window
          OR network_request_usage.request_count < ?
        RETURNING request_count
      `)
      .get(input.clientHash, minuteWindow, input.now, input.limitPerMinute);
    if (result?.request_count === 1 && minuteWindow % 10 === 0 && input.clientHash.startsWith("00")) {
      this.#db.query("DELETE FROM network_request_usage WHERE minute_window < ?").run(minuteWindow - 2);
    }
    return result !== null;
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
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, 'api.mutation_attempt', 'http_api', ?, ?, ?)
        `)
        .run(id, input.tenantId, input.ownerId, `${method} ${pathname}`.slice(0, 512), metadata, input.createdAt);
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
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, ?, 'http_api', ?, ?, ?)
        `)
        .run(
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
        );
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
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, b.tenant_id, 'authorization.permission_decision', 'bot', b.id, ?, ?
          FROM bots AS b WHERE b.tenant_id = ? AND b.id = ?
        `)
        .run(
          id,
          JSON.stringify({ category: input.category, permission, outcome: input.outcome }),
          input.createdAt,
          input.tenantId,
          input.botId,
        );
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
    const rows = this.#db
      .query<AuditLogRow, [string, string, string, string, number]>(`
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
      .all(input.tenantId, input.ownerId, input.ownerId, input.ownerId, input.limit);
    return rows.map(mapAuditLog);
  }

  async claimTelegramInitData(input: { dataHash: string; expiresAt: string; now: string }): Promise<boolean> {
    const claim = this.#db.transaction(() => {
      this.#db.query("DELETE FROM telegram_auth_nonces WHERE expires_at <= ?").run(input.now);
      const result = this.#db
        .query(`
          INSERT INTO telegram_auth_nonces (data_hash, expires_at, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT (data_hash) DO NOTHING
        `)
        .run(input.dataHash, input.expiresAt, input.now);
      return result.changes === 1;
    });
    return claim.immediate();
  }

  async getOrCreateTelegramOwner(input: {
    telegramUserId: number;
    ownerId: UserId;
    tenantId: TenantId;
    workspaceName: string;
    now: string;
  }): Promise<{ ownerId: UserId; tenantId: TenantId }> {
    const createOrFind = this.#db.transaction(() => {
      const existing = this.#db
        .query<{ owner_id: string; tenant_id: string }, [string]>(`
          SELECT m.user_id AS owner_id, m.tenant_id
          FROM users AS u
          JOIN tenant_memberships AS m ON m.user_id = u.id
          WHERE u.auth_issuer = 'telegram-miniapp' AND u.auth_subject = ? AND m.role = 'owner'
          ORDER BY m.created_at ASC
          LIMIT 1
        `)
        .get(String(input.telegramUserId));
      if (existing) return { ownerId: existing.owner_id as UserId, tenantId: existing.tenant_id as TenantId };

      this.#db
        .query(
          `INSERT OR IGNORE INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'telegram-miniapp', ?, ?)`,
        )
        .run(input.ownerId, String(input.telegramUserId), input.now);
      this.#db
        .query("INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)")
        .run(input.tenantId, input.workspaceName, input.now);
      this.#db
        .query(
          "INSERT OR IGNORE INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        )
        .run(input.tenantId, input.ownerId, input.now);

      const account = this.#db
        .query<{ owner_id: string; tenant_id: string }, [string]>(`
          SELECT m.user_id AS owner_id, m.tenant_id
          FROM users AS u
          JOIN tenant_memberships AS m ON m.user_id = u.id
          WHERE u.auth_issuer = 'telegram-miniapp' AND u.auth_subject = ? AND m.role = 'owner'
          ORDER BY m.created_at ASC
          LIMIT 1
        `)
        .get(String(input.telegramUserId));
      if (!account) throw new AppError("CONFLICT", "Telegram workspace could not be created.", 409);
      return { ownerId: account.owner_id as UserId, tenantId: account.tenant_id as TenantId };
    });
    return createOrFind.immediate();
  }

  async getMasterBotSession(telegramUserId: number): Promise<MasterBotSession | undefined> {
    validateTelegramUserId(telegramUserId);
    const row = this.#db
      .query<MasterBotSessionRow, [number]>(`
        SELECT telegram_user_id, chat_id, tenant_id, owner_id, session_id, updated_at
        FROM master_bot_sessions WHERE telegram_user_id = ?
      `)
      .get(telegramUserId);
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
    validateTelegramUserId(session.telegramUserId);
    this.#db
      .query(`
        INSERT INTO master_bot_sessions (telegram_user_id, chat_id, tenant_id, owner_id, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          chat_id = excluded.chat_id, tenant_id = excluded.tenant_id, owner_id = excluded.owner_id,
          session_id = excluded.session_id, updated_at = excluded.updated_at
      `)
      .run(
        session.telegramUserId,
        session.chatId,
        session.tenantId,
        session.ownerId,
        session.sessionId,
        session.updatedAt,
      );
  }

  async deleteMasterBotSession(telegramUserId: number): Promise<void> {
    validateTelegramUserId(telegramUserId);
    this.#db.query("DELETE FROM master_bot_sessions WHERE telegram_user_id = ?").run(telegramUserId);
  }

  async consumeMasterBotUserRequest(input: Parameters<MasterBotRepository["consumeUserRequest"]>[0]): Promise<boolean> {
    if (!/^usr_[a-f0-9]{32}$/.test(input.actorId)) {
      throw new AppError("VALIDATION_ERROR", "Master bot rate-limit actor must be pseudonymous.", 400);
    }
    const timestamp = Date.parse(input.now);
    if (!Number.isFinite(timestamp)) throw new AppError("VALIDATION_ERROR", "Master bot request time is invalid.", 400);
    if (!Number.isSafeInteger(input.limitPerMinute) || input.limitPerMinute < 1 || input.limitPerMinute > 1000) {
      throw new AppError("VALIDATION_ERROR", "Master bot request limit is invalid.", 400);
    }
    const minuteWindow = Math.floor(timestamp / 60_000);
    const result = this.#db
      .query(`
        INSERT INTO telegram_master_request_usage (actor_id, minute_window, request_count, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(actor_id) DO UPDATE SET
          minute_window = excluded.minute_window,
          request_count = CASE WHEN telegram_master_request_usage.minute_window = excluded.minute_window
            THEN telegram_master_request_usage.request_count + 1 ELSE 1 END,
          updated_at = excluded.updated_at
        WHERE telegram_master_request_usage.minute_window != excluded.minute_window
          OR telegram_master_request_usage.request_count < ?
      `)
      .run(input.actorId, minuteWindow, input.now, input.limitPerMinute);
    return result.changes === 1;
  }

  async reserveMasterBotUpdate(input: {
    updateId: number;
    leaseUntil: string;
    now: string;
  }): Promise<MasterBotUpdateReservation> {
    validateMasterUpdateId(input.updateId);
    const reserve = this.#db.transaction(() => {
      this.#db
        .query("DELETE FROM master_bot_updates WHERE created_at < ?")
        .run(new Date(Date.parse(input.now) - 30 * 24 * 60 * 60 * 1000).toISOString());
      const row = this.#db
        .query<MasterBotUpdateRow, [number]>(`
          SELECT state, response_json, lease_until FROM master_bot_updates WHERE update_id = ?
        `)
        .get(input.updateId);
      if (row?.state === "completed") return { state: "completed" as const };
      if (row && row.lease_until > input.now) return { state: "busy" as const };
      if (row?.state === "ready") {
        this.#db
          .query("UPDATE master_bot_updates SET lease_until = ?, updated_at = ? WHERE update_id = ?")
          .run(input.leaseUntil, input.now, input.updateId);
        return { state: "ready" as const, reply: parseMasterBotReply(row.response_json) };
      }
      if (row) {
        this.#db
          .query(`
            UPDATE master_bot_updates SET state = 'processing', response_json = NULL, lease_until = ?, updated_at = ?
            WHERE update_id = ?
          `)
          .run(input.leaseUntil, input.now, input.updateId);
      } else {
        this.#db
          .query(`
            INSERT INTO master_bot_updates (update_id, state, response_json, lease_until, created_at, updated_at)
            VALUES (?, 'processing', NULL, ?, ?, ?)
          `)
          .run(input.updateId, input.leaseUntil, input.now, input.now);
      }
      return { state: "acquired" as const };
    });
    return reserve.immediate();
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
    const result = this.#db
      .query(`
        UPDATE master_bot_updates SET state = 'ready', response_json = ?, lease_until = ?, updated_at = ?
        WHERE update_id = ? AND state = 'processing' AND lease_until = ?
      `)
      .run(serialized, input.leaseUntil, input.now, input.updateId, input.leaseUntil);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Master bot update lease was lost.", 409);
  }

  async completeMasterBotUpdate(input: { updateId: number; leaseUntil: string; now: string }): Promise<void> {
    const result = this.#db
      .query(`
        UPDATE master_bot_updates SET state = 'completed', response_json = NULL, updated_at = ?
        WHERE update_id = ? AND state = 'ready' AND lease_until = ?
      `)
      .run(input.now, input.updateId, input.leaseUntil);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Master bot update could not be completed.", 409);
  }

  async releaseMasterBotUpdate(input: { updateId: number; leaseUntil: string; now: string }): Promise<void> {
    this.#db
      .query(
        "UPDATE master_bot_updates SET lease_until = ?, updated_at = ? WHERE update_id = ? AND state != 'completed' AND lease_until = ?",
      )
      .run(input.now, input.now, input.updateId, input.leaseUntil);
  }

  async createCreationApproval(record: CreationApprovalRecord): Promise<void> {
    try {
      const create = this.#db.transaction(() => {
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
        this.#db
          .query(`
            INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
            VALUES (?, ?, ?, 'creation.approval_issued', 'factory_session', ?, ?, ?)
          `)
          .run(
            `audit_${crypto.randomUUID().replaceAll("-", "")}`,
            record.tenantId,
            record.ownerId,
            record.sessionId,
            JSON.stringify({ approvalAction: record.action, expiresAt: record.expiresAt }),
            record.createdAt,
          );
      });
      create();
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
    const consume = this.#db.transaction(() => {
      const result = this.#db
        .query(`
        UPDATE creation_approvals SET consumed_at = ?
        WHERE approval_hash = ? AND tenant_id = ? AND owner_id = ? AND session_id = ? AND action = ?
          AND consumed_at IS NULL AND expires_at > ?
      `)
        .run(input.now, input.approvalHash, input.tenantId, input.ownerId, input.sessionId, input.action, input.now);
      const consumed = result.changes === 1;
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          SELECT ?, COALESCE((SELECT tenant_id FROM creation_approvals WHERE approval_hash = ?), ?), ?, ?,
            'factory_session', ?, ?, ?
        `)
        .run(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.approvalHash,
          input.tenantId,
          input.ownerId,
          consumed ? "creation.approval_consumed" : "creation.approval_rejected",
          input.sessionId,
          JSON.stringify({ approvalAction: input.action }),
          input.now,
        );
      return consumed;
    });
    try {
      return consume();
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
      const create = this.#db.transaction(() => {
        this.#db
          .query(`
            INSERT INTO bot_credential_approvals (
              approval_hash, tenant_id, owner_id, bot_id, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(input.approvalHash, input.tenantId, input.ownerId, input.botId, input.createdAt, input.expiresAt);
        this.#db
          .query(`
            INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
            VALUES (?, ?, ?, 'bot.credential_approval_issued', 'bot', ?, ?, ?)
          `)
          .run(
            `audit_${crypto.randomUUID().replaceAll("-", "")}`,
            input.tenantId,
            input.ownerId,
            input.botId,
            JSON.stringify({ expiresAt: input.expiresAt }),
            input.createdAt,
          );
      });
      create();
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
    const consume = this.#db.transaction(() => {
      const result = this.#db
        .query(`
          UPDATE bot_credential_approvals SET consumed_at = ?
          WHERE approval_hash = ? AND tenant_id = ? AND owner_id = ? AND bot_id = ?
            AND consumed_at IS NULL AND expires_at > ?
        `)
        .run(input.now, input.approvalHash, input.tenantId, input.ownerId, input.botId, input.now);
      const consumed = result.changes === 1;
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, ?, 'bot', ?, '{}', ?)
        `)
        .run(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.ownerId,
          consumed ? "bot.credential_approval_consumed" : "bot.credential_approval_rejected",
          input.botId,
          input.now,
        );
      return consumed;
    });
    try {
      return consume();
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Credential update approval attempt could not be audited.", 503, {
        cause,
      });
    }
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

  async listGlobalSkillCatalog(): Promise<readonly SkillDefinition[]> {
    const rows = this.#db
      .query<SkillRow, []>(`
        SELECT id, tenant_id, name, version, author, category, description, execution_type,
               input_schema_json, output_schema_json, permissions_json, definition_json, enabled
        FROM skills WHERE tenant_id IS NULL
        ORDER BY category, name, version
      `)
      .all();
    return rows.map(mapSkillDefinition);
  }

  async listMcpServers(tenantId: TenantId, botId: BotId): Promise<readonly McpServerConnection[]> {
    const rows = this.#db
      .query<McpServerRow, [string, string]>(`
        SELECT id, tenant_id, bot_id, name, endpoint, credential_ref, status,
               reconnect_attempts, reconnect_after, created_at, updated_at
        FROM mcp_servers WHERE tenant_id = ? AND bot_id = ? ORDER BY created_at, id
      `)
      .all(tenantId, botId);
    return rows.map(mapMcpServer);
  }

  async getMcpServer(tenantId: TenantId, botId: BotId, serverId: string): Promise<McpServerConnection | undefined> {
    const row = this.#db
      .query<McpServerRow, [string, string, string]>(`
        SELECT id, tenant_id, bot_id, name, endpoint, credential_ref, status,
               reconnect_attempts, reconnect_after, created_at, updated_at
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
    const now = new Date().toISOString();
    const result =
      input.status === "unhealthy"
        ? this.#db
            .query(`
              UPDATE mcp_servers SET status = ?, reconnect_attempts = 0, reconnect_after = ?,
                reconnect_lease_until = NULL, reconnect_lease_token = NULL, updated_at = ?
              WHERE tenant_id = ? AND bot_id = ? AND id = ?
            `)
            .run(input.status, input.reconnectAfter ?? null, now, input.tenantId, input.botId, input.serverId)
        : this.#db
            .query(`
              UPDATE mcp_servers SET status = ?, reconnect_attempts = 0, reconnect_after = NULL,
                reconnect_lease_until = NULL, reconnect_lease_token = NULL, updated_at = ?
              WHERE tenant_id = ? AND bot_id = ? AND id = ?
            `)
            .run(input.status, now, input.tenantId, input.botId, input.serverId);
    if (result.changes !== 1) throw new AppError("NOT_FOUND", "MCP server was not found for this bot.", 404);
  }

  async claimMcpServerReconnect(
    input: Parameters<McpRepository["claimServerReconnect"]>[0],
  ): Promise<number | undefined> {
    const row = this.#db
      .query<{ reconnect_attempts: number }, [string, string, string, string, string, string, number, string, string]>(`
        UPDATE mcp_servers
        SET reconnect_attempts = reconnect_attempts + 1, reconnect_lease_until = ?,
            reconnect_lease_token = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND id = ? AND status = 'unhealthy'
          AND reconnect_attempts < ?
          AND (reconnect_after IS NULL OR reconnect_after <= ?)
          AND (reconnect_lease_until IS NULL OR reconnect_lease_until <= ?)
        RETURNING reconnect_attempts
      `)
      .get(
        input.leaseUntil,
        input.leaseToken,
        input.now,
        input.tenantId,
        input.botId,
        input.serverId,
        input.maxAttempts,
        input.now,
        input.now,
      );
    return row?.reconnect_attempts;
  }

  async failMcpServerReconnect(input: Parameters<McpRepository["failServerReconnect"]>[0]): Promise<boolean> {
    const result = this.#db
      .query(`
        UPDATE mcp_servers SET reconnect_after = ?, reconnect_lease_until = NULL,
          reconnect_lease_token = NULL, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND id = ? AND status = 'unhealthy'
          AND reconnect_attempts = ? AND reconnect_lease_token = ?
      `)
      .run(
        input.retryAfter ?? null,
        input.now,
        input.tenantId,
        input.botId,
        input.serverId,
        input.attempt,
        input.leaseToken,
      );
    return result.changes === 1;
  }

  async setMcpServerCredentialRef(input: Parameters<McpRepository["setServerCredentialRef"]>[0]): Promise<void> {
    const result = this.#db
      .query(`
        UPDATE mcp_servers SET credential_ref = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND id = ? AND credential_ref = ?
      `)
      .run(
        input.credentialRef,
        new Date().toISOString(),
        input.tenantId,
        input.botId,
        input.serverId,
        input.expectedCredentialRef,
      );
    if (result.changes === 1) return;
    const server = await this.getMcpServer(input.tenantId, input.botId, input.serverId);
    if (!server) throw new AppError("NOT_FOUND", "MCP server was not found for this bot.", 404);
    throw new AppError("CONFLICT", "MCP credentials changed during OAuth state persistence.", 409);
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

  async publishCatalogSkill(input: {
    readonly tenantId: TenantId;
    readonly definition: SkillCatalogPublication;
  }): Promise<void> {
    const definition = input.definition;
    try {
      this.#db
        .query(`
          INSERT INTO skills (
            id, tenant_id, name, version, author, category, description, execution_type,
            input_schema_json, output_schema_json, permissions_json, definition_json, enabled, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `)
        .run(
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
        );
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
      this.#db
        .query(`
          INSERT INTO skills (
            id, tenant_id, name, version, author, category, description, execution_type,
            input_schema_json, output_schema_json, permissions_json, definition_json, enabled, created_at
          ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `)
        .run(
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
        );
    } catch (cause) {
      if (cause instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(cause.message)) {
        throw new AppError("CONFLICT", "Skill ID or version is already present in the catalog.", 409, { cause });
      }
      throw cause;
    }
  }

  async setGlobalSkillCatalogEnabled(skillId: string, enabled: boolean): Promise<void> {
    const result = this.#db
      .query("UPDATE skills SET enabled = ? WHERE id = ? AND tenant_id IS NULL")
      .run(Number(enabled), skillId);
    if (result.changes !== 1) throw new AppError("NOT_FOUND", "Global catalog skill was not found.", 404);
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
    const acquire = this.#db.transaction(() => {
      const key: [string, string, string, string] = [input.tenantId, input.botId, input.skillId, input.executionKey];
      let replacedStateRef: string | undefined;
      let row = this.#db
        .query<WorkflowExecutionRow, typeof key>(`
          SELECT tenant_id, bot_id, skill_id, execution_key, state_ref, next_step, version, status,
                 lease_token, lease_until, expires_at, updated_at
          FROM workflow_executions WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
        `)
        .get(...key);
      if (!row) {
        this.#db
          .query(`
            INSERT INTO workflow_executions (
              tenant_id, bot_id, skill_id, execution_key, state_ref, next_step, version, status,
              lease_token, lease_until, expires_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, 1, 'running', ?, ?, ?, ?)
          `)
          .run(
            input.tenantId,
            input.botId,
            input.skillId,
            input.executionKey,
            input.initialStateRef,
            input.leaseToken,
            input.leaseUntil,
            input.expiresAt,
            input.now,
          );
        row = this.#db
          .query<WorkflowExecutionRow, typeof key>(`
            SELECT tenant_id, bot_id, skill_id, execution_key, state_ref, next_step, version, status,
                   lease_token, lease_until, expires_at, updated_at
            FROM workflow_executions WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          `)
          .get(...key);
      } else if (row.expires_at <= input.now) {
        replacedStateRef = row.state_ref;
        this.#db
          .query(`
            UPDATE workflow_executions
            SET state_ref = ?, next_step = 0, version = version + 1, status = 'running', lease_token = ?,
                lease_until = ?, expires_at = ?, updated_at = ?
            WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ? AND expires_at <= ?
          `)
          .run(
            input.initialStateRef,
            input.leaseToken,
            input.leaseUntil,
            input.expiresAt,
            input.now,
            ...key,
            input.now,
          );
        row = this.#db
          .query<WorkflowExecutionRow, typeof key>(`
            SELECT tenant_id, bot_id, skill_id, execution_key, state_ref, next_step, version, status,
                   lease_token, lease_until, expires_at, updated_at
            FROM workflow_executions WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          `)
          .get(...key);
      } else if (row.status === "succeeded") {
        return { state: "completed", execution: mapWorkflowExecution(row) } as const;
      } else if (row.lease_until > input.now) {
        return { state: "busy" } as const;
      } else {
        this.#db
          .query(`
            UPDATE workflow_executions
            SET lease_token = ?, lease_until = ?, expires_at = ?, updated_at = ?, version = version + 1
            WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
              AND status = 'running' AND lease_until <= ?
          `)
          .run(input.leaseToken, input.leaseUntil, input.expiresAt, input.now, ...key, input.now);
        row = this.#db
          .query<WorkflowExecutionRow, typeof key>(`
            SELECT tenant_id, bot_id, skill_id, execution_key, state_ref, next_step, version, status,
                   lease_token, lease_until, expires_at, updated_at
            FROM workflow_executions WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          `)
          .get(...key);
      }
      if (row?.status !== "running" || row.lease_token !== input.leaseToken) {
        throw new AppError("CONFLICT", "Workflow execution could not be acquired.", 409);
      }
      return {
        state: "acquired",
        execution: mapWorkflowExecution(row),
        ...(replacedStateRef === undefined ? {} : { replacedStateRef }),
      } as const;
    });
    return acquire.immediate();
  }

  async acquireToolExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly conversationId?: ConversationId;
    readonly executionKey: string;
    readonly toolName: string;
    readonly inputHash: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseUntil: string;
    readonly expiresAt: string;
  }): Promise<ToolExecutionAcquisition> {
    const acquire = this.#db.transaction(() => {
      const key: [string, string, string] = [input.tenantId, input.botId, input.executionKey];
      const select = () =>
        this.#db
          .query<ToolExecutionRow, typeof key>(`
            SELECT tenant_id, bot_id, conversation_id, execution_key, tool_name, input_hash, status, result_ref,
                   lease_token, lease_until, expires_at, updated_at, recovery_status, ambiguous_at
            FROM tool_executions WHERE tenant_id = ? AND bot_id = ? AND execution_key = ?
          `)
          .get(...key);
      let row = select();
      if (!row) {
        this.#db
          .query(`
            INSERT INTO tool_executions (
              tenant_id, bot_id, conversation_id, execution_key, tool_name, input_hash, status, result_ref,
              lease_token, lease_until, expires_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, ?)
          `)
          .run(
            input.tenantId,
            input.botId,
            input.conversationId ?? null,
            input.executionKey,
            input.toolName,
            input.inputHash,
            input.leaseToken,
            input.leaseUntil,
            input.expiresAt,
            input.now,
          );
        return { state: "acquired", leaseToken: input.leaseToken } as const;
      }
      if (row.tool_name !== input.toolName || row.input_hash !== input.inputHash) {
        throw new AppError("CONFLICT", "Tool execution identity was reused with different input.", 409);
      }
      if (row.expires_at > input.now && row.conversation_id !== (input.conversationId ?? null)) {
        throw new AppError("CONFLICT", "Tool execution identity belongs to a different conversation.", 409);
      }
      if (row.status === "succeeded" && row.expires_at > input.now) {
        if (!row.result_ref) throw new AppError("INTERNAL_ERROR", "Completed tool result is missing.", 500);
        return { state: "completed", resultRef: row.result_ref } as const;
      }

      const replacedResultRef = row.expires_at <= input.now ? (row.result_ref ?? undefined) : undefined;
      if (row.expires_at <= input.now) {
        this.#db
          .query(`
            UPDATE tool_executions
            SET conversation_id = ?, status = 'running', result_ref = NULL, lease_token = ?, lease_until = ?,
                expires_at = ?, updated_at = ?, recovery_status = 'none', ambiguous_at = NULL
            WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND expires_at <= ?
          `)
          .run(
            input.conversationId ?? null,
            input.leaseToken,
            input.leaseUntil,
            input.expiresAt,
            input.now,
            ...key,
            input.now,
          );
      } else if (row.status === "running" && row.lease_until <= input.now) {
        if (row.recovery_status === "closed") return { state: "closed" } as const;
        if (row.recovery_status === "ambiguous") return { state: "ambiguous" } as const;
        if (row.recovery_status === "none") {
          this.#db
            .query(`
              UPDATE tool_executions SET recovery_status = 'ambiguous', ambiguous_at = COALESCE(ambiguous_at, ?),
                lease_until = ?, updated_at = ?
              WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND status = 'running'
                AND recovery_status = 'none' AND lease_until <= ? AND expires_at > ?
            `)
            .run(input.now, input.now, input.now, ...key, input.now, input.now);
          row = select();
          if (row?.recovery_status === "ambiguous") return { state: "ambiguous" } as const;
          if (row?.recovery_status === "closed") return { state: "closed" } as const;
          if (row?.status === "succeeded" && row.result_ref && row.expires_at > input.now) {
            return { state: "completed", resultRef: row.result_ref } as const;
          }
          return { state: "busy" } as const;
        }
        this.#db
          .query(`
            UPDATE tool_executions SET lease_token = ?, lease_until = ?, expires_at = ?, updated_at = ?,
              recovery_status = 'none', ambiguous_at = NULL
            WHERE tenant_id = ? AND bot_id = ? AND execution_key = ?
              AND status = 'running' AND recovery_status = 'retry_approved' AND lease_until <= ? AND expires_at > ?
          `)
          .run(input.leaseToken, input.leaseUntil, input.expiresAt, input.now, ...key, input.now, input.now);
      } else {
        return { state: "busy" } as const;
      }
      row = select();
      if (row?.status === "running" && row.lease_token === input.leaseToken) {
        return {
          state: "acquired",
          leaseToken: input.leaseToken,
          ...(replacedResultRef === undefined ? {} : { replacedResultRef }),
        } as const;
      }
      if (row?.status === "succeeded" && row.result_ref && row.expires_at > input.now) {
        return { state: "completed", resultRef: row.result_ref } as const;
      }
      return { state: "busy" } as const;
    });
    return acquire.immediate();
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
    const result = this.#db
      .query(`
        UPDATE tool_executions
        SET status = 'succeeded', result_ref = ?, lease_token = NULL, lease_until = ?, expires_at = ?, updated_at = ?,
            recovery_status = 'none', ambiguous_at = NULL
        WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND status = 'running'
          AND recovery_status = 'none' AND lease_token = ?
      `)
      .run(
        input.resultRef,
        input.now,
        input.expiresAt,
        input.now,
        input.tenantId,
        input.botId,
        input.executionKey,
        input.leaseToken,
      );
    return result.changes === 1;
  }

  async releaseToolExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<void> {
    this.#db
      .query(`
        UPDATE tool_executions SET recovery_status = 'ambiguous', ambiguous_at = COALESCE(ambiguous_at, ?),
          lease_until = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND status = 'running'
          AND recovery_status = 'none' AND lease_token = ?
      `)
      .run(input.now, input.now, input.now, input.tenantId, input.botId, input.executionKey, input.leaseToken);
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
    const list = this.#db.transaction(() => {
      this.#db
        .query(`
          UPDATE tool_executions SET recovery_status = 'ambiguous', ambiguous_at = COALESCE(ambiguous_at, ?), updated_at = ?
          WHERE tenant_id = ? AND bot_id = ? AND status = 'running' AND recovery_status = 'none'
            AND lease_until <= ? AND expires_at > ?
            AND EXISTS (SELECT 1 FROM bots WHERE bots.tenant_id = tool_executions.tenant_id
              AND bots.id = tool_executions.bot_id AND bots.owner_id = ?)
        `)
        .run(input.now, input.now, input.tenantId, input.botId, input.now, input.now, input.ownerId);
      const rows = this.#db
        .query<
          {
            bot_id: string;
            execution_key: string;
            tool_name: string;
            recovery_status: ToolExecutionRecovery["status"];
            ambiguous_at: string;
            updated_at: string;
          },
          [string, string, string, string, number]
        >(`
          SELECT execution.bot_id, execution.execution_key, execution.tool_name,
                 execution.recovery_status, execution.ambiguous_at, execution.updated_at
          FROM tool_executions AS execution
          JOIN bots ON bots.tenant_id = execution.tenant_id AND bots.id = execution.bot_id
          WHERE execution.tenant_id = ? AND bots.owner_id = ? AND execution.bot_id = ?
            AND execution.status = 'running' AND execution.recovery_status IN ('ambiguous', 'retry_approved')
            AND execution.expires_at > ?
          ORDER BY execution.ambiguous_at ASC, execution.execution_key ASC LIMIT ?
        `)
        .all(input.tenantId, input.ownerId, input.botId, input.now, input.limit);
      return rows.map(mapToolExecutionRecovery);
    });
    return list.immediate();
  }

  async resolveOwnedToolExecutionRecovery(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly executionKey: string;
    readonly resolution: "retry" | "close";
    readonly now: string;
  }): Promise<"retry_approved" | "closed" | undefined> {
    const resolve = this.#db.transaction(() => {
      const key: [string, string, string, string] = [input.tenantId, input.ownerId, input.botId, input.executionKey];
      const prior = this.#db
        .query<
          {
            execution_key: string;
            tool_name: string;
            ambiguous_at: string;
          },
          [string, string, string, string, string]
        >(`
          SELECT execution.execution_key, execution.tool_name, execution.ambiguous_at
          FROM tool_executions AS execution
          JOIN bots ON bots.tenant_id = execution.tenant_id AND bots.id = execution.bot_id
          WHERE execution.tenant_id = ? AND bots.owner_id = ? AND execution.bot_id = ?
            AND execution.execution_key = ? AND execution.status = 'running'
            AND execution.recovery_status = 'ambiguous' AND execution.lease_until <= ?
        `)
        .get(...key, input.now);
      if (!prior) return undefined;
      const status = input.resolution === "retry" ? "retry_approved" : "closed";
      const updated = this.#db
        .query(`
          UPDATE tool_executions SET recovery_status = ?, updated_at = ?
          WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND status = 'running'
            AND recovery_status = 'ambiguous' AND lease_until <= ? AND expires_at > ?
        `)
        .run(status, input.now, input.tenantId, input.botId, input.executionKey, input.now, input.now);
      if (updated.changes !== 1) return undefined;
      this.#db
        .query(`
          INSERT INTO audit_logs (id, tenant_id, actor_id, action, resource_type, resource_id, metadata_json, created_at)
          VALUES (?, ?, ?, ?, 'tool_execution', ?, ?, ?)
        `)
        .run(
          `audit_${crypto.randomUUID().replaceAll("-", "")}`,
          input.tenantId,
          input.ownerId,
          input.resolution === "retry" ? "tool.execution_retry_approved" : "tool.execution_closed",
          input.executionKey,
          JSON.stringify({ botId: input.botId, toolName: prior.tool_name, resolution: input.resolution }),
          input.now,
        );
      return status;
    });
    return resolve.immediate();
  }

  async purgeToolExecutions(tenantId: TenantId, now: string, limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new AppError("VALIDATION_ERROR", "Tool execution cleanup page size is invalid.", 400);
    }
    const purge = this.#db.transaction(() => {
      const rows = this.#db
        .query<ToolExecutionRow, [string, string, number]>(`
          SELECT tenant_id, bot_id, conversation_id, execution_key, tool_name, input_hash, status, result_ref,
                 lease_token, lease_until, expires_at, updated_at, recovery_status, ambiguous_at
          FROM tool_executions WHERE tenant_id = ? AND expires_at <= ? ORDER BY expires_at LIMIT ?
        `)
        .all(tenantId, now, limit);
      const deleted: string[] = [];
      for (const row of rows) {
        const result = this.#db
          .query(`
            DELETE FROM tool_executions
            WHERE tenant_id = ? AND bot_id = ? AND execution_key = ? AND expires_at <= ?
          `)
          .run(row.tenant_id, row.bot_id, row.execution_key, now);
        if (result.changes === 1 && row.result_ref) deleted.push(row.result_ref);
      }
      return deleted;
    });
    return purge.immediate();
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
    const result = this.#db
      .query(`
        UPDATE workflow_executions
        SET state_ref = ?, next_step = ?, version = version + 1, lease_until = ?, expires_at = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          AND status = 'running' AND lease_token = ? AND version = ?
      `)
      .run(
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
      );
    return result.changes === 1;
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
    const result = this.#db
      .query(`
        UPDATE workflow_executions
        SET state_ref = ?, next_step = ?, status = 'succeeded', lease_token = NULL,
            lease_until = ?, expires_at = ?, updated_at = ?, version = version + 1
        WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          AND status = 'running' AND lease_token = ? AND version = ?
      `)
      .run(
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
      );
    return result.changes === 1;
  }

  async releaseWorkflowExecution(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<void> {
    this.#db
      .query(`
        UPDATE workflow_executions SET lease_until = ?, updated_at = ?
        WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ?
          AND status = 'running' AND lease_token = ?
      `)
      .run(input.now, input.now, input.tenantId, input.botId, input.skillId, input.executionKey, input.leaseToken);
  }

  async purgeWorkflowExecutions(tenantId: TenantId, now: string, limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new AppError("VALIDATION_ERROR", "Workflow cleanup page size is invalid.", 400);
    }
    const purge = this.#db.transaction(() => {
      const rows = this.#db
        .query<WorkflowExecutionRow, [string, string, number]>(`
          SELECT tenant_id, bot_id, skill_id, execution_key, state_ref, next_step, version, status,
                 lease_token, lease_until, expires_at, updated_at
          FROM workflow_executions WHERE tenant_id = ? AND expires_at <= ? ORDER BY expires_at LIMIT ?
        `)
        .all(tenantId, now, limit);
      const deleted: string[] = [];
      for (const row of rows) {
        const result = this.#db
          .query(`
            DELETE FROM workflow_executions
            WHERE tenant_id = ? AND bot_id = ? AND skill_id = ? AND execution_key = ? AND expires_at <= ?
          `)
          .run(row.tenant_id, row.bot_id, row.skill_id, row.execution_key, now);
        if (result.changes === 1) deleted.push(row.state_ref);
      }
      return deleted;
    });
    return purge.immediate();
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

function mapBotCollaborator(row: BotCollaboratorRow): BotCollaborator {
  return {
    userId: row.user_id as UserId,
    role: row.role,
    memberStatus: row.member_status,
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

function configurationFromBot(bot: BotDefinition): Record<string, unknown> {
  return {
    name: bot.name,
    description: bot.description,
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

function mapStoredMessage(row: ConversationHistoryRow): StoredConversationMessage {
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
    reconnectAttempts: row.reconnect_attempts,
    ...(row.reconnect_after ? { reconnectAfter: row.reconnect_after } : {}),
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

function validateMasterUpdateId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("VALIDATION_ERROR", "Master bot update ID is invalid.", 400);
  }
}

function parseMasterBotReply(value: string | null): MasterBotReply {
  if (!value) throw new AppError("INTERNAL_ERROR", "Stored master bot reply is missing.", 500);
  const reply = parseJson<unknown>(value, "master bot reply");
  if (
    !reply ||
    typeof reply !== "object" ||
    Array.isArray(reply) ||
    !Number.isSafeInteger((reply as Record<string, unknown>).chat_id) ||
    typeof (reply as Record<string, unknown>).text !== "string"
  ) {
    throw new AppError("INTERNAL_ERROR", "Stored master bot reply is invalid.", 500);
  }
  return reply as MasterBotReply;
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

function validateTelegramAttachmentRefs(
  value: unknown,
): readonly { readonly kind: "image"; readonly secretRef: string }[] {
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    value.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        (item as Record<string, unknown>).kind !== "image" ||
        typeof (item as Record<string, unknown>).secretRef !== "string" ||
        !/^secret_[a-f0-9]{32}$/.test((item as Record<string, unknown>).secretRef as string),
    )
  ) {
    throw new AppError("VALIDATION_ERROR", "Telegram response attachments are invalid.", 400);
  }
  return value as readonly { readonly kind: "image"; readonly secretRef: string }[];
}

function parseTelegramAttachmentRefs(value: string): readonly { readonly kind: "image"; readonly secretRef: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", "Stored Telegram attachments are corrupted.", 500, { cause });
  }
  if (!Array.isArray(parsed)) throw new AppError("INTERNAL_ERROR", "Stored Telegram attachments are corrupted.", 500);
  return validateTelegramAttachmentRefs(parsed);
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
