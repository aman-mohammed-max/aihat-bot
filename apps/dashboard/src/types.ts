export type ApiScope =
  | "factory:read"
  | "factory:write"
  | "bots:read"
  | "bots:write"
  | "skills:publish"
  | "agent:run"
  | "tokens:manage"
  | "members:manage";

export interface Principal {
  tenantId: string;
  userId: string;
  tokenId: string;
  scopes: ApiScope[];
}

export interface TenantMember {
  userId: string;
  role: "owner" | "admin" | "member";
  status: "active" | "inactive";
  createdAt: string;
  ownedBotCount: number;
}

export interface TenantInvitation {
  id: string;
  role: "admin" | "member";
  status: "pending" | "accepted" | "revoked" | "expired";
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedBy?: string;
  acceptedAt?: string;
}

export interface WorkspaceMembership {
  tenantId: string;
  name: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
}

export interface Bot {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  memoryEnabled: boolean;
  model: {
    providerId: string;
    model: string;
    imageModel?: string;
    searchModel?: string;
    endpoint?: string;
    parameters?: Record<string, string | number | boolean>;
    retryPolicy?: { maxAttempts: number; backoffMs: number };
    hasCredential: boolean;
  };
  visibility: "private" | "shared" | "public" | "invitation";
  interfaces?: Array<"telegram" | "web_chat" | "api">;
  status: "draft" | "published" | "disabled";
  version: number;
  createdAt: string;
  updatedAt: string;
  collaboratorRole?: "viewer" | "editor";
}

export interface PublicChatBot {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: "public";
}

export interface BotCollaborator {
  userId: string;
  role: "viewer" | "editor";
  memberStatus: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface BotVersion {
  botId: string;
  version: number;
  name?: string;
  description?: string;
  systemPrompt: string;
  model: {
    providerId: string;
    model: string;
    imageModel?: string;
    searchModel?: string;
    retryPolicy?: { maxAttempts: number; backoffMs: number };
    hasCredential: boolean;
  };
  memoryEnabled: boolean;
  createdAt: string;
  current: boolean;
}

export interface BotOwnershipTransfer {
  id: string;
  botId: string;
  fromOwnerId: string;
  toOwnerId: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
}

export interface Skill {
  id: string;
  name: string;
  version: string;
  author: string;
  category: string;
  description: string;
  executionType: "prompt" | "http" | "mcp" | "native" | "workflow" | "sandbox";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requiredPermissions: string[];
  enabled: boolean;
  grantedPermissions?: string[];
  hasCredential?: boolean;
}

export interface TelegramSettings {
  botId: string;
  status: "not_connected" | "active" | "disabled";
  telegramBotId?: string;
  allowedUserIds: number[];
  pendingUserIds: number[];
}

export interface McpServer {
  id: string;
  name: string;
  endpoint: string;
  status: "disconnected" | "connected" | "unhealthy" | "disabled";
  reconnectAttempts: number;
  reconnectAfter?: string;
  hasCredential: boolean;
  authenticationMode: "none" | "bearer" | "oauth_client_credentials" | "oauth_authorization_code";
  createdAt: string;
  updatedAt: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  enabled: boolean;
  grantedPermissions: string[];
  lastSeenAt: string;
}

export interface ScheduledTask {
  id: string;
  botId: string;
  schedule: string;
  timezone: string;
  prompt: string;
  notifyTelegramUserId: number;
  status: "active" | "paused" | "completed" | "failed";
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UploadedFile {
  id: string;
  botId: string;
  fileName: string;
  contentType: string;
  size: number;
  scanStatus: "pending_scan" | "clean" | "rejected" | "scan_failed";
  scanner?: string;
  scannedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolExecutionRecovery {
  botId: string;
  executionKey: string;
  toolName: string;
  status: "ambiguous" | "retry_approved";
  ambiguousAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  platform: "internal" | "telegram" | "web_chat" | "api";
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredConversationMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  createdAt: string;
}

export interface UsageTotal {
  requests: number;
  reportedRequests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  from: string;
  through: string;
  total: UsageTotal;
  byDay: Array<UsageTotal & { date: string }>;
  byBot: Array<UsageTotal & { botId: string; botName: string }>;
  modelRetries: {
    total: number;
    byDay: Array<{ date: string; retries: number }>;
    byBot: Array<{ botId: string; botName: string; retries: number }>;
    byStatusCode: Array<{ statusCode: number; retries: number }>;
  };
}

export interface AuditLogEvent {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface BotMemoryRecord {
  id: string;
  botId: string;
  key: string;
  value: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotAccessGrant {
  id: string;
  botId: string;
  userId?: string;
  invitationAvailable: boolean;
  accessLevel: "use" | "manage";
  status: "active" | "revoked" | "expired";
  dailyUsageLimit?: number;
  rateLimitPerMinute?: number;
  expiresAt?: string;
  createdAt: string;
}

export interface PublicBotListing {
  botId: string;
  slug: string;
  title: string;
  summary: string;
  listedAt: string;
  dailyUsageLimit: number;
  rateLimitPerMinute: number;
}

export interface BotAccessSettings {
  botId: string;
  visibility: Bot["visibility"];
  publicListing: PublicBotListing | null;
  grants: BotAccessGrant[];
}

export type CreationStep =
  | "name"
  | "description"
  | "purpose"
  | "audience"
  | "personality"
  | "providerId"
  | "endpoint"
  | "model"
  | "credentialRef"
  | "imageModel"
  | "searchModel"
  | "skills"
  | "mcpConnections"
  | "integrations"
  | "memoryEnabled"
  | "scheduledTasks"
  | "privacySettings"
  | "visibility"
  | "interfaces";

export interface CreationSession {
  id: string;
  status: "in_progress" | "paused" | "ready" | "draft" | "published";
  currentStep: CreationStep | null;
  answers: Record<string, unknown>;
  botId?: string;
  revision: number;
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  kind: "chat" | "image" | "other";
}

export interface FactoryAssistantDraft {
  name: string;
  description: string;
  purpose: string;
  audience: string;
  personality: string;
}

export interface RuntimeCapabilities {
  runtime: "bun" | "cloudflare";
  features: Record<string, boolean>;
}

export interface WorkspaceData {
  principal: Principal;
  bots: Bot[];
  catalog: Skill[];
  capabilities: RuntimeCapabilities;
}
