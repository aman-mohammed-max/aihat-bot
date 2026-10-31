import type {
  Bot,
  BotMemoryRecord,
  BotAccessSettings,
  BotCollaborator,
  BotVersion,
  AuditLogEvent,
  CreationSession,
  CreationStep,
  ModelCatalogEntry,
  FactoryAssistantDraft,
  ConversationSummary,
  McpServer,
  McpTool,
  Principal,
  RuntimeCapabilities,
  ScheduledTask,
  Skill,
  TelegramSettings,
  StoredConversationMessage,
  TenantMember,
  TenantInvitation,
  WorkspaceMembership,
  UsageSummary,
  UploadedFile,
  ToolExecutionRecovery,
  BotOwnershipTransfer,
  PublicChatBot,
} from "./types.js";

export interface ChatLine {
  role: "user" | "assistant";
  content: string;
  attachments?: readonly { kind: "image"; url: string; alt?: string }[];
}

export interface UiState {
  route: string;
  page: string;
  botId?: string | undefined;
  botTab: string;
  principal?: Principal | undefined;
  bots: Bot[];
  botVersions: BotVersion[];
  catalog: Skill[];
  capabilities?: RuntimeCapabilities | undefined;
  activeBot?: Bot | undefined;
  botOwnershipTransfer: { item: BotOwnershipTransfer | null; token?: string };
  telegram?: TelegramSettings | undefined;
  installedSkills: Skill[];
  servers: McpServer[];
  toolsByServer: Record<string, McpTool[]>;
  tasks: ScheduledTask[];
  uploadedFiles: UploadedFile[];
  toolRecoveries: ToolExecutionRecovery[];
  conversations: ConversationSummary[];
  conversationMessages: StoredConversationMessage[];
  selectedConversationId?: string | undefined;
  conversationHasMore: boolean;
  memoryRecords: BotMemoryRecord[];
  botAccess?: BotAccessSettings | undefined;
  botCollaborators: BotCollaborator[];
  invitationToken?: string | undefined;
  usage?: UsageSummary | undefined;
  auditLogs: AuditLogEvent[];
  tenantMembers: TenantMember[];
  tenantMembersError?: string | undefined;
  tenantInvitations: TenantInvitation[];
  tenantInvitationsError?: string | undefined;
  newWorkspaceInvitation?: { invitationId: string; token: string; url: string; expiresAt: string } | undefined;
  workspaces: WorkspaceMembership[];
  workspacesError?: string | undefined;
  factorySession?: CreationSession | undefined;
  factoryModels: ModelCatalogEntry[];
  factoryModelsRole?: CreationStep | undefined;
  factoryModelsBusy: boolean;
  factoryAssistantBusy: boolean;
  factoryAssistantIdea: string;
  factoryAssistantDraft?: FactoryAssistantDraft | undefined;
  /** Held only in page memory between model discovery and encrypted storage. */
  pendingFactoryCredential?: string | undefined;
  chatLines: ChatLine[];
  chatConversationId?: string | undefined;
  publicChatBot?: PublicChatBot | undefined;
  publicChatSlug?: string | undefined;
  publicChatLines: ChatLine[];
  publicChatConversationId?: string | undefined;
  publicChatBusy: boolean;
  publicChatError?: string | undefined;
  selectedGrantUserId?: number | undefined;
  selectedGrantRefs: string[];
  factoryError?: string | undefined;
  pageError?: string | undefined;
  pending?: boolean | undefined;
  notice?: string | undefined;
  newToken?: { token: string; expiresAt: string; scopes: string[] } | undefined;
}

export function createInitialState(): UiState {
  return {
    route: "dashboard",
    page: "dashboard",
    botTab: "overview",
    bots: [],
    botVersions: [],
    catalog: [],
    installedSkills: [],
    servers: [],
    toolsByServer: {},
    tasks: [],
    uploadedFiles: [],
    toolRecoveries: [],
    conversations: [],
    conversationMessages: [],
    conversationHasMore: false,
    memoryRecords: [],
    auditLogs: [],
    tenantMembers: [],
    tenantInvitations: [],
    workspaces: [],
    factoryModels: [],
    factoryModelsBusy: false,
    factoryAssistantBusy: false,
    factoryAssistantIdea: "",
    botAccess: undefined,
    botCollaborators: [],
    botOwnershipTransfer: { item: null },
    invitationToken: undefined,
    chatLines: [],
    publicChatLines: [],
    publicChatBusy: false,
    selectedGrantRefs: [],
  };
}
