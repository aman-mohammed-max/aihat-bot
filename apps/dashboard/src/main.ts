import "./styles.css";
import { api, apiStream, ApiError, configureTokenReader, jsonBody } from "./api.js";
import { createInitialState, type UiState } from "./state.js";
import type {
  Bot,
  BotAccessSettings,
  BotCollaborator,
  BotVersion,
  BotMemoryRecord,
  AuditLogEvent,
  CreationSession,
  CreationStep,
  ConversationSummary,
  McpServer,
  McpTool,
  Principal,
  ScheduledTask,
  Skill,
  StoredConversationMessage,
  TelegramSettings,
  TenantMember,
  TenantInvitation,
  BotOwnershipTransfer,
  WorkspaceMembership,
  UsageSummary,
  UploadedFile,
  ToolExecutionRecovery,
  PublicChatBot,
} from "./types.js";
import { escapeHtml, icon } from "./view-utils.js";
import { botManagementView } from "./views/bot.js";
import { factoryView } from "./views/factory.js";
import { loginView, pageTitle, shell } from "./views/shell.js";
import { publicChatErrorView, publicChatLoginView, publicChatView } from "./views/public-chat.js";
import {
  apiAccessView,
  automationWorkspaceView,
  botsView,
  dashboardView,
  mcpWorkspaceView,
  securityView,
  skillMarketplaceView,
  usageView,
} from "./views/workspace.js";

declare global {
  interface Window {
    Telegram?: {
      Login?: {
        auth: (
          options: { client_id: string; scope: string[]; nonce: string },
          callback: (result: { id_token?: string; error?: string } | null) => void,
        ) => void;
      };
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
        setHeaderColor?: (color: string) => void;
        setBackgroundColor?: (color: string) => void;
        enableClosingConfirmation?: () => void;
      };
    };
  }
}

const TOKEN_KEY = "aihat.owner-token";
const SESSION_TOKEN_ID_KEY = "aihat.telegram-session-token-id";
const SESSION_KEY = "aihat.factory-session";
const WORKSPACE_INVITATION_KEY = "aihat.workspace-invitation";
const MCP_OAUTH_FLOW_KEY = "aihat.mcp-oauth-flow";
const MCP_OAUTH_CALLBACK_KEY = "aihat.mcp-oauth-callback";
const initialQuery = new URLSearchParams(location.search);
const linkedInvitation = initialQuery.get("invite");
if (linkedInvitation && /^ahf_invite_[A-Za-z0-9_-]{43}$/.test(linkedInvitation)) {
  sessionStorage.setItem(WORKSPACE_INVITATION_KEY, linkedInvitation);
  initialQuery.delete("invite");
  const remainingQuery = initialQuery.toString();
  history.replaceState(null, "", `${location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}${location.hash}`);
}
const oauthCallbackKeys = ["code", "state", "iss", "error", "error_description", "error_uri"];
if (oauthCallbackKeys.some((key) => initialQuery.has(key))) {
  const code = initialQuery.get("code");
  const oauthState = initialQuery.get("state");
  const issuer = initialQuery.get("iss");
  const denied = initialQuery.has("error");
  if (oauthState && oauthState.length <= 256 && ((code && code.length <= 8192 && !denied) || (!code && denied))) {
    sessionStorage.setItem(
      MCP_OAUTH_CALLBACK_KEY,
      JSON.stringify({ ...(code ? { code } : {}), state: oauthState, ...(issuer ? { issuer } : {}), denied }),
    );
  }
  for (const key of oauthCallbackKeys) initialQuery.delete(key);
  const remainingQuery = initialQuery.toString();
  history.replaceState(null, "", `${location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}${location.hash}`);
}
const app = getAppRoot();

const state: UiState = createInitialState();
let accessToken = sessionStorage.getItem(TOKEN_KEY) ?? "";
let activeBotResourcesId = "";
let activeBotVersionsId = "";
let activeConversationBotId = "";
let activeMemoryBotId = "";
let searchOpen = false;
let telegramLoginClientId = "";
configureTokenReader(() => accessToken);

window.Telegram?.WebApp?.ready?.();
window.Telegram?.WebApp?.expand?.();
window.Telegram?.WebApp?.setHeaderColor?.("#09131d");
window.Telegram?.WebApp?.setBackgroundColor?.("#09131d");

app.addEventListener("click", (event) => void handleClick(event));
app.addEventListener("submit", (event) => void handleSubmit(event));
app.addEventListener("change", (event) => void handleChange(event));
app.addEventListener("input", handleInput);
window.addEventListener("hashchange", () => void applyRoute());
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
  }
  if (event.key === "Escape") closeSearch();
});

void boot();

function getAppRoot(): HTMLElement {
  const element = document.getElementById("app");
  if (!element) throw new Error("Dashboard root element is missing.");
  return element;
}

async function boot(): Promise<void> {
  if (!accessToken && window.Telegram?.WebApp?.initData) {
    try {
      const session = await api<{ tokenId: string; token: string }>("/v1/auth/telegram", {
        method: "POST",
        body: jsonBody({ initData: window.Telegram.WebApp.initData }),
      });
      accessToken = session.token;
      sessionStorage.setItem(TOKEN_KEY, accessToken);
      sessionStorage.setItem(SESSION_TOKEN_ID_KEY, session.tokenId);
    } catch (error) {
      renderLogin(asMessage(error));
      return;
    }
  }
  if (!accessToken) {
    try {
      const loginConfig = await api<{ enabled: boolean; clientId?: string }>("/v1/auth/telegram/browser-config");
      telegramLoginClientId = loginConfig.enabled ? (loginConfig.clientId ?? "") : "";
    } catch {
      telegramLoginClientId = "";
    }
    await applyRoute();
    return;
  }
  try {
    state.principal = await api<Principal>("/v1/whoami");
    if (!getPublicChatSlug()) {
      await loadWorkspace();
      await restoreFactorySession();
    }
    await applyRoute();
    if (!getPublicChatSlug()) {
      await processMcpOAuthCallback();
      await acceptPendingWorkspaceInvitation();
    }
  } catch (error) {
    clearSession();
    renderLogin(asMessage(error));
  }
}

async function loadWorkspace(): Promise<void> {
  const [bots, catalog, capabilities] = await Promise.allSettled([
    api<Bot[]>("/v1/bots"),
    api<Skill[]>("/v1/skills"),
    api<{ runtime: "bun" | "cloudflare"; features: Record<string, boolean> }>("/capabilities"),
  ]);
  if (bots.status === "fulfilled") state.bots = bots.value;
  else if (bots.reason instanceof ApiError && bots.reason.status === 401) throw bots.reason;
  if (catalog.status === "fulfilled") state.catalog = catalog.value;
  if (capabilities.status === "fulfilled") state.capabilities = capabilities.value;
}

async function restoreFactorySession(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const linkedSessionId = params.get("factorySession");
  if (linkedSessionId && /^factory_[a-f0-9-]{36}$/.test(linkedSessionId)) {
    sessionStorage.setItem(SESSION_KEY, linkedSessionId);
  }
  const sessionId =
    linkedSessionId && /^factory_[a-f0-9-]{36}$/.test(linkedSessionId)
      ? linkedSessionId
      : sessionStorage.getItem(SESSION_KEY);
  if (linkedSessionId) {
    params.delete("factorySession");
    const remainingQuery = params.toString();
    history.replaceState(null, "", `${location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}${location.hash}`);
    if (!location.hash) location.hash = "#/create";
  }
  if (!sessionId) return;
  try {
    state.factorySession = await api<CreationSession>(`/v1/factory-sessions/${encodeURIComponent(sessionId)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
    sessionStorage.removeItem(SESSION_KEY);
  }
}

async function processMcpOAuthCallback(): Promise<void> {
  const rawCallback = sessionStorage.getItem(MCP_OAUTH_CALLBACK_KEY);
  if (!rawCallback) return;
  sessionStorage.removeItem(MCP_OAUTH_CALLBACK_KEY);
  const rawFlow = sessionStorage.getItem(MCP_OAUTH_FLOW_KEY);
  sessionStorage.removeItem(MCP_OAUTH_FLOW_KEY);
  let callback: { code?: string; state?: string; issuer?: string; denied?: boolean };
  let flow: { botId?: string; serverId?: string } | undefined;
  try {
    callback = JSON.parse(rawCallback) as typeof callback;
    flow = rawFlow ? (JSON.parse(rawFlow) as typeof flow) : undefined;
  } catch {
    showToast("The MCP authorization callback could not be verified. Start authorization again.");
    return;
  }
  if (
    !flow?.botId ||
    !/^bot_[a-f0-9-]{36}$/.test(flow.botId) ||
    !flow.serverId ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(flow.serverId) ||
    !callback.state
  ) {
    showToast("The MCP authorization callback could not be matched to a connection. Start authorization again.");
    return;
  }
  const callbackPath = `${botBase(flow.botId)}/mcp-servers/${encodeURIComponent(flow.serverId)}/oauth/callback`;
  try {
    if (callback.denied) {
      await api(`${callbackPath}`, {
        method: "POST",
        body: jsonBody({ state: callback.state, error: true }),
      });
      showToast("MCP authorization was cancelled.");
    } else {
      if (!callback.code || callback.code.length > 8192) throw new Error("Authorization callback is incomplete.");
      const result = await api<{ tools: McpTool[] }>(callbackPath, {
        method: "POST",
        body: jsonBody({
          code: callback.code,
          state: callback.state,
          ...(callback.issuer ? { issuer: callback.issuer } : {}),
        }),
      });
      showToast(`${result.tools.length} tools discovered; review before enabling`);
    }
    navigate(`bot/${flow.botId}/mcp`);
  } catch (error) {
    showToast(asMessage(error));
  }
}

async function applyRoute(): Promise<void> {
  const publicSlug = getPublicChatSlug();
  if (publicSlug) {
    if (state.publicChatSlug !== publicSlug) {
      state.publicChatSlug = publicSlug;
      state.publicChatBot = undefined;
      state.publicChatLines = [];
      state.publicChatConversationId = undefined;
      state.publicChatError = undefined;
    }
    state.route = `chat/${publicSlug}`;
    state.page = "public-chat";
    state.pageError = undefined;
    if (!state.publicChatBot && !state.publicChatError) await loadPublicChat(publicSlug);
    render();
    return;
  }
  const previousPage = state.page;
  const route = location.hash.replace(/^#\/?/, "") || "dashboard";
  state.route = route;
  const segments = route.split("/").map(decodeURIComponent);
  state.page = segments[0] ?? "dashboard";
  state.botId = state.page === "bot" ? segments[1] : undefined;
  state.botTab = state.page === "bot" ? (segments[2] ?? "overview") : "overview";
  state.pageError = undefined;
  state.notice = undefined;
  if (previousPage === "api" && state.page !== "api") state.newToken = undefined;

  if (!accessToken) {
    render();
    return;
  }
  if (state.page === "bot" && state.botId) {
    if (activeBotResourcesId !== state.botId) await loadBotResources(state.botId);
    if (state.activeBot?.collaboratorRole && !["overview", "configuration"].includes(state.botTab)) {
      state.botTab = "overview";
      const safeHash = `#/bot/${encodeURIComponent(state.botId)}/overview`;
      history.replaceState(null, "", `${location.pathname}${location.search}${safeHash}`);
      state.route = safeHash.slice(2);
    }
    if (state.botTab === "versions") {
      try {
        if (activeBotVersionsId !== state.botId) await loadBotVersions(state.botId);
      } catch (error) {
        state.pageError = asMessage(error);
      }
    }
    if (state.botTab === "conversations") {
      try {
        if (activeConversationBotId !== state.botId) await loadConversationList(state.botId);
        const requestedId = segments[3];
        const selectedId = requestedId ?? state.selectedConversationId ?? state.conversations[0]?.id;
        if (selectedId && selectedId !== state.selectedConversationId) {
          await loadConversationMessages(state.botId, selectedId);
        } else if (selectedId && state.conversationMessages.length === 0) {
          await loadConversationMessages(state.botId, selectedId);
        }
        if (!selectedId) {
          state.selectedConversationId = undefined;
          state.conversationMessages = [];
          state.conversationHasMore = false;
        }
      } catch (error) {
        state.pageError = asMessage(error);
      }
    }
    if (state.botTab === "memory") {
      try {
        if (activeMemoryBotId !== state.botId) await loadMemoryRecords(state.botId);
      } catch (error) {
        state.pageError = asMessage(error);
      }
    }
    if (state.botTab === "access") {
      try {
        await Promise.all([loadBotAccess(state.botId), loadBotCollaborators(state.botId)]);
      } catch (error) {
        state.pageError = asMessage(error);
      }
    }
  } else if (["mcp", "automation", "skills"].includes(state.page)) {
    const ownedBots = state.bots.filter((bot) => !bot.collaboratorRole);
    const selected = ownedBots.find((bot) => bot.id === state.botId)?.id ?? ownedBots[0]?.id;
    state.botId = selected;
    if (selected && activeBotResourcesId !== selected) await loadBotResources(selected);
  }
  if (state.page === "usage") {
    try {
      state.usage = await api<UsageSummary>("/v1/usage?days=30");
    } catch (error) {
      state.usage = undefined;
      state.pageError = asMessage(error);
    }
  }
  if (state.page === "security") {
    try {
      const response = await api<{ items: AuditLogEvent[] }>("/v1/audit-logs?limit=25");
      state.auditLogs = response.items;
    } catch (error) {
      state.auditLogs = [];
      state.pageError = asMessage(error);
    }
    state.tenantMembers = [];
    state.tenantMembersError = undefined;
    state.tenantInvitations = [];
    state.tenantInvitationsError = undefined;
    state.newWorkspaceInvitation = undefined;
    if (state.principal?.scopes.includes("members:manage")) {
      try {
        const response = await api<{ items: TenantMember[] }>("/v1/members");
        state.tenantMembers = response.items;
      } catch (error) {
        state.tenantMembersError = asMessage(error);
      }
      try {
        const response = await api<{ items: TenantInvitation[] }>("/v1/invitations");
        state.tenantInvitations = response.items;
      } catch (error) {
        state.tenantInvitationsError = asMessage(error);
      }
    }
    state.workspaces = [];
    state.workspacesError = undefined;
    try {
      const response = await api<{ items: WorkspaceMembership[] }>("/v1/workspaces");
      state.workspaces = response.items;
    } catch (error) {
      state.workspacesError = asMessage(error);
    }
  }
  if (state.page === "create" && !state.factorySession) {
    await restoreFactorySession().catch((error: unknown) => setError(error));
  }
  render();
}

async function loadBotResources(botId: string): Promise<void> {
  if (activeBotResourcesId !== botId) {
    activeConversationBotId = "";
    activeMemoryBotId = "";
    activeBotVersionsId = "";
    state.conversations = [];
    state.conversationMessages = [];
    state.selectedConversationId = undefined;
    state.conversationHasMore = false;
    state.memoryRecords = [];
    state.botVersions = [];
    state.uploadedFiles = [];
    state.toolRecoveries = [];
    state.botAccess = undefined;
    state.botCollaborators = [];
    state.invitationToken = undefined;
  }
  activeBotResourcesId = botId;
  const base = `/v1/bots/${encodeURIComponent(botId)}`;
  if (state.bots.find((bot) => bot.id === botId)?.collaboratorRole) {
    try {
      state.activeBot = await api<Bot>(base);
      state.pageError = undefined;
    } catch (error) {
      state.activeBot = undefined;
      state.pageError = asMessage(error);
    }
    state.telegram = undefined;
    state.installedSkills = [];
    state.servers = [];
    state.toolsByServer = {};
    state.tasks = [];
    state.uploadedFiles = [];
    state.toolRecoveries = [];
    state.botAccess = undefined;
    state.botCollaborators = [];
    state.botOwnershipTransfer = { item: null };
    return;
  }
  const [bot, telegram, skills, servers, tasks, files, toolRecoveries, ownershipTransfer] = await Promise.allSettled([
    api<Bot>(base),
    api<TelegramSettings>(`${base}/telegram`),
    api<Skill[]>(`${base}/skills`),
    api<McpServer[]>(`${base}/mcp-servers`),
    api<{ tasks: ScheduledTask[] }>(`${base}/scheduled-tasks`),
    api<{ items: UploadedFile[] }>(`${base}/files`),
    api<{ recoveries: ToolExecutionRecovery[] }>(`${base}/tool-executions`),
    api<{ item: BotOwnershipTransfer | null }>(`${base}/ownership-transfer`),
  ]);
  state.pageError = undefined;
  if (bot.status === "fulfilled") state.activeBot = bot.value;
  else {
    state.activeBot = undefined;
    state.pageError = asMessage(bot.reason);
  }
  state.telegram = telegram.status === "fulfilled" ? telegram.value : undefined;
  state.installedSkills = skills.status === "fulfilled" ? skills.value : [];
  state.servers = servers.status === "fulfilled" ? servers.value : [];
  state.tasks = tasks.status === "fulfilled" ? tasks.value.tasks : [];
  state.uploadedFiles = files.status === "fulfilled" ? files.value.items : [];
  state.toolRecoveries = toolRecoveries.status === "fulfilled" ? toolRecoveries.value.recoveries : [];
  state.botOwnershipTransfer =
    ownershipTransfer.status === "fulfilled" ? { item: ownershipTransfer.value.item } : { item: null };
  state.botCollaborators = [];
  const tools = await Promise.all(
    state.servers
      .filter((server) => server.status === "connected")
      .map(async (server) => {
        try {
          const result = await api<McpTool[]>(`${base}/mcp-servers/${encodeURIComponent(server.id)}/tools`);
          return [server.id, result] as const;
        } catch {
          return [server.id, []] as const;
        }
      }),
  );
  state.toolsByServer = Object.fromEntries(tools);
}

async function loadBotAccess(botId: string): Promise<void> {
  state.botAccess = await api<BotAccessSettings>(`${botBase(botId)}/access`);
}

async function loadBotCollaborators(botId: string): Promise<void> {
  const response = await api<{ items: BotCollaborator[] }>(`${botBase(botId)}/collaborators`);
  state.botCollaborators = response.items;
}

async function loadBotVersions(botId: string): Promise<void> {
  const result = await api<{ items: BotVersion[] }>(`${botBase(botId)}/versions?limit=100`);
  state.botVersions = result.items;
  activeBotVersionsId = botId;
}

async function loadConversationList(botId: string): Promise<void> {
  const result = await api<{ items: ConversationSummary[] }>(`${botBase(botId)}/conversations?limit=100`);
  state.conversations = result.items;
  activeConversationBotId = botId;
}

async function loadMemoryRecords(botId: string): Promise<void> {
  const result = await api<{ items: BotMemoryRecord[] }>(`${botBase(botId)}/memory`);
  state.memoryRecords = result.items;
  activeMemoryBotId = botId;
}

async function loadConversationMessages(botId: string, conversationId: string): Promise<void> {
  state.selectedConversationId = conversationId;
  state.conversationMessages = [];
  state.conversationHasMore = false;
  const page = await api<{ items: StoredConversationMessage[]; hasMore: boolean }>(
    `${botBase(botId)}/conversations/${encodeURIComponent(conversationId)}/messages?limit=100`,
  );
  state.conversationMessages = page.items;
  state.conversationHasMore = page.hasMore;
}

async function loadOlderConversationMessages(): Promise<void> {
  const bot = requireActiveBot();
  const conversationId = state.selectedConversationId;
  const firstSequence = state.conversationMessages[0]?.sequence;
  if (!conversationId || firstSequence === undefined || !state.conversationHasMore) return;
  const page = await api<{ items: StoredConversationMessage[]; hasMore: boolean }>(
    `${botBase(bot.id)}/conversations/${encodeURIComponent(conversationId)}/messages?limit=100&beforeSequence=${firstSequence}`,
  );
  state.conversationMessages = [...page.items, ...state.conversationMessages];
  state.conversationHasMore = page.hasMore;
  render();
}

async function deleteConversation(): Promise<void> {
  const bot = requireActiveBot();
  const conversationId = state.selectedConversationId;
  const selected = state.conversations.find((conversation) => conversation.id === conversationId);
  if (!conversationId || !selected) throw new Error("Choose a conversation first.");
  if (
    !(await askConfirmation(
      "Delete this conversation?",
      "This permanently deletes the conversation and its stored messages. This cannot be undone.",
      "Delete conversation",
      true,
    ))
  ) {
    return;
  }
  await api(`${botBase(bot.id)}/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
  state.conversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
  state.selectedConversationId = undefined;
  state.conversationMessages = [];
  state.conversationHasMore = false;
  activeConversationBotId = "";
  navigate(`bot/${encodeURIComponent(bot.id)}/conversations`);
  showToast("Conversation deleted");
}

function render(): void {
  if (getPublicChatSlug()) {
    if (!state.publicChatBot && state.publicChatError) {
      app.innerHTML = publicChatErrorView(state.publicChatError);
    } else if (!accessToken || !state.principal) {
      app.innerHTML = publicChatLoginView(
        state.publicChatBot,
        state.publicChatError ?? state.pageError ?? "",
        telegramLoginClientId,
      );
    } else if (state.publicChatBot) {
      const chatError = state.publicChatError ?? state.pageError;
      app.innerHTML = publicChatView({
        bot: state.publicChatBot,
        lines: state.publicChatLines,
        busy: state.publicChatBusy,
        ...(chatError ? { error: chatError } : {}),
      });
    } else {
      app.innerHTML = publicChatErrorView(state.publicChatError ?? "Loading public chat…");
    }
    return;
  }
  if (!accessToken || !state.principal) {
    app.innerHTML = loginView("", telegramLoginClientId);
    return;
  }
  const { title, subtitle } = pageTitle(state.page, state.activeBot?.name);
  let body: string;
  switch (state.page) {
    case "bots":
      body = botsView(state);
      break;
    case "create":
      body = factoryView(
        state.factorySession,
        state.factoryError,
        state.factoryModels,
        state.factoryModelsRole,
        state.factoryModelsBusy,
        state.pendingFactoryCredential,
      );
      body += factoryAssistantView();
      break;
    case "bot":
      body = botManagementView(state);
      break;
    case "skills":
      body = skillMarketplaceView(state);
      break;
    case "mcp":
      body = mcpWorkspaceView(state);
      break;
    case "automation":
      body = automationWorkspaceView(state);
      break;
    case "api":
      body = apiAccessView(state);
      break;
    case "security":
      body = securityView(state);
      break;
    case "usage":
      body = usageView(state.usage);
      break;
    default:
      body = dashboardView(state);
  }
  app.innerHTML = shell(state, title, subtitle, body);
  if (searchOpen) renderSearch();
}

function factoryAssistantView(): string {
  const draft = state.factoryAssistantDraft;
  const session = state.factorySession;
  if (session) {
    if (
      !draft ||
      session.status !== "in_progress" ||
      !["name", "description", "purpose", "audience", "personality"].includes(session.currentStep ?? "")
    ) {
      return "";
    }
    return `<section class='factory-ai-continue'><div><b>AI draft ready</b><small>Continue filling the creative fields from your reviewed draft.</small></div><button class='button button-secondary' data-action='apply-factory-assistant' ${state.factoryAssistantBusy ? "disabled" : ""}>${icon("spark", 15)}<span>${state.factoryAssistantBusy ? "Applying draft…" : "Continue with AI draft"}</span></button></section>`;
  }
  if (draft) {
    return `<section class='factory-ai-panel'><div class='eyebrow'>AI GENERATED DRAFT</div><h3>${escapeHtml(draft.name)}</h3><p>${escapeHtml(draft.description)}</p><details><summary>Review purpose, audience, and personality</summary><dl><dt>Purpose</dt><dd>${escapeHtml(draft.purpose)}</dd><dt>Audience</dt><dd>${escapeHtml(draft.audience)}</dd><dt>Personality prompt</dt><dd>${escapeHtml(draft.personality)}</dd></dl></details><div class='factory-ai-actions'><button class='button button-primary' data-action='apply-factory-assistant' ${state.factoryAssistantBusy ? "disabled" : ""}>${icon("spark", 15)}<span>${state.factoryAssistantBusy ? "Starting setup…" : "Use this draft"}</span></button><button class='text-button' data-action='discard-factory-assistant' ${state.factoryAssistantBusy ? "disabled" : ""}>Discard</button></div></section>`;
  }
  return `<section class='factory-ai-panel'><div class='eyebrow'>AI BOT DRAFTER</div><h3>Start with an idea</h3><p>Describe the assistant you want. The factory AI will draft its creative profile for you to review.</p><form id='factory-assist-form' class='factory-ai-form'><label class='field'><span>What should your bot do?</span><textarea name='idea' rows='4' maxlength='4000' required placeholder='A friendly support bot for my online store that answers shipping and returns questions…'>${escapeHtml(state.factoryAssistantIdea)}</textarea></label><button class='button button-secondary' type='submit' ${state.factoryAssistantBusy ? "disabled" : ""}>${icon("spark", 15)}<span>${state.factoryAssistantBusy ? "Drafting bot…" : "Generate a bot draft with AI"}</span></button><small>AI drafts the name, description, purpose, audience, and personality. You choose the provider, models, credentials, access, and publishing.</small></form></section>`;
}

function renderLogin(error = ""): void {
  if (app) {
    app.innerHTML = getPublicChatSlug()
      ? publicChatLoginView(state.publicChatBot, error, telegramLoginClientId)
      : loginView(error, telegramLoginClientId);
  }
}

async function handleClick(event: MouseEvent): Promise<void> {
  const target =
    event.target instanceof Element ? event.target.closest<HTMLElement>("[data-route], [data-action]") : null;
  if (!target) return;
  const route = target.dataset.route;
  if (route) {
    event.preventDefault();
    navigate(route);
    return;
  }
  const action = target.dataset.action;
  if (!action) return;
  event.preventDefault();

  try {
    if (action === "sign-out") {
      await signOut();
      renderLogin();
    } else if (action === "telegram-login") {
      await loginWithTelegram();
    } else if (action === "navigate-create") navigate("create");
    else if (action === "navigate-bots") navigate("bots");
    else if (action === "open-search") openSearch();
    else if (action === "toggle-menu") document.getElementById("sidebar")?.classList.toggle("sidebar-open");
    else if (action === "copy-miniapp-url") await copyText(`${location.origin}/miniapp/`, "Mini App URL copied");
    else if (action === "copy-public-web-chat") {
      await copyText(target.dataset.url ?? "", "Public Web Chat link copied");
    } else if (action === "switch-workspace") await switchWorkspace(target.dataset.tenantId ?? "");
    else if (action === "copy-workspace-invitation") {
      await copyText(state.newWorkspaceInvitation?.url ?? "", "Workspace invitation link copied");
    } else if (action === "copy-workspace-invitation-token") {
      await copyText(state.newWorkspaceInvitation?.token ?? "", "Workspace invitation token copied");
    } else if (action === "copy-bot-ownership-token") {
      await copyText(state.botOwnershipTransfer.token ?? "", "Ownership transfer token copied");
    } else if (action === "revoke-bot-ownership-transfer") {
      await revokeBotOwnershipTransfer(target.dataset.transferId ?? "");
    } else if (action === "revoke-workspace-invitation") {
      await revokeWorkspaceInvitation(target.dataset.invitationId ?? "");
    } else if (action === "deactivate-tenant-member") await deactivateTenantMember(target.dataset.userId ?? "");
    else if (action === "reactivate-tenant-member") {
      await reactivateTenantMember(target.dataset.userId ?? "", target.dataset.role ?? "member");
    } else if (action === "copy-invitation") await copyText(state.invitationToken ?? "", "Invitation token copied");
    else if (action === "copy-new-token") await copyText(state.newToken?.token ?? "", "Token copied");
    else if (action === "dismiss-token") {
      state.newToken = undefined;
      render();
    } else if (action === "start-factory" || action === "new-factory") await startFactory();
    else if (action === "apply-factory-assistant") await applyFactoryAssistantDraft();
    else if (action === "discard-factory-assistant") {
      state.factoryAssistantDraft = undefined;
      state.factoryAssistantIdea = "";
      state.factoryError = undefined;
      render();
    } else if (action === "load-factory-models") {
      const roleStep =
        target.dataset.modelRole === "image"
          ? "imageModel"
          : target.dataset.modelRole === "search"
            ? "searchModel"
            : "model";
      await loadFactoryModels(roleStep);
    } else if (action === "pause-factory") await updateFactory("pause");
    else if (action === "resume-factory") await updateFactory("resume");
    else if (action === "save-factory-draft") await saveFactoryDraft();
    else if (action === "publish-factory") await publishFactory();
    else if (action === "disable-bot" || action === "enable-bot") await toggleBot(action === "disable-bot");
    else if (action === "disconnect-telegram") await disconnectTelegram();
    else if (action === "delete-bot") await deleteBot();
    else if (action === "scan-uploaded-file") await scanUploadedFile(target.dataset.fileId ?? "");
    else if (action === "delete-uploaded-file") await deleteUploadedFile(target.dataset.fileId ?? "");
    else if (action === "download-uploaded-file") await downloadUploadedFile(target.dataset.fileId ?? "");
    else if (action === "reload-tool-recoveries") await loadToolRecoveries(requireActiveBot().id);
    else if (action === "resolve-tool-recovery") {
      await resolveToolRecovery(target.dataset.executionKey ?? "", target.dataset.resolution ?? "");
    } else if (action.startsWith("mcp-connect:")) await connectMcp(action.slice("mcp-connect:".length));
    else if (action.startsWith("mcp-oauth-start:")) await startMcpOAuth(action.slice("mcp-oauth-start:".length));
    else if (action.startsWith("mcp-delete:")) await deleteMcp(action.slice("mcp-delete:".length));
    else if (action === "toggle-mcp-tool") await toggleMcpTool(target);
    else if (action === "toggle-skill") await toggleSkill(target);
    else if (action === "uninstall-skill") await uninstallSkill(target.dataset.skillId ?? "");
    else if (action === "install-skill-no-permission") await installSkill(target.dataset.skillId ?? "", []);
    else if (action === "load-telegram-grants") await loadTelegramGrants(Number(target.dataset.userId));
    else if (action === "load-older-conversation-messages") await loadOlderConversationMessages();
    else if (action === "delete-conversation") await deleteConversation();
    else if (action === "revoke-bot-grant") await revokeBotGrant(target.dataset.grantId ?? "");
    else if (action === "remove-bot-collaborator") await removeBotCollaborator(target.dataset.userId ?? "");
    else if (action === "delete-memory-record") await deleteBotMemory(target.dataset.memoryKey ?? "");
    else if (action === "toggle-task") await toggleTask(target);
    else if (action === "retry-task") await retryScheduledTask(target);
    else if (action === "dismiss-search") closeSearch();
    else if (action === "search-goto") {
      const destination = target.dataset.destination;
      if (destination) navigate(destination);
      closeSearch();
    }
  } catch (error) {
    if (action === "telegram-login") {
      clearSession();
      renderLogin(asMessage(error));
      return;
    }
    setError(error);
  }
}

async function loginWithTelegram(): Promise<void> {
  if (!telegramLoginClientId || !window.Telegram?.Login?.auth) {
    throw new Error("Telegram sign-in is unavailable. Refresh the page and try again.");
  }
  const challenge = await api<{ nonce: string }>("/v1/auth/telegram/browser-nonce", {
    method: "POST",
    body: jsonBody({}),
  });
  const result = await new Promise<{ id_token?: string; error?: string } | null>((resolve, reject) => {
    try {
      window.Telegram?.Login?.auth(
        { client_id: telegramLoginClientId, scope: ["profile"], nonce: challenge.nonce },
        (response) => {
          if (response?.error) reject(new Error("Telegram sign-in was cancelled or could not be completed."));
          else resolve(response ?? null);
        },
      );
    } catch (error) {
      reject(error);
    }
  });
  if (!result?.id_token) throw new Error("Telegram did not return a valid sign-in. Try again.");
  const session = await api<{ tokenId: string; token: string }>("/v1/auth/telegram/browser", {
    method: "POST",
    body: jsonBody({ idToken: result.id_token }),
  });
  await logIn(session.token);
  sessionStorage.setItem(SESSION_TOKEN_ID_KEY, session.tokenId);
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const data = new FormData(form);
  try {
    switch (form.dataset.form ?? form.id) {
      case "login-form":
        await logIn(String(data.get("token") ?? "").trim());
        break;
      case "factory-answer-form":
        await submitFactoryAnswer(form, data);
        break;
      case "factory-assist-form":
        await generateFactoryAssistantDraft(String(data.get("idea") ?? ""));
        break;
      case "tenant-member-add-form":
        await addTenantMember(data);
        form.reset();
        break;
      case "tenant-invitation-form":
        await createWorkspaceInvitation(data);
        form.reset();
        break;
      case "workspace-invitation-accept-form":
        await acceptWorkspaceInvitation(String(data.get("token") ?? "").trim());
        form.reset();
        break;
      case "bot-ownership-transfer-form":
        await createBotOwnershipTransfer(data);
        form.reset();
        break;
      case "bot-transfer-accept-form":
        await acceptBotOwnershipTransfer(String(data.get("token") ?? "").trim());
        form.reset();
        break;
      case "tenant-member-role-form":
        await updateTenantMemberRole(form.dataset.userId ?? "", String(data.get("role") ?? ""));
        break;
      case "bot-config-form":
        await saveBotSettings(data);
        break;
      case "bot-credential-form":
        await rotateBotCredential(data);
        form.reset();
        break;
      case "bot-model-form":
        await configureBotModel(data);
        form.reset();
        break;
      case "bot-retry-policy-form":
        await configureBotRetryPolicy(data);
        break;
      case "bot-access-policy-form":
        await saveBotAccessPolicy(data);
        break;
      case "bot-user-grant-form":
        await createBotAccessGrant(data, false);
        form.reset();
        break;
      case "bot-collaborator-form":
        await saveBotCollaborator(data);
        form.reset();
        break;
      case "bot-invitation-form":
        await createBotAccessGrant(data, true);
        form.reset();
        break;
      case "telegram-connect-form":
        await connectTelegram(String(data.get("token") ?? ""));
        break;
      case "telegram-allowlist-form":
        await saveTelegramAllowlist(data);
        break;
      case "telegram-grants-form":
        await saveTelegramGrants(form, data);
        break;
      case "install-skill":
        await installSkill(form.dataset.skillId ?? "", data.getAll("grants").map(String));
        break;
      case "skill-publish-form":
        await publishSkill(data);
        break;
      case "mcp-add-form":
        await addMcpServer(data);
        break;
      case "schedule-form":
        await createSchedule(data);
        break;
      case "new-token-form":
        await createToken(data);
        break;
      case "chat-form":
        await sendChat(data);
        break;
      case "public-chat-form":
        await sendPublicChat(data);
        break;
      case "memory-toggle-form":
        await toggleBotMemory(data);
        break;
      case "memory-record-form":
        await saveBotMemory(data);
        break;
      case "uploaded-file-form":
        await uploadBotFiles(data);
        form.reset();
        break;
    }
  } catch (error) {
    if (form.id === "login-form") {
      accessToken = "";
      configureTokenReader(() => accessToken);
      renderLogin(asMessage(error));
      return;
    }
    setError(error, form.id === "factory-answer-form");
  }
}

async function handleChange(event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.id === "mcp-auth-mode") {
    const form = target.form;
    if (!form) return;
    for (const fields of form.querySelectorAll<HTMLElement>("[data-mcp-auth-fields]")) {
      const active = fields.dataset.mcpAuthFields === target.value;
      fields.hidden = !active;
      for (const input of fields.querySelectorAll<HTMLInputElement>("input")) {
        input.required =
          active &&
          (["mcpBearerToken", "mcpClientId", "mcpIssuer", "mcpCodeClientId", "mcpCodeIssuer"].includes(input.name) ||
            (target.value === "oauth_client_credentials" && input.name === "mcpClientSecret"));
      }
    }
    return;
  }
  const selectorMap: Record<string, string> = {
    "skill-target-bot": "skills",
    "mcp-target-bot": "mcp",
    "automation-target-bot": "automation",
  };
  const page = selectorMap[target.id];
  if (page) {
    state.botId = target.value;
    await loadBotResources(target.value);
    render();
    return;
  }
  if (target.name === "repeat") {
    const oneTime = document.querySelector<HTMLElement>("[data-schedule-once]");
    const daily = document.querySelector<HTMLElement>("[data-schedule-daily]");
    if (oneTime) oneTime.hidden = target.value !== "once";
    if (daily) daily.hidden = target.value !== "daily";
  }
}

function handleInput(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === "bot-filter") {
    const query = target.value.trim().toLowerCase();
    document.querySelectorAll<HTMLElement>("[data-bot-card]").forEach((card) => {
      card.hidden = !card.dataset.botCard?.includes(query);
    });
  }
  if (target instanceof HTMLInputElement && target.id === "workspace-search") updateSearchResults(target.value);
}

async function logIn(token: string): Promise<void> {
  accessToken = token;
  configureTokenReader(() => accessToken);
  sessionStorage.removeItem(SESSION_TOKEN_ID_KEY);
  const identity = await api<Principal>("/v1/whoami");
  state.principal = identity;
  sessionStorage.setItem(TOKEN_KEY, token);
  state.pageError = undefined;
  if (!getPublicChatSlug()) {
    await loadWorkspace();
    await restoreFactorySession();
  }
  await applyRoute();
  if (!getPublicChatSlug()) {
    await processMcpOAuthCallback();
    await acceptPendingWorkspaceInvitation();
  }
}

function clearSession(): void {
  accessToken = "";
  state.principal = undefined;
  state.bots = [];
  state.uploadedFiles = [];
  state.catalog = [];
  state.activeBot = undefined;
  state.newToken = undefined;
  state.factorySession = undefined;
  state.factoryAssistantDraft = undefined;
  state.factoryAssistantIdea = "";
  state.factoryAssistantBusy = false;
  state.factoryModels = [];
  state.factoryModelsRole = undefined;
  state.factoryModelsBusy = false;
  state.pendingFactoryCredential = undefined;
  state.tenantMembers = [];
  state.tenantMembersError = undefined;
  state.tenantInvitations = [];
  state.tenantInvitationsError = undefined;
  state.newWorkspaceInvitation = undefined;
  state.workspaces = [];
  state.workspacesError = undefined;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(SESSION_TOKEN_ID_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

async function signOut(): Promise<void> {
  const tokenId = sessionStorage.getItem(SESSION_TOKEN_ID_KEY);
  if (tokenId && accessToken) {
    await api(`/v1/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" }).catch(() => undefined);
  }
  clearSession();
}

async function startFactory(): Promise<void> {
  state.factoryError = undefined;
  state.factoryAssistantDraft = undefined;
  state.factoryModels = [];
  state.factoryModelsRole = undefined;
  state.pendingFactoryCredential = undefined;
  state.factorySession = await api<CreationSession>("/v1/factory-sessions", { method: "POST" });
  sessionStorage.setItem(SESSION_KEY, state.factorySession.id);
  navigate("create");
}

async function generateFactoryAssistantDraft(idea: string): Promise<void> {
  state.factoryAssistantIdea = idea;
  state.factoryAssistantBusy = true;
  state.factoryError = undefined;
  render();
  try {
    const result = await api<{ draft: UiState["factoryAssistantDraft"] }>("/v1/factory-assist/generate", {
      method: "POST",
      body: jsonBody({ idea }),
    });
    if (!result.draft) throw new Error("The assistant did not return a bot draft.");
    state.factoryAssistantDraft = result.draft;
  } catch (error) {
    state.factoryError = asMessage(error);
  } finally {
    state.factoryAssistantBusy = false;
    render();
  }
}

async function applyFactoryAssistantDraft(): Promise<void> {
  const draft = state.factoryAssistantDraft;
  if (!draft) throw new Error("Generate a bot draft first.");
  state.factoryAssistantBusy = true;
  state.factoryError = undefined;
  render();
  try {
    let session = state.factorySession;
    if (!session) {
      session = await api<CreationSession>("/v1/factory-sessions", { method: "POST" });
      state.factorySession = session;
      sessionStorage.setItem(SESSION_KEY, session.id);
    }
    if (session.status === "paused") {
      session = await api<CreationSession>(`/v1/factory-sessions/${encodeURIComponent(session.id)}/resume`, {
        method: "POST",
      });
      state.factorySession = session;
    }
    const generatedFields = [
      ["name", draft.name],
      ["description", draft.description],
      ["purpose", draft.purpose],
      ["audience", draft.audience],
      ["personality", draft.personality],
    ] as const;
    for (const [step, value] of generatedFields) {
      if (session.currentStep !== step) continue;
      session = await api<CreationSession>(`/v1/factory-sessions/${encodeURIComponent(session.id)}/answer`, {
        method: "POST",
        body: jsonBody({ step, value }),
      });
      state.factorySession = session;
    }
    state.factoryAssistantDraft = undefined;
    state.factoryAssistantIdea = "";
    state.factoryError = undefined;
  } catch (error) {
    state.factoryError = asMessage(error);
  } finally {
    state.factoryAssistantBusy = false;
    render();
  }
}

async function loadFactoryModels(roleStep?: CreationStep): Promise<void> {
  const session = requireFactorySession();
  const step = roleStep ?? session.currentStep;
  const role =
    step === "model" ? "chat" : step === "imageModel" ? "image" : step === "searchModel" ? "search" : undefined;
  if (!role || step !== session.currentStep) {
    throw new Error("Model discovery is only available at the current model selection step.");
  }
  const form = document.getElementById("factory-answer-form");
  const formData = form instanceof HTMLFormElement ? new FormData(form) : undefined;
  const temporaryCredential = role === "chat" ? String(formData?.get("discoveryCredential") ?? "").trim() : "";
  if (role === "chat" && !temporaryCredential && !state.pendingFactoryCredential) {
    throw new Error("Enter the provider API key to fetch its models, or type the model ID manually.");
  }
  if (temporaryCredential) state.pendingFactoryCredential = temporaryCredential;
  state.factoryModelsBusy = true;
  state.factoryModelsRole = step ?? undefined;
  state.factoryError = undefined;
  render();
  try {
    const result = await api<{ models: UiState["factoryModels"] }>(
      `/v1/factory-sessions/${encodeURIComponent(session.id)}/models`,
      {
        method: "POST",
        body: jsonBody({ role, ...(temporaryCredential ? { credential: temporaryCredential } : {}) }),
      },
    );
    state.factoryModels = result.models;
    if (!result.models.length) {
      state.factoryError =
        role === "image"
          ? "No image models were listed. Type an unlisted model ID or leave this optional step blank."
          : "This endpoint did not list models. You can still type a model ID manually.";
    }
  } catch (error) {
    state.factoryError = asMessage(error);
  } finally {
    state.factoryModelsBusy = false;
    render();
  }
}

async function updateFactory(action: "pause" | "resume"): Promise<void> {
  const session = requireFactorySession();
  state.factorySession = await api<CreationSession>(
    `/v1/factory-sessions/${encodeURIComponent(session.id)}/${action}`,
    { method: "POST" },
  );
  render();
}

async function submitFactoryAnswer(form: HTMLFormElement, data: FormData): Promise<void> {
  const session = requireFactorySession();
  const step = form.dataset.step;
  if (!step) throw new Error("The current setup step is missing.");
  if (step === "credentialRef") {
    const credential = String(data.get("value") ?? state.pendingFactoryCredential ?? "");
    const confirmed = await askConfirmation(
      "Encrypt model credentials",
      "This will send the key once over HTTPS and store it encrypted for this bot. The dashboard will not keep the plaintext.",
      "Encrypt key",
    );
    if (!confirmed) return;
    const approval = await api<{ approvalId: string }>(
      `/v1/factory-sessions/${encodeURIComponent(session.id)}/approvals`,
      { method: "POST" },
    );
    state.factorySession = await api<CreationSession>(
      `/v1/factory-sessions/${encodeURIComponent(session.id)}/credentials`,
      { method: "POST", body: jsonBody({ credential, approvalId: approval.approvalId }) },
    );
    state.factoryError = undefined;
    state.pendingFactoryCredential = undefined;
    render();
    return;
  }

  let value: unknown = data.get("value");
  const customModel = String(data.get("customModel") ?? "").trim();
  if (["model", "imageModel", "searchModel"].includes(step) && customModel) value = customModel;
  if (step === "model") {
    const temporaryCredential = String(data.get("discoveryCredential") ?? "").trim();
    if (temporaryCredential) state.pendingFactoryCredential = temporaryCredential;
  }
  if (["skills", "mcpConnections", "integrations", "scheduledTasks", "privacySettings"].includes(step)) {
    value = String(value ?? "")
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  } else if (step === "memoryEnabled") {
    value = value === "true";
  } else if (step === "interfaces") {
    value = data.getAll("value").map(String);
  }

  let approvalId: string | undefined;
  if (step === "visibility" && value !== "private") {
    const label = String(value);
    if (
      !(await askConfirmation(
        "Confirm wider access",
        `You selected ${label} visibility. This changes who may use the bot after it is published. Continue?`,
        "Confirm visibility",
      ))
    )
      return;
    const approval = await api<{ approvalId: string }>(
      `/v1/factory-sessions/${encodeURIComponent(session.id)}/approvals`,
      { method: "POST" },
    );
    approvalId = approval.approvalId;
  }
  state.factorySession = await api<CreationSession>(`/v1/factory-sessions/${encodeURIComponent(session.id)}/answer`, {
    method: "POST",
    body: jsonBody({ step, value, ...(approvalId ? { approvalId } : {}) }),
  });
  state.factoryError = undefined;
  render();
}

async function saveFactoryDraft(): Promise<void> {
  const session = requireFactorySession();
  state.factorySession = await api<CreationSession>(`/v1/factory-sessions/${encodeURIComponent(session.id)}/draft`, {
    method: "POST",
  });
  await loadWorkspace();
  render();
  showToast("Private draft saved");
}

async function publishFactory(): Promise<void> {
  const session = requireFactorySession();
  if (
    !(await askConfirmation(
      "Publish this bot?",
      "Publishing makes the configured bot available according to its selected visibility. You can disable it later.",
      "Publish bot",
    ))
  )
    return;
  const approval = await api<{ approvalId: string }>(
    `/v1/factory-sessions/${encodeURIComponent(session.id)}/approvals`,
    { method: "POST" },
  );
  state.factorySession = await api<CreationSession>(`/v1/factory-sessions/${encodeURIComponent(session.id)}/publish`, {
    method: "POST",
    body: jsonBody({ approvalId: approval.approvalId }),
  });
  await loadWorkspace();
  await loadBotResources(session.botId ?? "");
  navigate(`bot/${session.botId}/overview`);
}

function requireFactorySession(): CreationSession {
  if (!state.factorySession) throw new Error("Start a bot setup first.");
  return state.factorySession;
}

async function saveBotSettings(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const body = {
    expectedVersion: Number(data.get("expectedVersion")),
    name: String(data.get("name") ?? "").trim(),
    description: String(data.get("description") ?? "").trim(),
    systemPrompt: String(data.get("systemPrompt") ?? "").trim(),
  };
  const updated = await api<Bot>(`/v1/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: jsonBody(body) });
  activeBotVersionsId = "";
  state.botVersions = [];
  state.activeBot = updated;
  state.bots = state.bots.map((item) => (item.id === bot.id ? updated : item));
  render();
  showToast("Bot configuration saved");
}

async function rotateBotCredential(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const credential = String(data.get("credential") ?? "");
  if (!credential) throw new Error("Enter the new model API credential.");
  if (
    !(await askConfirmation(
      "Replace this bot’s model credential?",
      "The new key will be encrypted and saved as a new bot version. It will be sent only to the bot’s configured model endpoint.",
      "Replace credential",
    ))
  ) {
    return;
  }
  const approval = await api<{ approvalId: string }>(`${botBase(bot.id)}/credential-approval`, { method: "POST" });
  const updated = await api<Bot>(`${botBase(bot.id)}/credential`, {
    method: "PUT",
    body: jsonBody({ expectedVersion: bot.version, approvalId: approval.approvalId, credential }),
  });
  activeBotVersionsId = "";
  state.botVersions = [];
  state.activeBot = updated;
  state.bots = state.bots.map((item) => (item.id === bot.id ? updated : item));
  render();
  showToast("Model credential encrypted and replaced");
}

async function configureBotModel(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const credential = String(data.get("credential") ?? "");
  const temperature = Number(data.get("temperature"));
  if (!credential) throw new Error("Enter the new model API credential.");
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error("Temperature must be between 0 and 2.");
  }
  const endpoint = String(data.get("endpoint") ?? "").trim();
  if (
    !(await askConfirmation(
      "Save these model settings?",
      "The provider, endpoint, and model key will be saved as a new bot version. The key will be encrypted and sent only to an endpoint permitted by the deployment.",
      "Save model settings",
    ))
  ) {
    return;
  }
  const approval = await api<{ approvalId: string }>(`${botBase(bot.id)}/credential-approval`, { method: "POST" });
  const updated = await api<Bot>(`${botBase(bot.id)}/model`, {
    method: "PUT",
    body: jsonBody({
      expectedVersion: bot.version,
      approvalId: approval.approvalId,
      credential,
      model: {
        providerId: String(data.get("providerId") ?? "").trim(),
        model: String(data.get("model") ?? "").trim(),
        imageModel: String(data.get("imageModel") ?? "").trim(),
        searchModel: String(data.get("searchModel") ?? "").trim(),
        ...(endpoint ? { endpoint } : {}),
        parameters: { temperature },
        ...(bot.model.retryPolicy ? { retryPolicy: bot.model.retryPolicy } : {}),
      },
    }),
  });
  activeBotVersionsId = "";
  state.botVersions = [];
  state.activeBot = updated;
  state.bots = state.bots.map((item) => (item.id === bot.id ? updated : item));
  render();
  showToast("Model settings saved and credential encrypted");
}

async function configureBotRetryPolicy(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const mode = String(data.get("mode") ?? "deployment");
  let retryPolicy: { maxAttempts: number; backoffMs: number } | null = null;
  if (mode === "bot") {
    const maxAttempts = Number(data.get("maxAttempts"));
    const backoffMs = Number(data.get("backoffMs"));
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new Error("Model retries must allow between 1 and 3 total attempts.");
    }
    if (!Number.isSafeInteger(backoffMs) || backoffMs < 0 || backoffMs > 3000) {
      throw new Error("Initial model retry backoff must be between 0 and 3000 milliseconds.");
    }
    retryPolicy = { maxAttempts, backoffMs };
  } else if (mode !== "deployment") {
    throw new Error("Choose a valid model retry policy.");
  }
  const updated = await api<Bot>(`${botBase(bot.id)}/model/retry-policy`, {
    method: "PATCH",
    body: jsonBody({ expectedVersion: bot.version, retryPolicy }),
  });
  activeBotVersionsId = "";
  state.botVersions = [];
  state.activeBot = updated;
  state.bots = state.bots.map((item) => (item.id === bot.id ? updated : item));
  render();
  showToast(retryPolicy ? "Per-bot model retry policy saved" : "Deployment model retry defaults restored");
}

async function saveBotAccessPolicy(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const result = await api<{ publicListing: NonNullable<BotAccessSettings["publicListing"]> }>(
    `${botBase(bot.id)}/access`,
    {
      method: "PUT",
      body: jsonBody({
        dailyUsageLimit: Number(data.get("dailyUsageLimit")),
        rateLimitPerMinute: Number(data.get("rateLimitPerMinute")),
      }),
    },
  );
  await loadBotAccess(bot.id);
  render();
  showToast(`Public limits saved for /${result.publicListing.slug}`);
}

async function createBotAccessGrant(data: FormData, invitation: boolean): Promise<void> {
  const bot = requireActiveBot();
  const userId = String(data.get("userId") ?? "").trim();
  const dailyUsageLimit = String(data.get("dailyUsageLimit") ?? "").trim();
  const rateLimitPerMinute = String(data.get("rateLimitPerMinute") ?? "").trim();
  const expiresAtInput = String(data.get("expiresAt") ?? "").trim();
  const expiresAt = expiresAtInput ? new Date(expiresAtInput).toISOString() : undefined;
  const result = await api<{ grant: import("./types.js").BotAccessGrant; invitationToken?: string }>(
    `${botBase(bot.id)}/access/grants`,
    {
      method: "POST",
      body: jsonBody({
        ...(!invitation ? { userId } : {}),
        ...(dailyUsageLimit ? { dailyUsageLimit: Number(dailyUsageLimit) } : {}),
        ...(rateLimitPerMinute ? { rateLimitPerMinute: Number(rateLimitPerMinute) } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      }),
    },
  );
  state.invitationToken = result.invitationToken;
  await loadBotAccess(bot.id);
  render();
  showToast(invitation ? "Invitation created" : "User access granted");
}

async function revokeBotGrant(grantId: string): Promise<void> {
  const bot = requireActiveBot();
  if (!grantId) return;
  if (
    !(await askConfirmation("Revoke bot access?", "This user or invitation will stop working immediately.", "Revoke"))
  )
    return;
  await api(`${botBase(bot.id)}/access/grants/${encodeURIComponent(grantId)}`, { method: "DELETE" });
  await loadBotAccess(bot.id);
  render();
  showToast("Bot access revoked");
}

async function saveBotCollaborator(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const userId = String(data.get("userId") ?? "").trim();
  const role = String(data.get("role") ?? "");
  if (!userId) throw new Error("Enter an active workspace member ID.");
  await api(`${botBase(bot.id)}/collaborators`, {
    method: "PUT",
    body: jsonBody({ userId, role }),
  });
  await loadBotCollaborators(bot.id);
  render();
  showToast("Bot collaborator saved");
}

async function removeBotCollaborator(userId: string): Promise<void> {
  const bot = requireActiveBot();
  if (!userId) return;
  if (
    !(await askConfirmation(
      "Remove bot collaborator?",
      "They will lose access to this bot immediately. Their workspace membership is unchanged.",
      "Remove collaborator",
    ))
  ) {
    return;
  }
  await api(`${botBase(bot.id)}/collaborators/${encodeURIComponent(userId)}`, { method: "DELETE" });
  await loadBotCollaborators(bot.id);
  render();
  showToast("Bot collaborator removed");
}

async function toggleBotMemory(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const updated = await api<Bot>(botBase(bot.id), {
    method: "PATCH",
    body: jsonBody({ expectedVersion: bot.version, memoryEnabled: data.get("enabled") === "true" }),
  });
  state.activeBot = updated;
  state.bots = state.bots.map((item) => (item.id === bot.id ? updated : item));
  render();
  showToast(updated.memoryEnabled ? "Long-term memory enabled" : "Long-term memory paused");
}

async function saveBotMemory(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const key = String(data.get("key") ?? "").trim();
  const value = String(data.get("value") ?? "").trim();
  const expirationInput = String(data.get("expiresAt") ?? "");
  if (!key || !value) throw new Error("Add a short key and memory note.");
  const record = await api<BotMemoryRecord>(`${botBase(bot.id)}/memory/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: jsonBody({ value, ...(expirationInput ? { expiresAt: new Date(expirationInput).toISOString() } : {}) }),
  });
  state.memoryRecords = [record, ...state.memoryRecords.filter((item) => item.key !== record.key)].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  activeMemoryBotId = bot.id;
  render();
  showToast("Memory note saved");
}

async function deleteBotMemory(key: string): Promise<void> {
  const bot = requireActiveBot();
  if (!key) throw new Error("Choose a memory note first.");
  if (
    !(await askConfirmation(`Delete “${key}”?`, "This removes the note from future bot context.", "Delete note", true))
  )
    return;
  await api(`${botBase(bot.id)}/memory/${encodeURIComponent(key)}`, { method: "DELETE" });
  state.memoryRecords = state.memoryRecords.filter((item) => item.key !== key);
  render();
  showToast("Memory note deleted");
}

async function uploadBotFiles(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const files = data.getAll("files").filter((value): value is File => value instanceof File);
  if (files.length === 0) throw new Error("Choose at least one file to upload.");
  for (const file of files) {
    const contentType = supportedUploadedFileType(file);
    const result = await api<{ file: UploadedFile }>(`${botBase(bot.id)}/files`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-file-name-encoded": encodeURIComponent(file.name),
      },
      body: file,
    });
    state.uploadedFiles = [result.file, ...state.uploadedFiles.filter((item) => item.id !== result.file.id)];
  }
  await loadUploadedFiles(bot.id);
  render();
  showToast(files.length === 1 ? "File uploaded" : `${files.length} files uploaded`);
}

async function scanUploadedFile(fileId: string): Promise<void> {
  const bot = requireActiveBot();
  if (!fileId) throw new Error("Choose a file to scan.");
  const result = await api<{ file: UploadedFile }>(`${botBase(bot.id)}/files/${encodeURIComponent(fileId)}/scan`, {
    method: "POST",
  });
  state.uploadedFiles = state.uploadedFiles.map((file) => (file.id === fileId ? result.file : file));
  render();
  showToast(result.file.scanStatus === "clean" ? "File passed malware scanning" : "File scan completed");
}

async function deleteUploadedFile(fileId: string): Promise<void> {
  const bot = requireActiveBot();
  const file = state.uploadedFiles.find((item) => item.id === fileId);
  if (!fileId || !file) throw new Error("Choose a stored file first.");
  if (
    !(await askConfirmation(
      `Delete “${file.fileName}”?`,
      "This permanently removes the stored file.",
      "Delete file",
      true,
    ))
  )
    return;
  await api(`${botBase(bot.id)}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
  state.uploadedFiles = state.uploadedFiles.filter((item) => item.id !== fileId);
  render();
  showToast("File deleted");
}

async function downloadUploadedFile(fileId: string): Promise<void> {
  const bot = requireActiveBot();
  const file = state.uploadedFiles.find((item) => item.id === fileId);
  if (file?.scanStatus !== "clean") throw new Error("Only a file that passed scanning can be downloaded.");
  const response = await fetch(`${botBase(bot.id)}/files/${encodeURIComponent(fileId)}/content`, {
    headers: { authorization: `Bearer ${accessToken}`, "cache-control": "no-store" },
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    let error: unknown;
    try {
      error = await response.json();
    } catch {
      error = undefined;
    }
    const message = error && typeof error === "object" ? (error as Record<string, unknown>).message : undefined;
    throw new ApiError(
      typeof message === "string" ? message : `File download failed (${response.status}).`,
      response.status,
    );
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = file.fileName;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

async function loadUploadedFiles(botId: string): Promise<void> {
  const result = await api<{ items: UploadedFile[] }>(`${botBase(botId)}/files`);
  state.uploadedFiles = result.items;
}

async function loadToolRecoveries(botId: string): Promise<void> {
  const result = await api<{ recoveries: ToolExecutionRecovery[] }>(`${botBase(botId)}/tool-executions`);
  state.toolRecoveries = result.recoveries;
  render();
}

async function resolveToolRecovery(executionKey: string, resolution: string): Promise<void> {
  const bot = requireActiveBot();
  if (!/^[a-f0-9]{64}$/.test(executionKey) || (resolution !== "retry" && resolution !== "close")) {
    throw new Error("Choose a valid tool recovery action.");
  }
  if (resolution === "retry") {
    const approved = await askConfirmation(
      "Approve this tool call to run again?",
      "Check the external service first. It may already have completed the action, and retrying can duplicate its effect. The original request must be replayed with the same key; this approval does not launch it by itself.",
      "Approve retry",
      true,
    );
    if (!approved) return;
  } else if (
    !(await askConfirmation(
      "Close this uncertain tool call?",
      "This prevents the original request from running this tool call again with the same key.",
      "Close call",
      true,
    ))
  ) {
    return;
  }
  await api(`${botBase(bot.id)}/tool-executions/${encodeURIComponent(executionKey)}/resolve`, {
    method: "POST",
    body: jsonBody({ resolution }),
  });
  await loadToolRecoveries(bot.id);
  showToast(resolution === "retry" ? "Retry approved" : "Tool call closed");
}

function supportedUploadedFileType(file: File): string {
  const allowed = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/tab-separated-values",
    "application/json",
    "application/x-ndjson",
    "application/xml",
    "application/yaml",
  ]);
  const hasExtension = file.name.includes(".");
  const extension = hasExtension ? file.name.split(".").at(-1)?.toLowerCase() : undefined;
  const byExtension: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    jsonl: "application/x-ndjson",
    ndjson: "application/x-ndjson",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    log: "text/plain",
  };
  const contentType = hasExtension ? byExtension[extension ?? ""] : allowed.has(file.type) ? file.type : undefined;
  if (!contentType) throw new Error(`“${file.name}” has an unsupported file type.`);
  return contentType;
}

async function toggleBot(disable: boolean): Promise<void> {
  const bot = requireActiveBot();
  const title = disable ? "Disable this bot?" : "Enable this bot?";
  const message = disable
    ? "It will stop accepting agent messages until you enable it again."
    : "It will accept requests again using its current model and permissions.";
  if (!(await askConfirmation(title, message, disable ? "Disable bot" : "Enable bot"))) return;
  await api(`/v1/bots/${encodeURIComponent(bot.id)}/${disable ? "disable" : "enable"}`, { method: "POST" });
  await refreshBot(bot.id);
  showToast(disable ? "Bot disabled" : "Bot enabled");
}

async function deleteBot(): Promise<void> {
  const bot = requireActiveBot();
  if (
    !(await askConfirmation(
      `Delete ${bot.name}?`,
      "This permanently removes the bot and its attached configuration. This cannot be undone.",
      "Delete bot",
      true,
    ))
  )
    return;
  await api(`/v1/bots/${encodeURIComponent(bot.id)}`, { method: "DELETE" });
  state.activeBot = undefined;
  activeBotResourcesId = "";
  state.bots = state.bots.filter((item) => item.id !== bot.id);
  await loadWorkspace();
  navigate("bots");
  showToast("Bot deleted");
}

async function connectTelegram(token: string): Promise<void> {
  const bot = requireActiveBot();
  if (
    !(await askConfirmation(
      "Connect this Telegram bot?",
      "The token will be validated and encrypted on the server. It will not be shown again.",
      "Connect bot",
    ))
  )
    return;
  await api(`${botBase(bot.id)}/telegram`, { method: "PUT", body: jsonBody({ token }) });
  await refreshBot(bot.id);
  showToast("Telegram webhook connected");
}

async function saveTelegramAllowlist(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const typed = String(data.get("allowedUserIds") ?? "")
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  const approvedPending = data.getAll("pendingIds").map(String);
  const numeric = [...new Set([...typed, ...approvedPending].map((value) => Number(value)))];
  if (numeric.some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error("Enter only positive numeric Telegram user IDs.");
  await api(`${botBase(bot.id)}/telegram`, { method: "PATCH", body: jsonBody({ allowedUserIds: numeric }) });
  state.selectedGrantUserId = undefined;
  await refreshBot(bot.id);
  showToast("Telegram sender access updated");
}

async function disconnectTelegram(): Promise<void> {
  const bot = requireActiveBot();
  if (
    !(await askConfirmation(
      "Disconnect Telegram?",
      "The webhook will be removed and the encrypted bot token deleted.",
      "Disconnect",
      true,
    ))
  )
    return;
  await api(`${botBase(bot.id)}/telegram`, { method: "DELETE" });
  await refreshBot(bot.id);
  showToast("Telegram bot disconnected");
}

async function loadTelegramGrants(userId: number): Promise<void> {
  const bot = requireActiveBot();
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error("Telegram user ID is invalid.");
  const result = await api<{ toolRefs: string[] }>(`${botBase(bot.id)}/telegram/users/${userId}/tool-grants`);
  state.selectedGrantUserId = userId;
  state.selectedGrantRefs = result.toolRefs;
  render();
}

async function saveTelegramGrants(form: HTMLFormElement, data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const userId = Number(form.dataset.userId);
  const toolRefs = data.getAll("toolRefs").map(String);
  await api(`${botBase(bot.id)}/telegram/users/${userId}/tool-grants`, { method: "PUT", body: jsonBody({ toolRefs }) });
  state.selectedGrantRefs = toolRefs;
  render();
  showToast("Per-user tool grants saved");
}

async function installSkill(skillId: string, grantedPermissions: string[]): Promise<void> {
  const botId = state.page === "bot" ? requireActiveBot().id : selectedBotId("skill-target-bot");
  const skill = state.catalog.find((item) => item.id === skillId);
  if (!skill) throw new Error("Skill is not in the current catalog.");
  const missing = skill.requiredPermissions.filter((permission) => !grantedPermissions.includes(permission));
  if (missing.length) throw new Error(`Grant each required permission before installing: ${missing.join(", ")}.`);
  if (
    !(await askConfirmation(
      `Install ${skill.name}?`,
      grantedPermissions.length
        ? `This grants: ${grantedPermissions.join(", ")}.`
        : "This skill declares no additional permissions.",
      "Install skill",
    ))
  )
    return;
  await api(`${botBase(botId)}/skills`, {
    method: "POST",
    body: jsonBody({ skillId, configuration: {}, grantedPermissions }),
  });
  await refreshBot(botId);
  showToast(`${skill.name} installed`);
}

async function publishSkill(data: FormData): Promise<void> {
  if (!state.principal?.scopes.includes("skills:publish")) {
    throw new Error("This token needs the skills:publish scope to publish catalog entries.");
  }
  let definition: unknown;
  try {
    definition = JSON.parse(String(data.get("definition") ?? ""));
  } catch {
    throw new Error("Skill definition must be valid JSON.");
  }
  await api("/v1/skills", { method: "POST", body: jsonBody(definition) });
  state.catalog = await api<Skill[]>("/v1/skills");
  render();
  showToast("Skill published to this workspace");
}

async function toggleSkill(target: HTMLElement): Promise<void> {
  const bot = requireActiveBot();
  const skillId = target.dataset.skillId;
  if (!skillId) return;
  const enabled = target.dataset.enabled === "true";
  await api(`${botBase(bot.id)}/skills/${encodeURIComponent(skillId)}`, {
    method: "PATCH",
    body: jsonBody({ enabled }),
  });
  await refreshBot(bot.id);
  showToast(enabled ? "Skill enabled" : "Skill disabled");
}

async function uninstallSkill(skillId: string): Promise<void> {
  const bot = requireActiveBot();
  if (
    !(await askConfirmation(
      "Uninstall this skill?",
      "The bot will no longer be able to discover or run this tool.",
      "Uninstall",
      true,
    ))
  )
    return;
  await api(`${botBase(bot.id)}/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
  await refreshBot(bot.id);
  showToast("Skill uninstalled");
}

async function addMcpServer(data: FormData): Promise<void> {
  const botId = state.page === "bot" ? requireActiveBot().id : selectedBotId("mcp-target-bot");
  const name = String(data.get("name") ?? "").trim();
  const endpoint = String(data.get("endpoint") ?? "").trim();
  const authMode = String(data.get("authenticationMode") ?? "none");
  const authentication =
    authMode === "bearer"
      ? { mode: "bearer", token: String(data.get("mcpBearerToken") ?? "") }
      : authMode === "oauth_client_credentials"
        ? {
            mode: "oauth_client_credentials",
            clientId: String(data.get("mcpClientId") ?? ""),
            clientSecret: String(data.get("mcpClientSecret") ?? ""),
            issuer: String(data.get("mcpIssuer") ?? ""),
            scope: String(data.get("mcpScope") ?? "").trim(),
          }
        : authMode === "oauth_authorization_code"
          ? {
              mode: "oauth_authorization_code",
              clientId: String(data.get("mcpCodeClientId") ?? ""),
              ...(String(data.get("mcpCodeClientSecret") ?? "")
                ? { clientSecret: String(data.get("mcpCodeClientSecret")) }
                : {}),
              issuer: String(data.get("mcpCodeIssuer") ?? ""),
              scope: String(data.get("mcpCodeScope") ?? "").trim(),
            }
          : undefined;
  const response = await api<{ server: McpServer }>(`${botBase(botId)}/mcp-servers`, {
    method: "POST",
    body: jsonBody({ name, endpoint, ...(authentication ? { authentication } : {}) }),
  });
  const form = document.querySelector<HTMLFormElement>("#mcp-add-form");
  form?.reset();
  for (const fields of form?.querySelectorAll<HTMLElement>("[data-mcp-auth-fields]") ?? []) {
    fields.hidden = true;
    for (const input of fields.querySelectorAll<HTMLInputElement>("input")) input.required = false;
  }
  await refreshBot(botId);
  if (state.page !== "bot") navigate("mcp");
  else render();
  showToast(`${response.server.name} added`);
}

async function connectMcp(serverId: string): Promise<void> {
  const bot = requireActiveBot();
  const result = await api<{ tools: McpTool[] }>(
    `${botBase(bot.id)}/mcp-servers/${encodeURIComponent(serverId)}/connect`,
    { method: "POST" },
  );
  state.toolsByServer[serverId] = result.tools;
  await refreshBot(bot.id);
  showToast(`${result.tools.length} tools discovered; review before enabling`);
}

async function startMcpOAuth(serverId: string): Promise<void> {
  const botId = state.page === "bot" ? requireActiveBot().id : selectedBotId("mcp-target-bot");
  const result = await api<{ authorizationUrl?: string; connected: boolean }>(
    `${botBase(botId)}/mcp-servers/${encodeURIComponent(serverId)}/oauth/start`,
    { method: "POST" },
  );
  if (result.authorizationUrl) {
    const authorizationUrl = new URL(result.authorizationUrl);
    if (authorizationUrl.protocol !== "https:" || authorizationUrl.username || authorizationUrl.password) {
      throw new Error("The MCP provider returned an invalid authorization URL.");
    }
    sessionStorage.setItem(MCP_OAUTH_FLOW_KEY, JSON.stringify({ botId, serverId }));
    location.assign(authorizationUrl.href);
    return;
  }
  await refreshBot(botId);
  showToast(result.connected ? "MCP server connected" : "MCP authorization started");
}

async function deleteMcp(serverId: string): Promise<void> {
  const bot = requireActiveBot();
  if (
    !(await askConfirmation(
      "Remove MCP server?",
      "This also removes its discovered tools and permission grants.",
      "Remove server",
      true,
    ))
  )
    return;
  await api(`${botBase(bot.id)}/mcp-servers/${encodeURIComponent(serverId)}`, { method: "DELETE" });
  await refreshBot(bot.id);
  showToast("MCP server removed");
}

async function toggleMcpTool(target: HTMLElement): Promise<void> {
  const bot = requireActiveBot();
  const serverId = target.dataset.serverId;
  const toolName = target.dataset.toolName;
  const enabled = target.dataset.enabled === "true";
  if (!serverId || !toolName) return;
  const confirmed = enabled
    ? await askConfirmation(
        "Enable this remote tool?",
        `The model can call “${toolName}”. This grants the explicit mcp:invoke permission.`,
        "Grant & enable",
      )
    : await askConfirmation(
        "Disable this remote tool?",
        "The tool is removed from the model’s available actions.",
        "Disable tool",
      );
  if (!confirmed) return;
  await api(`${botBase(bot.id)}/mcp-servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}`, {
    method: "PATCH",
    body: jsonBody({ enabled, grantedPermissions: enabled ? ["mcp:invoke"] : [] }),
  });
  await refreshBot(bot.id);
  showToast(enabled ? "Tool enabled with mcp:invoke" : "Tool disabled");
}

async function createSchedule(data: FormData): Promise<void> {
  const botId = state.page === "bot" ? requireActiveBot().id : selectedBotId("automation-target-bot");
  const repeat = String(data.get("repeat"));
  const schedule =
    repeat === "daily"
      ? `daily:${String(data.get("dailyAt") ?? "")}`
      : `once:${new Date(String(data.get("runAt") ?? "")).toISOString()}`;
  const timezone = String(data.get("timezone") ?? "").trim();
  const prompt = String(data.get("prompt") ?? "").trim();
  const notifyTelegramUserId = Number(data.get("notifyTelegramUserId"));
  await api(`${botBase(botId)}/scheduled-tasks`, {
    method: "POST",
    body: jsonBody({ schedule, timezone, prompt, notifyTelegramUserId }),
  });
  await refreshBot(botId);
  showToast("Scheduled task created");
}

async function toggleTask(target: HTMLElement): Promise<void> {
  const botId = state.page === "bot" ? requireActiveBot().id : selectedBotId("automation-target-bot");
  const taskId = target.dataset.taskId;
  const status = target.dataset.status;
  if (!taskId) return;
  await api(`${botBase(botId)}/scheduled-tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: jsonBody({ status: status === "active" ? "paused" : "active" }),
  });
  await refreshBot(botId);
  showToast(status === "active" ? "Task paused" : "Task resumed");
}

async function retryScheduledTask(target: HTMLElement): Promise<void> {
  const botId = state.page === "bot" ? requireActiveBot().id : selectedBotId("automation-target-bot");
  const taskId = target.dataset.taskId;
  if (!taskId) return;
  const confirmed = window.confirm(
    "Retry this failed run? If Telegram accepted the previous message before a timeout, the recipient may receive it again.",
  );
  if (!confirmed) return;
  await api(`${botBase(botId)}/scheduled-tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST" });
  await refreshBot(botId);
  showToast("Failed schedule queued for retry");
}

async function createToken(data: FormData): Promise<void> {
  const scopes = data.getAll("scopes").map(String);
  if (!scopes.length) throw new Error("Choose at least one token scope.");
  const days = Number(data.get("expiresDays"));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  state.newToken = await api<{ token: string; expiresAt: string; scopes: string[] }>("/v1/tokens", {
    method: "POST",
    body: jsonBody({ scopes, expiresAt }),
  });
  render();
}

async function switchWorkspace(tenantId: string): Promise<void> {
  if (!tenantId) throw new Error("Choose a workspace first.");
  const currentPrincipal = state.principal;
  if (!currentPrincipal) throw new Error("Sign in before switching workspaces.");
  const workspaceName = state.workspaces.find((workspace) => workspace.tenantId === tenantId)?.name ?? "workspace";
  const switched = await api<{
    tenantId: string;
    tokenId: string;
    token: string;
    scopes: Principal["scopes"];
  }>("/v1/workspaces/switch", {
    method: "POST",
    body: jsonBody({ tenantId }),
  });

  accessToken = switched.token;
  configureTokenReader(() => accessToken);
  sessionStorage.setItem(TOKEN_KEY, switched.token);
  sessionStorage.setItem(SESSION_TOKEN_ID_KEY, switched.tokenId);
  sessionStorage.removeItem(SESSION_KEY);
  Object.assign(state, createInitialState());
  state.principal = {
    tenantId: switched.tenantId,
    userId: currentPrincipal.userId,
    tokenId: switched.tokenId,
    scopes: switched.scopes,
  };
  state.pageError = undefined;
  state.notice = undefined;
  state.factoryError = undefined;
  state.tenantMembersError = undefined;
  state.workspacesError = undefined;
  state.newToken = undefined;
  activeBotResourcesId = "";
  activeBotVersionsId = "";
  activeConversationBotId = "";
  activeMemoryBotId = "";
  searchOpen = false;
  history.replaceState(null, "", `${location.pathname}${location.search}#/dashboard`);
  await loadWorkspace();
  await applyRoute();
  showToast(`Switched to ${workspaceName}`);
}

async function loadTenantMembers(): Promise<void> {
  const response = await api<{ items: TenantMember[] }>("/v1/members");
  state.tenantMembers = response.items;
  state.tenantMembersError = undefined;
  render();
}

async function loadTenantInvitations(): Promise<void> {
  const response = await api<{ items: TenantInvitation[] }>("/v1/invitations");
  state.tenantInvitations = response.items;
  state.tenantInvitationsError = undefined;
  render();
}

async function createWorkspaceInvitation(data: FormData): Promise<void> {
  const result = await api<{ item: TenantInvitation; token: string }>("/v1/invitations", {
    method: "POST",
    body: jsonBody({ role: String(data.get("role") ?? "member"), expiresInDays: Number(data.get("expiresInDays")) }),
  });
  const url = new URL("/miniapp/", location.origin);
  url.searchParams.set("invite", result.token);
  state.newWorkspaceInvitation = {
    invitationId: result.item.id,
    token: result.token,
    url: url.toString(),
    expiresAt: result.item.expiresAt,
  };
  await loadTenantInvitations();
  showToast("Workspace invitation created");
}

async function revokeWorkspaceInvitation(invitationId: string): Promise<void> {
  if (!invitationId) throw new Error("Choose an invitation first.");
  const confirmed = await askConfirmation(
    "Revoke this workspace invitation?",
    "Anyone with this link will no longer be able to join using it.",
    "Revoke invitation",
    true,
  );
  if (!confirmed) return;
  await api(`/v1/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });
  if (state.newWorkspaceInvitation?.invitationId === invitationId) state.newWorkspaceInvitation = undefined;
  await loadTenantInvitations();
  showToast("Workspace invitation revoked");
}

async function acceptPendingWorkspaceInvitation(): Promise<void> {
  const token = sessionStorage.getItem(WORKSPACE_INVITATION_KEY);
  if (!token) return;
  try {
    await acceptWorkspaceInvitation(token);
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) sessionStorage.removeItem(WORKSPACE_INVITATION_KEY);
    state.pageError = `Workspace invitation could not be accepted: ${asMessage(error)}`;
    render();
  }
}

async function acceptWorkspaceInvitation(token: string): Promise<void> {
  if (!/^ahf_invite_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Enter a valid workspace invitation token.");
  const accepted = await api<{ tenantId: string; role: "admin" | "member" }>("/v1/invitations/accept", {
    method: "POST",
    body: jsonBody({ token }),
  });
  sessionStorage.removeItem(WORKSPACE_INVITATION_KEY);
  try {
    const response = await api<{ items: WorkspaceMembership[] }>("/v1/workspaces");
    state.workspaces = response.items;
    await switchWorkspace(accepted.tenantId);
    showToast("Invitation accepted and workspace opened");
  } catch {
    navigate("security");
    showToast("Invitation accepted. Switch to the workspace in Security settings.");
  }
}

async function addTenantMember(data: FormData): Promise<void> {
  const userId = String(data.get("userId") ?? "").trim();
  const role = String(data.get("role") ?? "member");
  await api<{ item: TenantMember }>("/v1/members", {
    method: "POST",
    body: jsonBody({ userId, role }),
  });
  await loadTenantMembers();
  showToast("Workspace member added");
}

async function updateTenantMemberRole(userId: string, role: string): Promise<void> {
  if (!userId) throw new Error("Choose a workspace member first.");
  await api<{ item: TenantMember }>(`/v1/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: jsonBody({ role }),
  });
  await loadTenantMembers();
  showToast("Member role updated");
}

async function deactivateTenantMember(userId: string): Promise<void> {
  if (!userId) throw new Error("Choose a workspace member first.");
  const confirmed = await askConfirmation(
    "Remove this workspace member?",
    "Their active API tokens will be revoked. Their account and bots stay in the database, but their workspace access is disabled.",
    "Remove member",
    true,
  );
  if (!confirmed) return;
  await api<{ item: TenantMember }>(`/v1/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  await loadTenantMembers();
  showToast("Member removed and tokens revoked");
}

async function reactivateTenantMember(userId: string, role: string): Promise<void> {
  if (!userId) throw new Error("Choose a workspace member first.");
  const reactivationRole = role === "owner" ? "admin" : role;
  await api<{ item: TenantMember }>("/v1/members", {
    method: "POST",
    body: jsonBody({ userId, role: reactivationRole }),
  });
  await loadTenantMembers();
  showToast("Member reactivated. Create a new API token for them.");
}

async function createBotOwnershipTransfer(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const targetUserId = String(data.get("targetUserId") ?? "").trim();
  if (!targetUserId) throw new Error("Choose an active workspace member first.");
  const confirmed = await askConfirmation(
    "Offer this bot to a new owner?",
    `Only ${targetUserId} can accept. Ownership changes after acceptance, and scheduled tasks will pause for review.`,
    "Create transfer token",
    true,
  );
  if (!confirmed) return;
  const result = await api<{ item: BotOwnershipTransfer; token: string }>(`${botBase(bot.id)}/ownership-transfer`, {
    method: "POST",
    body: jsonBody({ targetUserId }),
  });
  state.botOwnershipTransfer = {
    item: result.item,
    token: result.token,
  };
  render();
  showToast("Ownership transfer created. Copy the one-time token to the recipient.");
}

async function revokeBotOwnershipTransfer(transferId: string): Promise<void> {
  const bot = requireActiveBot();
  if (!transferId) throw new Error("Choose a pending ownership transfer first.");
  const confirmed = await askConfirmation(
    "Revoke this ownership transfer?",
    "The one-time token will stop working immediately.",
    "Revoke transfer",
    true,
  );
  if (!confirmed) return;
  await api(`${botBase(bot.id)}/ownership-transfer/${encodeURIComponent(transferId)}`, { method: "DELETE" });
  const refreshed = await api<{ item: BotOwnershipTransfer | null }>(`${botBase(bot.id)}/ownership-transfer`);
  state.botOwnershipTransfer = refreshed;
  render();
  showToast("Ownership transfer revoked");
}

async function acceptBotOwnershipTransfer(token: string): Promise<void> {
  if (!/^ahf_transfer_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Enter a valid ownership transfer token.");
  }
  if (
    !(await askConfirmation(
      "Accept bot ownership?",
      "You will become the bot owner. Existing scheduled tasks will be paused so you can review their recipients.",
      "Accept ownership",
    ))
  ) {
    return;
  }
  const accepted = await api<{ item: BotOwnershipTransfer }>("/v1/bot-transfers/accept", {
    method: "POST",
    body: jsonBody({ token }),
  });
  state.botOwnershipTransfer = { item: null };
  await loadWorkspace();
  activeBotResourcesId = "";
  navigate(`bot/${accepted.item.botId}/overview`);
  showToast("Bot ownership accepted. Review and resume scheduled tasks as needed.");
}

async function sendChat(data: FormData): Promise<void> {
  const bot = requireActiveBot();
  const message = String(data.get("message") ?? "").trim();
  if (!message) return;
  state.chatLines.push({ role: "user", content: message });
  state.chatLines.push({ role: "assistant", content: "" });
  state.pending = true;
  render();
  try {
    const requestBody = {
      message,
      ...(state.chatConversationId ? { conversationId: state.chatConversationId } : {}),
    };
    const onDelta = (delta: string): void => {
      const assistantLine = state.chatLines[state.chatLines.length - 1];
      if (assistantLine?.role === "assistant") assistantLine.content += delta;
      render();
      document.getElementById("chat-transcript")?.scrollTo({ top: 999999, behavior: "smooth" });
    };
    const result = state.capabilities?.features.modelStreaming
      ? await apiStream<{
          conversationId: string;
          message: string;
          attachments?: readonly { kind: "image"; url: string; alt?: string }[];
          usage?: { inputTokens: number; outputTokens: number };
        }>(`${botBase(bot.id)}/messages`, { ...requestBody, stream: true }, onDelta)
      : await api<{
          conversationId: string;
          message: string;
          attachments?: readonly { kind: "image"; url: string; alt?: string }[];
          usage?: { inputTokens: number; outputTokens: number };
        }>(`${botBase(bot.id)}/messages`, {
          method: "POST",
          body: jsonBody(requestBody),
        });
    state.chatConversationId = result.conversationId;
    const assistantLine = state.chatLines[state.chatLines.length - 1];
    if (assistantLine?.role === "assistant") {
      assistantLine.content = result.message;
      if (result.attachments?.length) assistantLine.attachments = result.attachments;
    }
    activeConversationBotId = "";
    state.pending = false;
    render();
    document.getElementById("chat-transcript")?.scrollTo({ top: 999999, behavior: "smooth" });
  } catch (error) {
    state.pending = false;
    const assistantLine = state.chatLines[state.chatLines.length - 1];
    if (assistantLine?.role === "assistant") {
      const failure = `The response was interrupted: ${asMessage(error)}`;
      assistantLine.content = assistantLine.content ? `${assistantLine.content}\n\n${failure}` : failure;
    }
    render();
  }
}

async function loadPublicChat(slug: string): Promise<void> {
  try {
    const response = await api<{ bot: PublicChatBot }>(`/v1/public/bots/${encodeURIComponent(slug)}/web-chat`);
    state.publicChatBot = response.bot;
    state.publicChatError = undefined;
  } catch (error) {
    state.publicChatBot = undefined;
    state.publicChatError = asMessage(error);
  }
}

async function sendPublicChat(data: FormData): Promise<void> {
  const bot = state.publicChatBot;
  const slug = state.publicChatSlug;
  const message = String(data.get("message") ?? "").trim();
  if (!bot || !slug || !message || state.publicChatBusy) return;
  state.publicChatLines.push({ role: "user", content: message });
  state.publicChatLines.push({ role: "assistant", content: "" });
  state.publicChatBusy = true;
  state.publicChatError = undefined;
  render();
  try {
    const result = await api<{
      conversationId: string;
      message: string;
      attachments?: readonly { kind: "image"; url: string; alt?: string }[];
    }>(`/v1/public/bots/${encodeURIComponent(slug)}/web-chat/messages`, {
      method: "POST",
      body: jsonBody({
        message,
        ...(state.publicChatConversationId ? { conversationId: state.publicChatConversationId } : {}),
      }),
    });
    state.publicChatConversationId = result.conversationId;
    const assistantLine = state.publicChatLines[state.publicChatLines.length - 1];
    if (assistantLine?.role === "assistant") {
      assistantLine.content = result.message;
      if (result.attachments?.length) assistantLine.attachments = result.attachments;
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearSession();
      state.publicChatError = "Your sign-in expired. Sign in again to continue.";
    } else {
      state.publicChatError = asMessage(error);
    }
    const assistantLine = state.publicChatLines[state.publicChatLines.length - 1];
    if (assistantLine?.role === "assistant") assistantLine.content = "The response could not be completed.";
  } finally {
    state.publicChatBusy = false;
    render();
    document.getElementById("public-chat-transcript")?.scrollTo({ top: 999999, behavior: "smooth" });
  }
}

function getPublicChatSlug(): string | undefined {
  const match = /^\/chat\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(location.pathname);
  return match?.[1];
}

async function refreshBot(botId: string): Promise<void> {
  await Promise.all([loadWorkspace(), loadBotResources(botId)]);
  render();
}

function requireActiveBot(): Bot {
  if (!state.activeBot) throw new Error("Choose a bot first.");
  return state.activeBot;
}

function selectedBotId(selectId: string): string {
  const value = document.getElementById(selectId);
  const ownedBots = state.bots.filter((bot) => !bot.collaboratorRole);
  const selected =
    value instanceof HTMLSelectElement
      ? value.value
      : (ownedBots.find((bot) => bot.id === state.botId)?.id ?? ownedBots[0]?.id);
  if (!selected) throw new Error("Create a bot before setting up this feature.");
  return selected;
}

function botBase(botId: string): string {
  return `/v1/bots/${encodeURIComponent(botId)}`;
}

function navigate(route: string): void {
  const nextHash = `#/${route}`;
  if (location.hash === nextHash) void applyRoute();
  else location.hash = nextHash;
}

function setError(error: unknown, factory = false): void {
  const message = asMessage(error);
  if (factory) state.factoryError = message;
  else state.pageError = message;
  render();
}

function asMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401)
    return "This API token is invalid or expired. Reconnect with an active owner token.";
  if (error instanceof ApiError && error.status === 403)
    return `${error.message} Check that this token includes the required scope.`;
  if (error instanceof Error) return error.message;
  return "The request could not be completed.";
}

function showToast(message: string): void {
  const host = document.getElementById("toast-host");
  if (!host) return;
  host.innerHTML = `<div class="toast">${icon("check", 16)}<span>${escapeHtml(message)}</span></div>`;
  window.setTimeout(() => host.replaceChildren(), 3200);
}

async function copyText(value: string, message: string): Promise<void> {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  showToast(message);
}

function openSearch(): void {
  searchOpen = true;
  render();
  renderSearch();
  document.getElementById("workspace-search")?.focus();
}

function closeSearch(): void {
  searchOpen = false;
  const layer = document.getElementById("search-layer");
  if (layer) layer.hidden = true;
}

function renderSearch(): void {
  const layer = document.getElementById("search-layer");
  if (!layer) return;
  layer.hidden = false;
  layer.innerHTML = `<div class="search-backdrop" data-action="dismiss-search"></div><section class="search-dialog" role="dialog" aria-modal="true" aria-label="Search workspace"><div class="search-dialog-input">${icon("search", 19)}<input id="workspace-search" type="search" placeholder="Search bots and pages…" autocomplete="off" /><kbd>ESC</kbd></div><div class="search-results" id="search-results"></div><div class="search-hint"><span>↑↓ to navigate</span><span>Enter to open</span><span>ESC to close</span></div></section>`;
  updateSearchResults("");
}

function updateSearchResults(query: string): void {
  const host = document.getElementById("search-results");
  if (!host) return;
  const term = query.trim().toLowerCase();
  const pages = [
    ["dashboard", "Overview", "home"],
    ["bots", "My bots", "bots"],
    ["create", "Create a bot", "plus"],
    ["skills", "Skills marketplace", "spark"],
    ["mcp", "MCP connections", "plug"],
    ["automation", "Automation", "clock"],
    ["api", "API access", "key"],
    ["security", "Security settings", "shield"],
  ];
  const entries = [
    ...pages
      .filter(([, label]) => String(label).toLowerCase().includes(term))
      .map(([route, label, glyph]) => ({
        route: String(route),
        label: String(label),
        glyph: String(glyph),
        detail: "Workspace",
      })),
    ...state.bots
      .filter((bot) => `${bot.name} ${bot.description}`.toLowerCase().includes(term))
      .map((bot) => ({ route: `bot/${bot.id}/overview`, label: bot.name, glyph: "bots", detail: "Bot" })),
  ];
  host.innerHTML = entries.length
    ? entries
        .slice(0, 9)
        .map(
          (entry) =>
            `<button class="search-result" data-action="search-goto" data-destination="${escapeHtml(entry.route)}">${icon(entry.glyph, 17)}<span>${escapeHtml(entry.label)}</span><small>${escapeHtml(entry.detail)}</small>${icon("arrow", 14)}</button>`,
        )
        .join("")
    : '<div class="search-empty">No matching bots or pages.</div>';
}

function askConfirmation(title: string, description: string, confirmLabel: string, danger = false): Promise<boolean> {
  const layer = document.getElementById("modal-layer");
  if (!layer) return Promise.resolve(false);
  layer.hidden = false;
  layer.innerHTML = `<div class="modal-backdrop"></div><section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description"><span class="confirm-icon ${danger ? "danger" : ""}">${icon(danger ? "shield" : "spark", 22)}</span><h2 id="confirm-title">${escapeHtml(title)}</h2><p id="confirm-description">${escapeHtml(description)}</p><div class="confirm-actions"><button class="button button-secondary" data-confirm="no">Cancel</button><button class="button ${danger ? "button-danger" : "button-primary"}" data-confirm="yes">${escapeHtml(confirmLabel)}</button></div></section>`;
  return new Promise((resolve) => {
    const finish = (result: boolean) => {
      layer.hidden = true;
      layer.replaceChildren();
      resolve(result);
    };
    layer.querySelector('[data-confirm="no"]')?.addEventListener("click", () => finish(false), { once: true });
    layer.querySelector('[data-confirm="yes"]')?.addEventListener("click", () => finish(true), { once: true });
    layer.querySelector(".modal-backdrop")?.addEventListener("click", () => finish(false), { once: true });
    layer.querySelector<HTMLElement>('[data-confirm="yes"]')?.focus();
  });
}
