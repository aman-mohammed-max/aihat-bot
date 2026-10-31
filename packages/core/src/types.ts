export type TenantId = string & { readonly __brand: "TenantId" };
export type UserId = string & { readonly __brand: "UserId" };
export type BotId = string & { readonly __brand: "BotId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type TelegramDeploymentId = string & { readonly __brand: "TelegramDeploymentId" };
export type ScheduledTaskId = string & { readonly __brand: "ScheduledTaskId" };
export type JobId = string & { readonly __brand: "JobId" };

export interface AgentActorContext {
  readonly platform?: "api" | "telegram" | "scheduled";
  readonly telegramDeploymentId?: TelegramDeploymentId;
  readonly telegramUserId?: number;
  /** Explicitly hide owner-authored memory when handling cross-user public or shared requests. */
  readonly includeOwnerMemory?: boolean;
}

export type BotVisibility = "private" | "shared" | "public" | "invitation";
export type BotStatus = "draft" | "published" | "disabled";

export interface ScheduledTask {
  readonly id: ScheduledTaskId;
  readonly tenantId: TenantId;
  readonly botId: BotId;
  readonly ownerId: UserId;
  readonly schedule: string;
  readonly timezone: string;
  readonly prompt: string;
  readonly notifyTelegramUserId: number;
  readonly status: "active" | "paused" | "completed" | "failed";
  readonly nextRunAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduledJob {
  readonly id: JobId;
  readonly tenantId: TenantId;
  readonly taskId: ScheduledTaskId;
  readonly status: "queued" | "running" | "succeeded" | "retrying" | "failed" | "cancelled";
  readonly attempts: number;
  readonly availableAt: string;
  readonly leaseUntil?: string;
  readonly resultText?: string;
}

export interface ModelConfig {
  readonly providerId: string;
  readonly model: string;
  readonly imageModel?: string;
  readonly searchModel?: string;
  readonly endpoint?: string;
  readonly credentialRef?: string;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
}

/** Bounded JSON Schema object supplied for a structured agent response. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface BotVersionHistoryItem {
  readonly botId: BotId;
  readonly version: number;
  readonly name?: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly model: Omit<ModelConfig, "credentialRef"> & { readonly hasCredential: boolean };
  readonly memoryEnabled: boolean;
  readonly createdAt: string;
  readonly current: boolean;
}

export interface BotDefinition {
  readonly id: BotId;
  readonly tenantId: TenantId;
  readonly ownerId: UserId;
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly model: ModelConfig;
  readonly purpose?: string;
  readonly audience?: string;
  readonly skills?: readonly string[];
  readonly mcpConnections?: readonly string[];
  readonly integrations?: readonly string[];
  readonly memoryEnabled?: boolean;
  readonly scheduledTasks?: readonly string[];
  readonly privacySettings?: readonly string[];
  readonly interfaces?: readonly ("telegram" | "web_chat" | "api")[];
  readonly visibility: BotVisibility;
  readonly status: BotStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ConversationImage {
  readonly dataUrl: string;
  readonly detail?: "auto" | "low" | "high";
}

export interface ConversationMessage {
  readonly role: MessageRole;
  readonly content: string;
  /** Transient model input. Image bytes are intentionally omitted from stored history. */
  readonly images?: readonly ConversationImage[];
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ConversationSummary {
  readonly id: ConversationId;
  readonly platform: "internal" | "telegram" | "web_chat" | "api";
  readonly messageCount: number;
  readonly preview: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredConversationMessage extends ConversationMessage {
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: string;
}

export interface UsageTotal {
  readonly requests: number;
  readonly reportedRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface UsageSummary {
  readonly from: string;
  readonly through: string;
  readonly total: UsageTotal;
  readonly byDay: readonly (UsageTotal & { readonly date: string })[];
  readonly byBot: readonly (UsageTotal & { readonly botId: BotId; readonly botName: string })[];
}

export type UploadedFileScanStatus = "pending_scan" | "clean" | "rejected" | "scan_failed";

export interface UploadedFile {
  readonly id: string;
  readonly botId: BotId;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly etag: string;
  readonly scanStatus: UploadedFileScanStatus;
  readonly scanner?: string;
  readonly scannedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuditLogEvent {
  readonly id: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export type TenantRole = "owner" | "admin" | "member";
export type TenantMembershipStatus = "active" | "inactive";

export interface TenantMember {
  readonly userId: UserId;
  readonly role: TenantRole;
  readonly status: TenantMembershipStatus;
  readonly createdAt: string;
  readonly ownedBotCount: number;
}

export type TenantInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface TenantInvitation {
  readonly id: string;
  readonly role: Exclude<TenantRole, "owner">;
  readonly status: TenantInvitationStatus;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedBy?: UserId;
  readonly acceptedAt?: string;
}

export interface TenantWorkspace {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly role: TenantRole;
  readonly createdAt: string;
}

export interface UsageRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly botId: BotId;
  readonly actorId?: UserId;
  readonly providerId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usageReported: boolean;
  readonly createdAt: string;
}

export interface BotMemoryRecord {
  readonly id: string;
  readonly botId: BotId;
  readonly key: string;
  readonly value: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicBotListing {
  readonly botId: BotId;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly listedAt: string;
  readonly dailyUsageLimit: number;
  readonly rateLimitPerMinute: number;
}

export interface BotAccessGrant {
  readonly id: string;
  readonly botId: BotId;
  readonly userId?: UserId;
  readonly invitationAvailable: boolean;
  readonly accessLevel: "use" | "manage";
  readonly status: "active" | "revoked" | "expired";
  /** Maximum agent requests per UTC day. */
  readonly dailyUsageLimit?: number;
  readonly rateLimitPerMinute?: number;
  readonly expiresAt?: string;
  readonly createdAt: string;
}

export type BotAccessDecision = "allowed" | "forbidden" | "rate_limited" | "quota_exceeded";

export interface AgentRequest {
  readonly bot: BotDefinition;
  readonly conversationId: ConversationId;
  /** Stable request identity for webhook retries; omitted requests receive a fresh local identity. */
  readonly executionId?: string;
  readonly messages: readonly ConversationMessage[];
  readonly actorId: UserId;
  readonly actorContext?: AgentActorContext;
  /** Optional strict object schema for a non-streaming response. */
  readonly responseSchema?: JsonSchema;
  /** Request cancellation is transient and is never stored with conversation messages. */
  readonly signal?: AbortSignal;
}

export interface AgentResponse {
  readonly message: ConversationMessage;
  readonly attachments?: readonly AgentImageAttachment[];
  readonly structuredOutput?: unknown;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

/** Images produced by a tool and delivered alongside the assistant message. */
export interface AgentImageAttachment {
  readonly kind: "image";
  readonly url: string;
  readonly alt?: string;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ModelTurn {
  readonly message: ConversationMessage;
  readonly toolCalls: readonly ModelToolCall[];
  readonly structuredOutput?: unknown;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface CreationAnswers {
  readonly name: string;
  readonly description: string;
  readonly purpose: string;
  readonly audience: string;
  readonly personality: string;
  readonly providerId: string;
  readonly endpoint: string;
  /** Opaque secret reference only. Raw credentials must never enter a factory session. */
  readonly credentialRef: string;
  readonly model: string;
  readonly imageModel?: string;
  readonly searchModel?: string;
  readonly skills: readonly string[];
  readonly mcpConnections: readonly string[];
  readonly integrations: readonly string[];
  readonly memoryEnabled: boolean;
  readonly scheduledTasks: readonly string[];
  readonly privacySettings: readonly string[];
  readonly visibility: BotVisibility;
  readonly interfaces: readonly ("telegram" | "web_chat" | "api")[];
}

export type CreationStep = keyof CreationAnswers;
export type CreationSessionStatus = "in_progress" | "paused" | "ready" | "draft" | "published";

export interface CreationSession {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly ownerId: UserId;
  readonly status: CreationSessionStatus;
  readonly currentStep: CreationStep | null;
  readonly answers: Partial<CreationAnswers>;
  readonly botId?: BotId;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SkillExecutionType = "prompt" | "http" | "mcp" | "native" | "workflow" | "sandbox";

export interface SkillDefinition {
  readonly id: string;
  readonly tenantId: TenantId | null;
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly category: string;
  readonly description: string;
  readonly executionType: SkillExecutionType;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly requiredPermissions: readonly string[];
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly rateLimit: { readonly maxRequests: number; readonly windowSeconds: number };
  readonly retryPolicy: {
    readonly maxAttempts: number;
    readonly backoffMs: number;
    readonly idempotent: boolean;
    readonly retryableStatusCodes: readonly number[];
  };
  readonly enabled: boolean;
}

export type SkillCatalogPublication = Omit<SkillDefinition, "tenantId" | "enabled">;

export interface InstalledSkill {
  readonly definition: SkillDefinition;
  readonly enabled: boolean;
  readonly installedBy: UserId;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly grantedPermissions: readonly string[];
}

export type WorkflowExecutionStatus = "running" | "succeeded";

export interface WorkflowExecution {
  readonly tenantId: TenantId;
  readonly botId: BotId;
  readonly skillId: string;
  readonly executionKey: string;
  readonly stateRef: string;
  readonly nextStep: number;
  readonly version: number;
  readonly status: WorkflowExecutionStatus;
  readonly leaseToken?: string;
  readonly leaseUntil: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

export type WorkflowExecutionAcquisition =
  | { readonly state: "acquired"; readonly execution: WorkflowExecution; readonly replacedStateRef?: string }
  | { readonly state: "busy" }
  | { readonly state: "completed"; readonly execution: WorkflowExecution };

export type ToolExecutionAcquisition =
  | { readonly state: "acquired"; readonly leaseToken: string; readonly replacedResultRef?: string }
  | { readonly state: "busy" }
  | { readonly state: "completed"; readonly resultRef: string };

export type McpServerStatus = "disconnected" | "connected" | "unhealthy" | "disabled";

export interface McpServerConnection {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly botId: BotId;
  readonly name: string;
  readonly endpoint: string;
  readonly credentialRef?: string;
  readonly status: McpServerStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpRemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface McpDiscoveredTool extends McpRemoteTool {
  readonly serverId: string;
  readonly enabled: boolean;
  readonly grantedPermissions: readonly string[];
  readonly lastSeenAt: string;
}
