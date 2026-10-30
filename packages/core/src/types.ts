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
  readonly endpoint?: string;
  readonly credentialRef?: string;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
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

export interface ConversationMessage {
  readonly role: MessageRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface AgentRequest {
  readonly bot: BotDefinition;
  readonly conversationId: ConversationId;
  readonly messages: readonly ConversationMessage[];
  readonly actorId: UserId;
  readonly actorContext?: AgentActorContext;
}

export interface AgentResponse {
  readonly message: ConversationMessage;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
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
  readonly model: string;
  /** Opaque secret reference only. Raw credentials must never enter a factory session. */
  readonly credentialRef: string;
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

export interface InstalledSkill {
  readonly definition: SkillDefinition;
  readonly enabled: boolean;
  readonly installedBy: UserId;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly grantedPermissions: readonly string[];
}

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
