import type {
  AgentRequest,
  AgentResponse,
  BotDefinition,
  BotVersionHistoryItem,
  BotId,
  ConversationId,
  ConversationSummary,
  StoredConversationMessage,
  CreationAnswers,
  CreationSession,
  InstalledSkill,
  McpDiscoveredTool,
  McpRemoteTool,
  McpServerConnection,
  SkillDefinition,
  SkillCatalogPublication,
  TenantId,
  UserId,
  TelegramDeploymentId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledJob,
  JobId,
  UsageRecord,
  UsageSummary,
  BotMemoryRecord,
  BotAccessGrant,
  BotAccessDecision,
  PublicBotListing,
  AuditLogEvent,
  WorkflowExecutionAcquisition,
  ToolExecutionAcquisition,
  TenantMember,
  TenantRole,
  TenantWorkspace,
} from "./types.js";

export interface BotRepository {
  get(tenantId: TenantId, botId: BotId): Promise<BotDefinition | undefined>;
  saveDraft(bot: BotDefinition): Promise<void>;
}

export type BotSettingsPatch = Partial<
  Pick<BotDefinition, "name" | "description" | "systemPrompt" | "model" | "memoryEnabled">
>;

export interface BotManagementRepository {
  listOwned(tenantId: TenantId, ownerId: UserId): Promise<readonly BotDefinition[]>;
  listVersions(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly limit: number;
  }): Promise<readonly BotVersionHistoryItem[]>;
  updateOwned(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly expectedVersion: number;
    readonly patch: BotSettingsPatch;
  }): Promise<BotDefinition>;
  setDisabled(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly disabled: boolean;
  }): Promise<void>;
  deleteOwned(input: { readonly tenantId: TenantId; readonly ownerId: UserId; readonly botId: BotId }): Promise<void>;
}

export interface BotCredentialApprovalRepository {
  create(input: {
    readonly approvalHash: string;
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<void>;
  consume(input: {
    readonly approvalHash: string;
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly now: string;
  }): Promise<boolean>;
}

/** Owner-controlled membership administration. Adapters enforce the actor role in the same transaction as changes. */
export interface TenantMembershipRepository {
  listMembers(input: { readonly tenantId: TenantId; readonly actorId: UserId }): Promise<readonly TenantMember[]>;
  listWorkspacesForUser(userId: UserId): Promise<readonly TenantWorkspace[]>;
  getActiveRole(input: { readonly tenantId: TenantId; readonly userId: UserId }): Promise<TenantRole | undefined>;
  addMember(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly memberId: UserId;
    readonly role: Exclude<TenantRole, "owner">;
    readonly now: string;
  }): Promise<TenantMember>;
  changeMemberRole(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly memberId: UserId;
    readonly role: TenantRole;
    readonly now: string;
  }): Promise<TenantMember>;
  deactivateMember(input: {
    readonly tenantId: TenantId;
    readonly actorId: UserId;
    readonly memberId: UserId;
    readonly now: string;
  }): Promise<TenantMember>;
}

export interface ConversationRepository {
  /** Load committed turns for this tenant-scoped conversation, oldest to newest. */
  load(tenantId: TenantId, conversationId: ConversationId, limit: number): Promise<AgentRequest["messages"]>;
  /** Append a whole committed turn atomically so retries do not persist partial tool loops. */
  append(tenantId: TenantId, conversationId: ConversationId, messages: AgentRequest["messages"]): Promise<void>;
}

/** Creates or reuses an API conversation scoped to a bot and an authenticated actor. */
export interface ApiConversationRepository {
  getOrCreateApiConversation(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly actorId: UserId;
    readonly conversationKey: string;
  }): Promise<ConversationId>;
}

export interface ConversationHistoryRepository {
  listOwnedConversations(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly limit: number;
    readonly offset: number;
  }): Promise<readonly ConversationSummary[]>;
  getOwnedConversationMessages(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly conversationId: ConversationId;
    readonly limit: number;
    readonly beforeSequence?: number;
  }): Promise<{ readonly items: readonly StoredConversationMessage[]; readonly hasMore: boolean } | undefined>;
}

export interface UsageRepository {
  recordUsage(record: UsageRecord): Promise<void>;
  getOwnedUsageSummary(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly from: string;
    readonly through: string;
  }): Promise<UsageSummary>;
}

export interface StoredBotMemoryRecord extends BotMemoryRecord {
  /** False only for legacy rows written before encrypted memory storage was enabled. */
  readonly encryptedValue: boolean;
}

export interface MemoryRepository {
  listOwnedBotMemory(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<readonly StoredBotMemoryRecord[]>;
  listActiveBotMemory(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly now: string;
  }): Promise<readonly StoredBotMemoryRecord[]>;
  putOwnedBotMemory(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly key: string;
    readonly value: string;
    readonly encryptedValue?: boolean;
    readonly expiresAt?: string;
    readonly now: string;
  }): Promise<StoredBotMemoryRecord>;
  deleteOwnedBotMemory(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly key: string;
  }): Promise<boolean>;
}

/** Plaintext memory operations exposed only after the encrypted storage boundary. */
export interface BotMemoryService {
  listOwnedBotMemory(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<readonly BotMemoryRecord[]>;
  listActiveBotMemory(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly now: string;
  }): Promise<readonly BotMemoryRecord[]>;
  putOwnedBotMemory(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly key: string;
    readonly value: string;
    readonly expiresAt?: string;
    readonly now: string;
  }): Promise<BotMemoryRecord>;
  deleteOwnedBotMemory(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly key: string;
  }): Promise<boolean>;
}

/** Cross-tenant public and explicitly shared bot access, enforced by each runtime's database adapter. */
export interface BotAccessRepository {
  listPublicBots(input: { readonly query?: string; readonly limit: number }): Promise<readonly PublicBotListing[]>;
  getPublicBotBySlug(slug: string): Promise<BotDefinition | undefined>;
  getSharedBot(input: {
    readonly botId: BotId;
    readonly userId: UserId;
    readonly now: string;
  }): Promise<BotDefinition | undefined>;
  listOwnedAccessGrants(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<readonly BotAccessGrant[]>;
  getOwnedPublicBotAccessPolicy(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<PublicBotListing | undefined>;
  setPublicBotAccessPolicy(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly dailyUsageLimit: number;
    readonly rateLimitPerMinute: number;
    readonly now: string;
  }): Promise<PublicBotListing>;
  createOwnedAccessGrant(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly userId?: UserId;
    readonly invitationTokenHash?: string;
    readonly dailyUsageLimit?: number;
    readonly rateLimitPerMinute?: number;
    readonly expiresAt?: string;
    readonly now: string;
  }): Promise<BotAccessGrant>;
  revokeOwnedAccessGrant(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly grantId: string;
  }): Promise<boolean>;
  acceptBotInvitation(input: {
    readonly invitationTokenHash: string;
    readonly userId: UserId;
    readonly now: string;
  }): Promise<BotAccessGrant | undefined>;
  consumeBotUse(input: {
    readonly botId: BotId;
    readonly userId: UserId;
    readonly accessMode: "public" | "shared";
    readonly now: string;
  }): Promise<BotAccessDecision>;
}

export interface TelegramDeployment {
  readonly id: TelegramDeploymentId;
  readonly tenantId: TenantId;
  readonly botId: BotId;
  readonly externalId: string;
  readonly credentialRef: string;
  readonly webhookSecretRef: string;
  readonly status: "pending" | "active" | "disabled" | "failed";
}

export type TelegramUpdateReservation =
  | { readonly state: "acquired" }
  | { readonly state: "busy" }
  | { readonly state: "completed"; readonly attachmentRefs?: readonly TelegramResponseAttachmentReference[] }
  | {
      readonly state: "ready";
      readonly responseText: string;
      readonly attachmentRefs?: readonly TelegramResponseAttachmentReference[];
    };

export interface TelegramResponseAttachmentReference {
  readonly kind: "image";
  readonly secretRef: string;
}

export interface TelegramAccessPolicy {
  readonly allowedUserIds: readonly number[];
  readonly pendingUserIds: readonly number[];
}

/** Tenant-scoped Telegram deployment and webhook deduplication persistence. */
export interface TelegramRepository {
  getTelegramDeployment(id: TelegramDeploymentId): Promise<TelegramDeployment | undefined>;
  getOwnedTelegramDeployment(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<TelegramDeployment | undefined>;
  createTelegramDeployment(input: TelegramDeployment): Promise<void>;
  setTelegramDeploymentStatus(input: {
    readonly tenantId: TenantId;
    readonly id: TelegramDeploymentId;
    readonly status: TelegramDeployment["status"];
  }): Promise<void>;
  deleteTelegramDeployment(input: { readonly tenantId: TenantId; readonly id: TelegramDeploymentId }): Promise<void>;
  getTelegramAccessPolicy(deploymentId: TelegramDeploymentId): Promise<TelegramAccessPolicy>;
  isTelegramSenderAllowed(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly telegramUserId: number;
  }): Promise<boolean>;
  recordTelegramAccessRequest(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly telegramUserId: number;
    readonly now: string;
  }): Promise<void>;
  replaceTelegramAllowedUsers(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly telegramUserIds: readonly number[];
    readonly now: string;
  }): Promise<void>;
  listTelegramToolGrants(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly telegramUserId: number;
  }): Promise<readonly string[]>;
  replaceTelegramToolGrants(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly telegramUserId: number;
    readonly toolRefs: readonly string[];
    readonly now: string;
  }): Promise<void>;
  isTelegramToolAllowed(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly telegramUserId: number;
    readonly toolRef: string;
  }): Promise<boolean>;
  getOrCreateTelegramConversation(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly actorId: UserId;
    readonly conversationKey: string;
  }): Promise<ConversationId>;
  reserveTelegramUpdate(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly updateId: number;
    readonly leaseUntil: string;
    readonly now: string;
  }): Promise<TelegramUpdateReservation>;
  saveTelegramUpdateResponse(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly updateId: number;
    readonly responseText: string;
    readonly attachmentRefs?: readonly TelegramResponseAttachmentReference[];
    readonly leaseUntil: string;
    readonly now: string;
  }): Promise<void>;
  completeTelegramUpdate(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly updateId: number;
    readonly now: string;
  }): Promise<void>;
  clearTelegramUpdateAttachments(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly updateId: number;
  }): Promise<void>;
  releaseTelegramUpdate(input: {
    readonly deploymentId: TelegramDeploymentId;
    readonly updateId: number;
    readonly now: string;
  }): Promise<void>;
}

export interface AgentEngine {
  respond(request: AgentRequest, options?: { readonly onTextDelta?: (delta: string) => void }): Promise<AgentResponse>;
}

export interface SecretStore {
  resolve(tenantId: TenantId, reference: string, signal?: AbortSignal): Promise<string>;
}

export interface SecretWriter {
  put(tenantId: TenantId, plaintext: string): Promise<string>;
  delete(tenantId: TenantId, reference: string): Promise<void>;
}

export interface EncryptedSecretRecord {
  readonly tenantId: TenantId;
  readonly reference: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly version: 1;
  readonly createdAt: string;
}

export interface SecretRecordRepository {
  get(tenantId: TenantId, reference: string): Promise<EncryptedSecretRecord | undefined>;
  create(record: EncryptedSecretRecord): Promise<void>;
  delete(tenantId: TenantId, reference: string): Promise<void>;
  listPage(
    after: { readonly tenantId: TenantId; readonly reference: string } | undefined,
    limit: number,
  ): Promise<readonly EncryptedSecretRecord[]>;
  replaceIfUnchanged(
    record: EncryptedSecretRecord,
    expected: { readonly keyId: string; readonly nonce: string; readonly ciphertext: string },
  ): Promise<boolean>;
}

export interface SecretKeyring {
  activeKey(): Promise<{ readonly id: string; readonly material: Uint8Array }>;
  getKey(id: string): Promise<Uint8Array | undefined>;
}

export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface RuntimeCapabilities {
  readonly runtime: "bun" | "cloudflare";
  readonly features: Readonly<Record<string, boolean>>;
}

export interface CreationSessionRepository {
  create(session: CreationSession): Promise<void>;
  get(tenantId: TenantId, ownerId: UserId, sessionId: string): Promise<CreationSession | undefined>;
  /** Save only when the stored revision equals expectedRevision; implementations must update atomically. */
  save(session: CreationSession, expectedRevision: number): Promise<void>;
}

export type CreationApprovalAction = "connect_credentials" | "public_access" | "publish_bot";

export interface CreationApprovalVerifier {
  /** Verify and consume a one-use grant bound to this tenant, owner, session, and action. */
  consume(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly sessionId: string;
    readonly action: CreationApprovalAction;
    readonly approvalId: string;
  }): Promise<boolean>;
}

export interface CreationApprovalRecord {
  readonly approvalHash: string;
  readonly tenantId: TenantId;
  readonly ownerId: UserId;
  readonly sessionId: string;
  readonly action: CreationApprovalAction;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Persists only a one-way hash for a short-lived, one-use approval grant. */
export interface CreationApprovalRepository {
  create(record: CreationApprovalRecord): Promise<void>;
  consume(input: {
    readonly approvalHash: string;
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly sessionId: string;
    readonly action: CreationApprovalAction;
    readonly now: string;
  }): Promise<boolean>;
}

export interface BotDraftPublisher {
  createDraft(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly idempotencyKey: string;
    readonly answers: CreationAnswers;
  }): Promise<BotId>;
  publish(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

/** Persistent runtime scheduling by opaque task reference; implementations own alarm delivery. */
export interface ScheduledTaskScheduler {
  schedule(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly taskId: string;
    readonly runAt: string;
    readonly timezone: string;
    readonly payloadRef: string;
  }): Promise<void>;
  cancel(input: { readonly tenantId: TenantId; readonly botId: BotId; readonly taskId: string }): Promise<void>;
}

/** Durable task and job persistence shared by the D1 queue consumer and Bun worker. */
export interface ScheduledTaskRepository {
  createScheduledTask(input: {
    readonly task: ScheduledTask;
    readonly firstJobId: JobId;
    readonly idempotencyKey: string;
  }): Promise<void>;
  getScheduledTask(input: {
    readonly tenantId: TenantId;
    readonly taskId: ScheduledTaskId;
  }): Promise<ScheduledTask | undefined>;
  listOwnedScheduledTasks(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<readonly ScheduledTask[]>;
  setScheduledTaskStatus(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly taskId: ScheduledTaskId;
    readonly status: ScheduledTask["status"];
    readonly nextRunAt?: string;
    readonly now: string;
  }): Promise<void>;
  createScheduledRunJob(input: {
    readonly tenantId: TenantId;
    readonly taskId: ScheduledTaskId;
    readonly jobId: JobId;
    readonly runAt: string;
    readonly idempotencyKey: string;
    readonly now: string;
  }): Promise<void>;
  listDueScheduledJobIds(input: { readonly now: string; readonly limit: number }): Promise<readonly JobId[]>;
  getScheduledJob(input: { readonly jobId: JobId }): Promise<ScheduledJob | undefined>;
  claimScheduledJob(input: {
    readonly jobId: JobId;
    readonly now: string;
    readonly leaseUntil: string;
  }): Promise<ScheduledJob | undefined>;
  saveScheduledJobResult(input: {
    readonly jobId: JobId;
    readonly resultText: string;
    readonly now: string;
  }): Promise<void>;
  completeScheduledRun(input: {
    readonly tenantId: TenantId;
    readonly taskId: ScheduledTaskId;
    readonly jobId: JobId;
    readonly nextRunAt?: string;
    readonly now: string;
  }): Promise<void>;
  retryScheduledJob(input: {
    readonly jobId: JobId;
    readonly availableAt: string;
    readonly now: string;
  }): Promise<void>;
  failScheduledJob(input: { readonly jobId: JobId; readonly now: string }): Promise<void>;
}

export interface StoredObjectMetadata {
  readonly tenantId: TenantId;
  readonly objectId: string;
  readonly contentType: string;
  readonly size: number;
  readonly etag: string;
  readonly createdAt: string;
}

export interface StoredObject extends StoredObjectMetadata {
  readonly bytes: Uint8Array;
}

export interface StoredObjectStream extends StoredObjectMetadata {
  readonly body: ReadableStream<Uint8Array>;
}

/** Tenant-scoped binary storage with explicit size and content-type validation. */
export interface ObjectStore {
  put(input: {
    readonly tenantId: TenantId;
    readonly objectId: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<StoredObjectMetadata>;
  get(tenantId: TenantId, objectId: string): Promise<StoredObject | undefined>;
  putStream(input: {
    readonly tenantId: TenantId;
    readonly objectId: string;
    readonly contentType: string;
    readonly size: number;
    readonly body: ReadableStream<Uint8Array>;
  }): Promise<StoredObjectMetadata>;
  getStream(tenantId: TenantId, objectId: string): Promise<StoredObjectStream | undefined>;
  delete(tenantId: TenantId, objectId: string): Promise<void>;
}

export interface ApiTokenPrincipal {
  readonly tokenId: string;
  readonly tenantId: TenantId;
  readonly ownerId: UserId;
  readonly scopes: readonly string[];
  /** Workspace role used to limit effective scopes. Raw token scopes remain the delegation ceiling. */
  readonly tenantRole?: TenantRole;
  readonly expiresAt?: string;
  readonly delegableScopes?: readonly string[];
}

export interface ApiTokenRecord extends ApiTokenPrincipal {
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly createdAt: string;
}

/** Stores only a one-way hash; raw API tokens are shown once at creation time. */
export interface ApiTokenRepository {
  findActive(tokenHash: string, now: string): Promise<ApiTokenPrincipal | undefined>;
  create(record: ApiTokenRecord): Promise<void>;
  revoke(tenantId: TenantId, ownerId: UserId, tokenId: string, revokedAt: string): Promise<void>;
  consumeApiRequest(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly now: string;
    readonly limitPerMinute: number;
  }): Promise<boolean>;
  recordApiMutation(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly tokenId: string;
    readonly method: string;
    readonly pathname: string;
    readonly createdAt: string;
  }): Promise<void>;
}

export interface AuditLogRepository {
  recordPermissionDecision(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly category: "skill" | "mcp";
    readonly permission: string;
    readonly outcome: "allowed" | "denied";
    readonly createdAt: string;
  }): Promise<void>;
  listOwnedAuditLogs(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly limit: number;
  }): Promise<readonly AuditLogEvent[]>;
}

/** Persist authorization decisions for authenticated API requests. */
export interface ApiAuthorizationDenialRepository {
  recordApiAuthorizationDenial(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly tokenId: string;
    readonly method: string;
    readonly pathname: string;
    readonly denialType: "scope" | "resource";
    readonly errorCode: "FORBIDDEN" | "NOT_FOUND";
    readonly requiredScope?: string;
    readonly createdAt: string;
  }): Promise<void>;
}

/** Telegram Web App identity and one-use initData replay protection. */
export interface TelegramAuthRepository {
  claimInitData(input: {
    readonly dataHash: string;
    readonly expiresAt: string;
    readonly now: string;
  }): Promise<boolean>;
  getOrCreateOwner(input: {
    readonly telegramUserId: number;
    readonly ownerId: UserId;
    readonly tenantId: TenantId;
    readonly workspaceName: string;
    readonly now: string;
  }): Promise<{ readonly ownerId: UserId; readonly tenantId: TenantId }>;
}

export interface MasterBotSession {
  readonly telegramUserId: number;
  readonly chatId: number;
  readonly tenantId: TenantId;
  readonly ownerId: UserId;
  readonly sessionId: string;
  readonly updatedAt: string;
}

export interface MasterBotReply {
  readonly chat_id: number;
  readonly text: string;
  readonly reply_markup?: Readonly<Record<string, unknown>>;
}

export type MasterBotUpdateReservation =
  | { readonly state: "completed" | "busy" | "acquired" }
  | { readonly state: "ready"; readonly reply: MasterBotReply };

/** Persistent owner-to-factory routing and idempotent master-bot webhook delivery. */
export interface MasterBotRepository {
  getSession(telegramUserId: number): Promise<MasterBotSession | undefined>;
  saveSession(session: MasterBotSession): Promise<void>;
  deleteSession(telegramUserId: number): Promise<void>;
  reserveUpdate(input: {
    readonly updateId: number;
    readonly leaseUntil: string;
    readonly now: string;
  }): Promise<MasterBotUpdateReservation>;
  saveUpdateReply(input: {
    readonly updateId: number;
    readonly reply: MasterBotReply;
    readonly leaseUntil: string;
    readonly now: string;
  }): Promise<void>;
  completeUpdate(input: { readonly updateId: number; readonly now: string }): Promise<void>;
  releaseUpdate(input: { readonly updateId: number; readonly now: string }): Promise<void>;
}

export interface SkillRepository {
  listCatalog(tenantId: TenantId): Promise<readonly SkillDefinition[]>;
  getCatalogSkill(tenantId: TenantId, skillId: string): Promise<SkillDefinition | undefined>;
  listGlobalCatalog(): Promise<readonly SkillDefinition[]>;
  publishGlobalCatalogSkill(input: { readonly definition: SkillCatalogPublication }): Promise<void>;
  setGlobalCatalogSkillEnabled(skillId: string, enabled: boolean): Promise<void>;
  publishCatalogSkill(input: {
    readonly tenantId: TenantId;
    readonly definition: SkillCatalogPublication;
  }): Promise<void>;
  listInstalled(tenantId: TenantId, botId: BotId): Promise<readonly InstalledSkill[]>;
  install(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly installedBy: UserId;
    readonly configuration: Readonly<Record<string, unknown>>;
    readonly grantedPermissions: readonly string[];
  }): Promise<void>;
  setEnabled(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly enabled: boolean;
  }): Promise<void>;
  uninstall(input: { readonly tenantId: TenantId; readonly botId: BotId; readonly skillId: string }): Promise<void>;
}

/** Atomic fixed-window limiter used by installed skills. */
export interface SkillRateLimiter {
  consume(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly now: number;
    readonly maxRequests: number;
    readonly windowSeconds: number;
  }): Promise<boolean>;
}

/** Durable, tenant-scoped workflow checkpoints. State payloads live only in encrypted secret storage. */
export interface WorkflowExecutionRepository {
  acquire(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly executionKey: string;
    readonly initialStateRef: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseUntil: string;
    readonly expiresAt: string;
  }): Promise<WorkflowExecutionAcquisition>;
  checkpoint(input: {
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
  }): Promise<boolean>;
  complete(input: {
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
  }): Promise<boolean>;
  release(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly skillId: string;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<void>;
  purgeExpired(tenantId: TenantId, now: string, limit: number): Promise<readonly string[]>;
}

/** Durable idempotency ledger for completed model-issued tool calls. Result payloads remain encrypted in secret storage. */
export interface ToolExecutionRepository {
  acquire(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly executionKey: string;
    readonly toolName: string;
    readonly inputHash: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseUntil: string;
    readonly expiresAt: string;
  }): Promise<ToolExecutionAcquisition>;
  complete(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly resultRef: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<boolean>;
  release(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly executionKey: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<void>;
  purgeExpired(tenantId: TenantId, now: string, limit: number): Promise<readonly string[]>;
}

export interface McpRepository {
  listServers(tenantId: TenantId, botId: BotId): Promise<readonly McpServerConnection[]>;
  getServer(tenantId: TenantId, botId: BotId, serverId: string): Promise<McpServerConnection | undefined>;
  createServer(input: {
    readonly id: string;
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly name: string;
    readonly endpoint: string;
    readonly credentialRef?: string;
    readonly installedBy: UserId;
  }): Promise<void>;
  setServerStatus(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly serverId: string;
    readonly status: McpServerConnection["status"];
  }): Promise<void>;
  deleteServer(input: { readonly tenantId: TenantId; readonly botId: BotId; readonly serverId: string }): Promise<void>;
  listTools(tenantId: TenantId, botId: BotId, serverId?: string): Promise<readonly McpDiscoveredTool[]>;
  getTool(tenantId: TenantId, botId: BotId, serverId: string, toolName: string): Promise<McpDiscoveredTool | undefined>;
  replaceDiscoveredTools(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly serverId: string;
    readonly tools: readonly McpRemoteTool[];
    readonly discoveredAt: string;
  }): Promise<void>;
  setToolPermission(input: {
    readonly tenantId: TenantId;
    readonly botId: BotId;
    readonly serverId: string;
    readonly toolName: string;
    readonly enabled: boolean;
    readonly grantedPermissions: readonly string[];
  }): Promise<void>;
}
