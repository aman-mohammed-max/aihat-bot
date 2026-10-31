import type { ChatLine, UiState } from "../state.js";
import type { Bot } from "../types.js";
import { button, escapeHtml, formatDate, icon, statusPill } from "../view-utils.js";
import { mcpAuthenticationFields, mcpServerCard, skillCard } from "./workspace.js";

export function botManagementView(state: UiState): string {
  const bot = state.activeBot;
  if (!bot)
    return `<section class="panel empty-panel"><div class="empty-state"><span class="empty-icon">${icon("bots", 24)}</span><h3>Bot not found</h3><p>This bot may have been deleted or may not belong to this workspace.</p><button class="button button-primary" data-route="bots">Back to my bots</button></div></section>`;

  const tabs = [
    ["overview", "Overview", "home"],
    ["configuration", "Configuration", "sliders"],
    ["versions", "History", "clock"],
    ["access", "Access", "shield"],
    ["telegram", "Telegram", "globe"],
    ["files", "Files", "paperclip"],
    ["conversations", "Conversations", "chat"],
    ["memory", "Memory", "spark"],
    ["skills", "Skills", "spark"],
    ["mcp", "MCP tools", "plug"],
    ["automation", "Automation", "clock"],
    ["tool-recovery", "Tool recovery", "shield"],
  ];
  const tabMarkup = tabs
    .map(
      ([id, label, glyph]) =>
        `<button class="detail-tab ${state.botTab === id ? "active" : ""}" data-route="bot/${escapeHtml(bot.id)}/${id}">${icon(glyph ?? "spark", 15)}<span>${label}</span></button>`,
    )
    .join("");

  return `<section class="bot-detail-head"><button class="back-link" data-route="bots">${icon("chevron", 14)} My bots</button><div class="bot-title-line"><span class="bot-avatar bot-avatar-large">${escapeHtml(monogram(bot.name))}</span><div class="bot-title-copy"><div class="bot-name-row"><h2>${escapeHtml(bot.name)}</h2>${statusPill(bot.status)}</div><p>${escapeHtml(bot.description || "No description yet.")}</p></div><div class="bot-head-actions">${bot.status === "published" ? button("Disable", "disable-bot", "secondary", "pause") : bot.status === "disabled" ? button("Enable", "enable-bot", "primary", "play") : ""}<button class="icon-button icon-danger" aria-label="Delete bot" title="Delete bot" data-action="delete-bot">${icon("trash", 17)}</button></div></div><div class="bot-meta-line"><span>Bot ID <code>${escapeHtml(bot.id)}</code></span><span>Version ${bot.version}</span><span>Updated ${escapeHtml(formatDate(bot.updatedAt))}</span><span class="bot-meta-model">${icon("spark", 13)} ${escapeHtml(bot.model.providerId)} / ${escapeHtml(bot.model.model)}</span></div></section>
    <nav class="detail-tabs" aria-label="Bot settings">${tabMarkup}</nav>
    ${state.pageError ? `<div class="alert alert-error" role="alert">${escapeHtml(state.pageError)}</div>` : ""}
    ${renderBotTab(state, bot)}`;
}

function renderBotTab(state: UiState, bot: Bot): string {
  switch (state.botTab) {
    case "configuration":
      return configurationTab(state, bot);
    case "versions":
      return versionsTab(state, bot);
    case "telegram":
      return telegramTab(state);
    case "files":
      return filesTab(state, bot);
    case "access":
      return accessTab(state, bot);
    case "conversations":
      return conversationsTab(state, bot);
    case "memory":
      return memoryTab(state, bot);
    case "skills":
      return skillsTab(state, bot);
    case "mcp":
      return mcpTab(state);
    case "automation":
      return automationTab(state, bot);
    case "tool-recovery":
      return toolRecoveryTab(state, bot);
    default:
      return overviewTab(state, bot);
  }
}

function toolRecoveryTab(state: UiState, bot: Bot): string {
  const records = state.toolRecoveries
    .map((recovery) => {
      const approved = recovery.status === "retry_approved";
      return `<article class="tool-recovery-row"><div class="tool-recovery-icon">${icon(approved ? "clock" : "shield", 18)}</div><div class="tool-recovery-copy"><b>${escapeHtml(recovery.toolName)}</b><small>Key <code title="${escapeHtml(recovery.executionKey)}">${escapeHtml(recovery.executionKey.slice(0, 16))}…</code></small><small>Needs review since ${escapeHtml(formatDate(recovery.ambiguousAt))}</small></div><span class="status-pill ${approved ? "status-paused" : "status-failed"}"><span class="status-dot"></span>${approved ? "Retry approved" : "Review needed"}</span>${approved ? `<span class="field-hint">Waiting for the original request to retry with this key.</span>` : `<div class="tool-recovery-actions"><button class="button button-danger-outline button-small" data-action="resolve-tool-recovery" data-resolution="retry" data-execution-key="${escapeHtml(recovery.executionKey)}">Approve retry</button><button class="button button-secondary button-small" data-action="resolve-tool-recovery" data-resolution="close" data-execution-key="${escapeHtml(recovery.executionKey)}">Close</button></div>`}</article>`;
    })
    .join("");
  return `<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">REMOTE ACTIONS</div><h2>Review uncertain tool calls</h2><p class="panel-subtitle">A timeout can happen after an external service already accepted an action. Calls that could not save a result are paused here for your review.</p></div><span class="quiet-badge">${state.toolRecoveries.length} pending</span></div><div class="alert alert-warning compact-alert">Before approving a retry, check the connected service for the action. Approving may repeat a payment, message, or other external effect. Closing blocks this request from running again. This screen never stores or shows tool input or output.</div></section><section class="panel uploaded-files-panel"><div class="panel-heading"><div><div class="eyebrow">${escapeHtml(bot.name)}</div><h2>Tool execution recovery</h2></div><button class="button button-secondary button-small" data-action="reload-tool-recoveries">Refresh</button></div>${records || `<div class="tools-empty">No tool calls need recovery.</div>`}</section>`;
}

function filesTab(state: UiState, bot: Bot): string {
  const scanningAvailable = state.capabilities?.features.fileMalwareScanning === true;
  const files = state.uploadedFiles.length
    ? `<div class="uploaded-file-list">${state.uploadedFiles
        .map((file) => {
          const statusLabel = {
            pending_scan: "Quarantined",
            clean: "Scan passed",
            rejected: "Rejected",
            scan_failed: "Scan failed",
          }[file.scanStatus];
          const statusClass =
            file.scanStatus === "clean"
              ? "status-connected"
              : file.scanStatus === "rejected"
                ? "status-failed"
                : "status-paused";
          return `<article class="uploaded-file-row"><div class="uploaded-file-icon">${icon(file.contentType.startsWith("image/") ? "image" : "file", 18)}</div><div class="uploaded-file-copy"><b title="${escapeHtml(file.fileName)}">${escapeHtml(file.fileName)}</b><small>${escapeHtml(file.contentType)} · ${formatBytes(file.size)} · added ${escapeHtml(formatDate(file.createdAt))}</small>${file.scanner ? `<small>Scanned by ${escapeHtml(file.scanner)}${file.scannedAt ? ` · ${escapeHtml(formatDate(file.scannedAt))}` : ""}</small>` : ""}</div><span class="status-pill ${statusClass}"><span class="status-dot"></span>${statusLabel}</span><div class="uploaded-file-actions">${file.scanStatus === "clean" ? `<button class="button button-secondary button-small" data-action="download-uploaded-file" data-file-id="${escapeHtml(file.id)}">${icon("download", 14)}<span>Download</span></button>` : ""}${scanningAvailable && (file.scanStatus === "pending_scan" || file.scanStatus === "scan_failed") ? `<button class="button button-secondary button-small" data-action="scan-uploaded-file" data-file-id="${escapeHtml(file.id)}">${icon("shield", 14)}<span>Scan</span></button>` : ""}<button class="icon-button icon-danger" aria-label="Delete ${escapeHtml(file.fileName)}" data-action="delete-uploaded-file" data-file-id="${escapeHtml(file.id)}">${icon("trash", 15)}</button></div></article>`;
        })
        .join("")}</div>`
    : `<div class="tools-empty">No files are stored for ${escapeHtml(bot.name)} yet.</div>`;
  return `<section class="panel form-panel uploaded-files-intro"><div class="panel-heading"><div><div class="eyebrow">BOT FILES</div><h2>Upload reference files</h2><p class="panel-subtitle">Keep private documents and images with this bot. Files are limited to 25 MiB each and 250 MiB per bot.</p></div><span class="quiet-badge">${state.uploadedFiles.length} / 100</span></div>${scanningAvailable ? `<div class="alert alert-info compact-alert">New uploads are scanned before they can be downloaded or used. Infected files are rejected.</div>` : `<div class="alert alert-info compact-alert">Malware scanning is not configured on this runtime. Uploads stay quarantined and cannot be downloaded; configure the scanner before using files with this bot. Telegram attachments are also blocked until scanning is available.</div>`}<form id="uploaded-file-form" class="uploaded-file-form"><label class="field"><span>Choose files</span><input type="file" name="files" accept=".jpg,.jpeg,.png,.webp,.pdf,.txt,.md,.csv,.tsv,.json,.jsonl,.ndjson,.xml,.yaml,.yml,.log,image/jpeg,image/png,image/webp,application/pdf,text/plain,text/markdown,text/csv,text/tab-separated-values,application/json,application/x-ndjson,application/xml,application/yaml" multiple required /><small>Supported: JPEG, PNG, WebP, PDF, TXT, Markdown, CSV, TSV, JSON, JSONL, XML, YAML, and log files. Keep each file under 25 MiB.</small></label><button class="button button-primary" type="submit">${icon("upload", 16)}<span>Upload selected files</span></button></form></section><section class="panel uploaded-files-panel"><div class="panel-heading"><div><div class="eyebrow">PRIVATE STORAGE</div><h2>Files for ${escapeHtml(bot.name)}</h2></div><span class="quiet-badge">${state.uploadedFiles.length} files</span></div>${files}</section>`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function versionsTab(state: UiState, bot: Bot): string {
  const items = state.botVersions
    .map(
      (version) =>
        `<article class="version-history-item"><div class="version-history-head"><div><div class="eyebrow">VERSION ${version.version}</div><h3>${escapeHtml(version.name ?? bot.name)}</h3></div><span class="status-pill ${version.current ? "status-connected" : "status-paused"}"><span class="status-dot"></span>${version.current ? "Current" : "Saved"}</span></div>${version.description ? `<p>${escapeHtml(version.description)}</p>` : ""}<div class="version-history-meta"><span>${escapeHtml(version.model.providerId)} · ${escapeHtml(version.model.model)}</span><span>${version.model.hasCredential ? "Credential connected" : "No model credential"}</span><span>${escapeHtml(formatDate(version.createdAt))}</span></div><details><summary>View system prompt</summary><pre>${escapeHtml(version.systemPrompt)}</pre></details></article>`,
    )
    .join("");
  return `<section class="panel version-history-panel"><div class="panel-heading"><div><div class="eyebrow">CONFIGURATION HISTORY</div><h2>Saved bot versions</h2><p class="panel-subtitle">Each saved edit creates a snapshot. Credential references are never shown in this history.</p></div><span class="quiet-badge">${state.botVersions.length}</span></div>${items ? `<div class="version-history-list">${items}</div>` : `<div class="tools-empty">No version history is available for this bot.</div>`}</section>`;
}

function accessTab(state: UiState, bot: Bot): string {
  const access = state.botAccess;
  const listing = access?.publicListing;
  const canShare = bot.visibility === "shared" || bot.visibility === "invitation" || bot.visibility === "public";
  const visibilityLabel = `${bot.visibility.charAt(0).toUpperCase()}${bot.visibility.slice(1)}`;
  const modeCopy: Record<Bot["visibility"], string> = {
    private: "Only you can use this bot.",
    shared: "Only people with an active grant can use this bot.",
    public: "Any signed-in user can find and use this bot within the limits below.",
    invitation: "Only people who accept an invitation can use this bot.",
  };
  const grants = access?.grants ?? [];
  const grantRows = grants.length
    ? grants
        .map(
          (grant) =>
            `<article class="access-grant-row"><div class="access-grant-icon">${icon(grant.invitationAvailable ? "link" : "user", 16)}</div><div class="access-grant-copy"><b>${grant.userId ? `User ${escapeHtml(grant.userId)}` : grant.invitationAvailable ? "Unused invitation" : "Accepted invitation"}</b><small>${grant.dailyUsageLimit ? `${grant.dailyUsageLimit} requests/day` : "Default daily allowance"} · ${grant.rateLimitPerMinute ? `${grant.rateLimitPerMinute}/min` : "Default rate"}${grant.expiresAt ? ` · Expires ${escapeHtml(formatDate(grant.expiresAt))}` : ""}</small></div><span class="status-pill ${grant.status === "active" ? "status-connected" : "status-paused"}"><span class="status-dot"></span>${escapeHtml(grant.status)}</span>${grant.status === "active" ? `<button class="button button-danger-outline button-small" data-action="revoke-bot-grant" data-grant-id="${escapeHtml(grant.id)}">Revoke</button>` : ""}</article>`,
        )
        .join("")
    : `<div class="tools-empty">No direct grants or invitations yet.</div>`;

  return `<section class="panel access-overview"><div class="panel-heading"><div><div class="eyebrow">WHO CAN USE THIS BOT</div><h2>${escapeHtml(visibilityLabel)} access</h2><p class="panel-subtitle">${escapeHtml(modeCopy[bot.visibility])}</p></div><span class="quiet-badge">${escapeHtml(bot.visibility)}</span></div>${bot.visibility === "private" ? '<div class="alert alert-info compact-alert">This bot is private. Choose a wider visibility during setup before publishing to create invitations or a public listing.</div>' : ""}${bot.status !== "published" ? '<div class="alert alert-info compact-alert">Access takes effect when this bot is published and enabled.</div>' : ""}</section>
    ${listing ? `<section class="panel form-panel access-policy-panel"><div class="panel-heading"><div><div class="eyebrow">PUBLIC BOT LIMITS</div><h2>Set per-user usage limits</h2><p class="panel-subtitle">These limits apply independently to each signed-in user.</p></div><span class="quiet-badge">/${escapeHtml(listing.slug)}</span></div><form id="bot-access-policy-form" class="form-grid"><label class="field"><span>Requests per UTC day</span><input type="number" name="dailyUsageLimit" value="${listing.dailyUsageLimit}" min="1" max="10000" required /></label><label class="field"><span>Requests per minute</span><input type="number" name="rateLimitPerMinute" value="${listing.rateLimitPerMinute}" min="1" max="600" required /></label><div class="form-actions field-wide"><p class="field-hint">A signed-in user can still be individually revoked below.</p><button class="button button-primary" type="submit">Save limits</button></div></form></section>` : bot.visibility === "public" ? `<section class="panel info-panel"><div class="eyebrow">PUBLIC LISTING</div><h2>Publish this bot to list it</h2><p class="panel-subtitle">The public listing appears after the bot is published. Per-user limits can be set here afterward.</p></section>` : ""}
    ${canShare ? `<section class="content-grid access-create-grid"><section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">DIRECT ACCESS</div><h2>Grant a signed-in user</h2><p class="panel-subtitle">Use the user ID shown in their workspace settings.</p></div></div><form id="bot-user-grant-form" class="stack-form"><label class="field"><span>User ID</span><input name="userId" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,127}" placeholder="user ID from Settings" /></label><div class="form-grid"><label class="field"><span>Daily requests <small>optional</small></span><input type="number" name="dailyUsageLimit" min="1" max="10000" placeholder="Default" /></label><label class="field"><span>Requests per minute <small>optional</small></span><input type="number" name="rateLimitPerMinute" min="1" max="600" placeholder="Default" /></label></div><label class="field"><span>Expiry <small>optional</small></span><input name="expiresAt" type="datetime-local" /></label><button class="button button-secondary" type="submit">Grant access</button></form></section>${bot.visibility === "shared" || bot.visibility === "invitation" ? `<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">ONE-TIME INVITATION</div><h2>Create an invite token</h2><p class="panel-subtitle">The token is shown once. The recipient must sign in and accept it.</p></div></div><form id="bot-invitation-form" class="stack-form"><div class="form-grid"><label class="field"><span>Daily requests <small>optional</small></span><input type="number" name="dailyUsageLimit" min="1" max="10000" placeholder="Default" /></label><label class="field"><span>Requests per minute <small>optional</small></span><input type="number" name="rateLimitPerMinute" min="1" max="600" placeholder="Default" /></label></div><label class="field"><span>Expiry <small>optional</small></span><input name="expiresAt" type="datetime-local" /></label><button class="button button-primary" type="submit">Create invitation</button></form>${state.invitationToken ? `<div class="one-time-invitation"><div><b>Copy this invitation token now</b><code>${escapeHtml(state.invitationToken)}</code></div><button class="button button-secondary button-small" data-action="copy-invitation">${icon("copy", 14)}<span>Copy</span></button></div>` : ""}</section>` : ""}</section>` : ""}
    ${canShare ? `<section class="panel access-grants-panel"><div class="panel-heading"><div><div class="eyebrow">ACCESS GRANTS</div><h2>People and invitations</h2><p class="panel-subtitle">Revoking access takes effect on their next message.</p></div><span class="quiet-badge">${grants.length}</span></div><div class="access-grant-list">${grantRows}</div></section>` : ""}`;
}

function conversationsTab(state: UiState, bot: Bot): string {
  const selected = state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
  const list = state.conversations.length
    ? state.conversations
        .map(
          (conversation) =>
            `<button class="conversation-card ${conversation.id === state.selectedConversationId ? "active" : ""}" data-route="bot/${encodeURIComponent(bot.id)}/conversations/${encodeURIComponent(conversation.id)}"><span class="conversation-card-top"><span class="conversation-platform">${icon(conversation.platform === "telegram" ? "globe" : "chat", 14)} ${escapeHtml(platformLabel(conversation.platform))}</span><span>${escapeHtml(formatDate(conversation.updatedAt))}</span></span><b>${escapeHtml(conversation.preview || "No text preview")}</b><small>${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"}</small></button>`,
        )
        .join("")
    : `<div class="conversation-list-empty"><span class="empty-icon">${icon("chat", 20)}</span><b>No conversations yet</b><span>Messages sent to this bot will appear here.</span></div>`;
  const messages = state.conversationMessages.length
    ? state.conversationMessages
        .map(
          (message) =>
            `<article class="history-message history-${message.role}"><div class="history-message-meta"><b>${escapeHtml(message.role === "tool" ? (message.name ?? "Tool") : message.role === "assistant" ? bot.name : "User")}</b><span>${escapeHtml(formatDate(message.createdAt))}</span></div><p>${escapeHtml(message.content || (message.role === "tool" ? "Tool returned no text." : ""))}</p>${message.toolCallId ? `<code class="history-tool-id">Call ${escapeHtml(message.toolCallId)}</code>` : ""}</article>`,
        )
        .join("")
    : `<div class="conversation-detail-empty"><span class="preview-empty-orb">${icon("chat", 23)}</span><b>${selected ? "This conversation has no messages." : "Select a conversation"}</b><span>${selected ? "Stored message history is empty." : "Choose a session from the list to inspect its messages."}</span></div>`;

  return `<section class="conversation-workspace"><aside class="panel conversation-list-panel"><div class="panel-heading"><div><div class="eyebrow">BOT ACTIVITY</div><h2>Conversations</h2><p class="panel-subtitle">Private owner view · ${escapeHtml(bot.name)}</p></div><span class="quiet-badge">${state.conversations.length}</span></div><div class="conversation-list">${list}</div></aside><section class="panel conversation-detail-panel"><div class="conversation-detail-head"><div><div class="eyebrow">MESSAGE HISTORY</div><h2>${selected ? escapeHtml(platformLabel(selected.platform)) : "Conversation"}</h2><p>${selected ? `${selected.messageCount} messages · Updated ${escapeHtml(formatDate(selected.updatedAt))}` : "Choose a conversation to view its stored messages."}</p></div>${selected ? `<code>${escapeHtml(selected.id)}</code>` : ""}</div>${selected && state.conversationHasMore ? `<button class="button button-secondary button-small conversation-load-older" data-action="load-older-conversation-messages">${icon("chevron", 14)} Load older messages</button>` : ""}<div class="conversation-thread">${messages}</div></section></section>`;
}

function platformLabel(platform: string): string {
  switch (platform) {
    case "telegram":
      return "Telegram";
    case "web_chat":
      return "Web chat";
    case "api":
      return "API";
    default:
      return "Internal";
  }
}

function memoryTab(state: UiState, bot: Bot): string {
  const records = state.memoryRecords;
  const recordList = records.length
    ? `<div class="memory-record-list">${records
        .map((record) => {
          const expired = record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now();
          return `<article class="memory-record ${expired ? "memory-expired" : ""}"><div class="memory-record-head"><span class="memory-key">${escapeHtml(record.key)}</span><span class="quiet-badge">${expired ? "Expired" : record.expiresAt ? `Until ${escapeHtml(formatDate(record.expiresAt))}` : "No expiry"}</span><button class="icon-button icon-danger" aria-label="Delete memory note ${escapeHtml(record.key)}" data-action="delete-memory-record" data-memory-key="${escapeHtml(record.key)}">${icon("trash", 15)}</button></div><p>${escapeHtml(record.value)}</p><small>Updated ${escapeHtml(formatDate(record.updatedAt))}</small></article>`;
        })
        .join("")}</div>`
    : `<div class="tools-empty">No owner notes are saved for this bot.</div>`;
  return `<section class="panel memory-intro"><div class="panel-heading"><div><div class="eyebrow">LONG-TERM MEMORY</div><h2>Keep a small set of useful facts</h2><p class="panel-subtitle">Owner-written notes are encrypted at rest and added to the bot’s context only while memory is enabled.</p></div><span class="quiet-badge">${records.length} / 16</span></div><div class="alert alert-info compact-alert">Notes are encrypted at rest and shared as reference context across this bot’s conversations. Don’t store passwords, API keys, or other secrets here. Memory text is treated as untrusted data by the agent.</div><form id="memory-toggle-form" class="memory-toggle-form"><label class="check-row"><input type="checkbox" name="enabled" value="true" ${bot.memoryEnabled ? "checked" : ""} /><span><b>Enable persistent notes for this bot</b><small>${bot.memoryEnabled ? "Saved notes are included in agent context." : "Saved notes are stored but not included in agent context."}</small></span></label><button class="button button-secondary button-small" type="submit">Save setting</button></form></section>
    <section class="panel form-panel memory-form-panel"><div class="panel-heading"><div><div class="eyebrow">NEW OR UPDATED NOTE</div><h2>Add a memory</h2></div><span class="quiet-badge">${records.length >= 16 ? "Limit reached · existing keys can update" : "Up to 2,000 characters"}</span></div><form id="memory-record-form" class="form-grid"><label class="field"><span>Memory key</span><input name="key" required maxlength="80" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="dietary_preferences" /><small>Saving the same key replaces its current note.</small></label><label class="field"><span>Optional expiry</span><input name="expiresAt" type="datetime-local" /><small>Notes can expire within one year.</small></label><label class="field field-wide"><span>Note</span><textarea name="value" rows="3" required maxlength="2000" placeholder="Prefers vegetarian lunches and avoids peanuts."></textarea></label><div class="form-actions field-wide"><p class="field-hint">The bot can use this note in future responses when persistent memory is enabled.</p><button class="button button-primary" type="submit">${icon("plus", 16)}<span>Save memory note</span></button></div></form></section>
    <section class="panel memory-record-panel"><div class="panel-heading"><div><div class="eyebrow">SAVED NOTES</div><h2>For ${escapeHtml(bot.name)}</h2></div><span class="quiet-badge">${records.length}</span></div>${recordList}</section>`;
}

function overviewTab(state: UiState, bot: Bot): string {
  const installedCount = state.installedSkills.filter((skill) => skill.enabled).length;
  const connected = state.telegram?.status === "active";
  return `<div class="content-grid bot-overview-grid"><section class="panel preview-panel"><div class="panel-heading"><div><div class="eyebrow">LIVE PREVIEW</div><h2>Talk to ${escapeHtml(bot.name)}</h2></div><span class="preview-model">${icon("spark", 14)} ${escapeHtml(bot.model.model)}</span></div><div class="preview-transcript" id="chat-transcript">${state.chatLines.length ? state.chatLines.map(renderChatLine).join("") : `<div class="preview-empty"><span class="preview-empty-orb">${icon("chat", 23)}</span><b>Give your assistant a first prompt.</b><span>This preview uses the same agent engine as your bot.</span></div>`}</div><form id="chat-form" class="chat-composer"><textarea name="message" rows="1" maxlength="10000" placeholder="Ask ${escapeHtml(bot.name)} anything…" required></textarea><button class="send-button" type="submit" aria-label="Send message" ${bot.status === "disabled" ? "disabled" : ""}>${icon("send", 17)}</button></form><div class="preview-foot"><span>${icon("shield", 13)} Private owner preview</span><span>Messages persist in the bot conversation store</span></div></section>
    <aside class="bot-side-stack"><section class="panel bot-status-panel"><div class="panel-heading"><div><div class="eyebrow">BOT HEALTH</div><h2>Connected pieces</h2></div>${statusPill(bot.status)}</div><div class="health-list"><div><span class="health-icon health-blue">${icon("globe", 15)}</span><span><b>Telegram</b><small>${connected ? `@${escapeHtml(state.telegram?.telegramBotId ?? "connected")}` : "Not connected"}</small></span>${connected ? '<span class="health-check">✓</span>' : `<button class="text-button" data-route="bot/${escapeHtml(bot.id)}/telegram">Set up</button>`}</div><div><span class="health-icon health-mint">${icon("spark", 15)}</span><span><b>Enabled skills</b><small>${installedCount} active capability${installedCount === 1 ? "" : "ies"}</small></span><button class="text-button" data-route="bot/${escapeHtml(bot.id)}/skills">Review</button></div><div><span class="health-icon health-purple">${icon("plug", 15)}</span><span><b>MCP servers</b><small>${state.servers.filter((server) => server.status === "connected").length} connected</small></span><button class="text-button" data-route="bot/${escapeHtml(bot.id)}/mcp">Review</button></div></div></section>
      <section class="panel prompt-snapshot"><div class="panel-heading"><div><div class="eyebrow">PERSONALITY</div><h2>System prompt</h2></div><button class="icon-button" data-route="bot/${escapeHtml(bot.id)}/configuration" aria-label="Edit system prompt">${icon("sliders", 16)}</button></div><p>${escapeHtml(bot.systemPrompt || "No system prompt set.")}</p><button class="text-button" data-route="bot/${escapeHtml(bot.id)}/configuration">Edit configuration ${icon("arrow", 14)}</button></section>
      <section class="miniapp-bot-card"><div class="miniapp-orb">${icon("globe", 17)}</div><div><b>Telegram Web App</b><small>Open the bot settings to copy your launch URL.</small></div><button class="icon-button" data-route="bot/${escapeHtml(bot.id)}/telegram" aria-label="Open Telegram settings">${icon("arrow", 15)}</button></section></aside></div>`;
}

function configurationTab(state: UiState, bot: Bot): string {
  const params = bot.model.parameters ?? {};
  const temperature = typeof params.temperature === "number" ? params.temperature : 0.7;
  return `<section class="panel form-panel config-form-panel"><div class="panel-heading"><div><div class="eyebrow">BOT IDENTITY</div><h2>Make it sound and behave like yours</h2><p class="panel-subtitle">Saving creates version ${bot.version + 1}. Current version ${bot.version} stays available in storage.</p></div><span class="quiet-badge">v${bot.version}</span></div>
    <form id="bot-config-form" class="stack-form"><input type="hidden" name="expectedVersion" value="${bot.version}" /><div class="form-grid"><label class="field"><span>Bot name</span><input name="name" value="${escapeHtml(bot.name)}" required minlength="1" maxlength="80" /></label><label class="field"><span>Short description</span><input name="description" value="${escapeHtml(bot.description)}" maxlength="2000" /></label><label class="field field-wide"><span>System prompt</span><textarea name="systemPrompt" rows="8" required maxlength="12000">${escapeHtml(bot.systemPrompt)}</textarea><small>Give the model its role, style, and boundaries. Treat tool output as untrusted input.</small></label></div><div class="form-actions"><p class="field-hint">Bot name, description, and prompt changes create a new version. Model credentials are managed separately with explicit confirmation.</p><button class="button button-primary" type="submit">${icon("check", 16)}<span>Save bot settings</span></button></div></form></section>
    <section class="panel model-readonly"><div class="panel-heading"><div><div class="eyebrow">MODEL PROVIDER</div><h2>Generation settings</h2></div><span class="quiet-badge">${bot.model.hasCredential ? "Credential encrypted" : "No bot credential"}</span></div><div class="model-readonly-grid"><div><span>Provider</span><b>${escapeHtml(bot.model.providerId)}</b></div><div><span>Chat model</span><b>${escapeHtml(bot.model.model)}</b></div><div><span>Image model</span><b>${escapeHtml(bot.model.imageModel || "Not selected")}</b></div><div><span>Search model</span><b>${escapeHtml(bot.model.searchModel || "Not selected")}</b></div><div class="model-endpoint"><span>API endpoint</span><code>${escapeHtml(bot.model.endpoint ?? "Provider default")}</code></div><div><span>Temperature</span><b>${escapeHtml(temperature)}</b></div></div><p class="field-hint">The API key is never returned to this page. The key is sent only to the configured model endpoint.</p>
      <form id="bot-model-form" class="stack-form credential-rotation-form"><input type="hidden" name="expectedVersion" value="${bot.version}" /><div class="form-grid"><label class="field"><span>Provider ID</span><input name="providerId" value="${escapeHtml(bot.model.providerId)}" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" /></label><label class="field"><span>Chat model ID</span><input name="model" value="${escapeHtml(bot.model.model)}" required maxlength="128" /></label><label class="field"><span>Image model ID <small>optional</small></span><input name="imageModel" value="${escapeHtml(bot.model.imageModel ?? "")}" maxlength="128" placeholder="gpt-image-1" /></label><label class="field"><span>Search model ID <small>optional</small></span><input name="searchModel" value="${escapeHtml(bot.model.searchModel ?? "")}" maxlength="128" placeholder="Provider search model" /></label><label class="field field-wide"><span>HTTPS API endpoint <small>optional</small></span><input name="endpoint" type="url" value="${escapeHtml(bot.model.endpoint ?? "")}" placeholder="https://api.example.com/v1" /></label><label class="field"><span>Temperature</span><input name="temperature" type="number" min="0" max="2" step="0.1" value="${temperature}" required /></label><label class="field field-wide"><span>New model API key</span><input name="credential" type="password" autocomplete="new-password" maxlength="65536" placeholder="Enter a new provider key" required /></label></div><div class="form-actions"><p class="field-hint">Changing provider settings also replaces the credential and saves a new version. The endpoint must be allowed by the deployment before model requests can reach it. You’ll confirm before the key is encrypted.</p><button class="button button-primary" type="submit">${icon("shield", 15)}<span>Save model settings</span></button></div></form>
      <form id="bot-credential-form" class="stack-form credential-rotation-form"><input type="hidden" name="expectedVersion" value="${bot.version}" /><label class="field"><span>${bot.model.hasCredential ? "Replace model API key" : "Connect model API key"}</span><input name="credential" type="password" autocomplete="new-password" maxlength="65536" placeholder="Enter a new provider key" required /></label><div class="form-actions"><p class="field-hint">Replace only the key while keeping the provider settings. You’ll confirm before the new key is encrypted.</p><button class="button button-secondary" type="submit">${icon("key", 15)}<span>${bot.model.hasCredential ? "Replace key only" : "Connect key only"}</span></button></div></form></section>${modelRetryPolicyPanel(bot)}${ownershipTransferPanel(state)}`;
}

function ownershipTransferPanel(state: UiState): string {
  const transfer = state.botOwnershipTransfer;
  const pending = transfer.item;
  const pendingMarkup = pending
    ? `<div class="transfer-pending"><div><b>Waiting for recipient</b><small>${escapeHtml(pending.toOwnerId)} · expires ${escapeHtml(formatDate(pending.expiresAt))}</small></div><button class="button button-danger-outline button-small" data-action="revoke-bot-ownership-transfer" data-transfer-id="${escapeHtml(pending.id)}">Revoke transfer</button></div>`
    : `<form id="bot-ownership-transfer-form" class="form-grid"><label class="field field-wide"><span>New owner · active workspace member ID</span><input name="targetUserId" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,127}" autocomplete="off" placeholder="user_…" /></label><div class="form-actions field-wide"><p class="field-hint">The transfer expires in 24 hours. The recipient must accept it from Security settings. Scheduled tasks pause until the new owner reviews their recipients.</p><button class="button button-danger-outline" type="submit">${icon("shield", 15)}<span>Offer ownership transfer</span></button></div></form>`;
  const tokenReveal = transfer.token
    ? `<div class="one-time-invitation"><div><b>Copy this recipient-only token now</b><code>${escapeHtml(transfer.token)}</code><small>Shown once; expires ${escapeHtml(formatDate(pending?.expiresAt))}. Share it only with ${escapeHtml(pending?.toOwnerId ?? "the chosen recipient")}.</small></div><button class="button button-secondary button-small" data-action="copy-bot-ownership-token">${icon("copy", 14)}<span>Copy token</span></button></div>`
    : "";
  return `<section class="panel form-panel ownership-transfer-panel"><div class="panel-heading"><div><div class="eyebrow">BOT OWNERSHIP</div><h2>Transfer this bot</h2><p class="panel-subtitle">A transfer changes the owner only after the named workspace member accepts. The previous owner loses bot access.</p></div><span class="quiet-badge">${pending ? "Pending" : "Owner only"}</span></div>${pendingMarkup}${tokenReveal}</section>`;
}

function modelRetryPolicyPanel(bot: Bot): string {
  const policy = bot.model.retryPolicy;
  const mode = policy ? "bot" : "deployment";
  const maxAttempts = policy?.maxAttempts ?? 2;
  const backoffMs = policy?.backoffMs ?? 250;
  return `<section class="panel form-panel model-retry-panel"><div class="panel-heading"><div><div class="eyebrow">RETRY POLICY</div><h2>Model request retries</h2><p class="panel-subtitle">A per-bot override is saved as a new configuration version.</p></div><span class="quiet-badge">${policy ? "Bot override" : "Deployment default"}</span></div><form id="bot-retry-policy-form" class="stack-form"><input type="hidden" name="expectedVersion" value="${bot.version}" /><div class="form-grid"><label class="field field-wide"><span>Policy</span><select name="mode"><option value="deployment" ${mode === "deployment" ? "selected" : ""}>Use deployment defaults</option><option value="bot" ${mode === "bot" ? "selected" : ""}>Set a policy for this bot</option></select></label><label class="field"><span>Maximum attempts <small>including first request</small></span><select name="maxAttempts">${[1, 2, 3].map((attempts) => `<option value="${attempts}" ${attempts === maxAttempts ? "selected" : ""}>${attempts}</option>`).join("")}</select></label><label class="field"><span>Initial backoff <small>milliseconds</small></span><input name="backoffMs" type="number" min="0" max="3000" step="50" value="${backoffMs}" required /></label></div><div class="form-actions"><p class="field-hint">Overrides can make up to 3 attempts with 0–3000 ms initial backoff. Later delays double. Only transient HTTP responses retry; streaming and ambiguous network failures are not replayed. The deployment still controls the Retry-After ceiling and eligible statuses.</p><button class="button button-secondary" type="submit">${icon("sliders", 15)}<span>Save retry policy</span></button></div></form></section>`;
}

function telegramTab(state: UiState): string {
  const settings = state.telegram;
  const isConnected = settings?.status === "active";
  const appUrl = `${location.origin}/miniapp/`;
  const allowed = settings?.allowedUserIds ?? [];
  const pending = settings?.pendingUserIds ?? [];
  const senderLines = allowed.join(", ");
  return `<div class="content-grid telegram-grid"><section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">TELEGRAM BOT API</div><h2>${isConnected ? "Bot connected" : "Connect a Telegram bot"}</h2><p class="panel-subtitle">Each bot has an isolated encrypted token and webhook route.</p></div>${statusPill(settings?.status ?? "not_connected")}</div>
      ${isConnected ? `<div class="connected-banner"><span class="connected-mark">${icon("check", 18)}</span><div><b>@${escapeHtml(settings?.telegramBotId ?? "Telegram bot")}</b><small>Webhook registered · owner approval required for new senders</small></div>${button("Disconnect", "disconnect-telegram", "danger-outline", "trash")}</div>` : `<form id="telegram-connect-form" class="stack-form"><label class="field"><span>BotFather token</span><input name="token" type="password" autocomplete="new-password" placeholder="123456789:AA…" required /></label><p class="field-hint">The server validates the token with Telegram and encrypts it at rest. The token is never returned by the API.</p><button class="button button-primary" type="submit">${icon("plug", 16)}<span>Connect Telegram</span></button></form>`}
      ${
        isConnected
          ? `<div class="sender-access"><div class="section-divider"></div><div class="subsection-heading"><div><h3>Sender access</h3><p>New Telegram users remain pending until you approve their numeric ID.</p></div><span class="quiet-badge">${allowed.length} allowed · ${pending.length} pending</span></div>
        ${pending.length ? `<div class="pending-box"><div class="eyebrow">WAITING FOR APPROVAL</div><div class="pending-users">${pending.map((id) => `<label class="pending-user"><input type="checkbox" name="pendingIds" form="telegram-allowlist-form" value="${id}" /><span>${id}</span><small>Pending · check to approve</small></label>`).join("")}</div></div>` : ""}
        <form id="telegram-allowlist-form" class="stack-form"><label class="field"><span>Approved Telegram user IDs</span><textarea name="allowedUserIds" rows="3" placeholder="One numeric Telegram user ID per line">${escapeHtml(senderLines)}</textarea></label><p class="field-hint">Save the complete allowlist. Up to 100 unique numeric IDs are accepted. Pending IDs are approved only when you check them above.</p><button class="button button-secondary" type="submit">${icon("shield", 15)}<span>Save sender access</span></button></form>
        <div class="tool-grant-area"><div class="subsection-heading"><div><h3>Per-user tool access</h3><p>Approved senders need an explicit grant for every skill or MCP tool.</p></div></div>${allowed.length ? allowed.map((id) => `<div class="grant-user-row"><span class="telegram-user-avatar">${String(id).slice(-2)}</span><span><b>Telegram user ${id}</b><small>Owner-approved sender</small></span><button class="button button-secondary button-small" data-action="load-telegram-grants" data-user-id="${id}">Manage tools</button></div>${state.selectedGrantUserId === id ? renderTelegramGrants(state, id) : ""}`).join("") : '<p class="field-hint">Add and approve a sender before setting per-user tool grants.</p>'}</div></div>`
          : ""
      }
    </section>
    <aside class="stack-panels"><section class="panel miniapp-settings"><div class="eyebrow">TELEGRAM MINI APP</div><div class="miniapp-title"><span class="miniapp-orb">${icon("globe", 18)}</span><h2>Bring this workspace into Telegram</h2></div><p>Use the HTTPS address below for the configured AI Hat master bot. Other bot launches can use owner-token sign-in.</p><div class="copy-url"><code>${escapeHtml(appUrl)}</code><button class="icon-button" data-action="copy-miniapp-url" aria-label="Copy URL">${icon("copy", 16)}</button></div><div class="botfather-steps"><div><span>01</span><p>Open <b>@BotFather → /mybots</b> and select the master bot configured by the operator.</p></div><div><span>02</span><p>Set <b>Main Mini App</b> for a profile launch button, or use <b>/setmenubutton</b> for the chat menu.</p></div><div><span>03</span><p>Paste the public HTTPS URL and save.</p></div></div><div class="alert alert-info compact-alert">${state.capabilities?.features.telegramMiniAppAuth ? "Master-bot launches sign in with verified Telegram identity. Other bot launches need an owner API token." : "Automatic Telegram sign-in is unavailable until TELEGRAM_MASTER_BOT_TOKEN is configured; use an owner API token meanwhile."}</div></section>
      <section class="panel webhook-panel"><div class="eyebrow">WEBHOOK ROUTING</div><h3>Secure by default</h3><p>Each Telegram deployment has a random webhook secret header. Invalid requests are rejected before the stored bot token is read.</p><code>/webhooks/telegram/dep_…</code></section></aside></div>`;
}

function renderTelegramGrants(state: UiState, userId: number): string {
  const refs = [
    ...state.installedSkills.map((skill) => ({ id: `skill:${skill.id}`, label: `Skill · ${skill.name}` })),
    ...state.servers.flatMap((server) =>
      (state.toolsByServer[server.id] ?? []).map((tool) => ({
        id: `mcp:${server.id}:${tool.name}`,
        label: `MCP · ${server.name} / ${tool.name}`,
      })),
    ),
  ];
  return `<form class="grant-form" id="telegram-grants-form" data-user-id="${userId}"><div class="eyebrow">USER ${userId} · TOOL GRANTS</div>${refs.length ? refs.map((ref) => `<label class="permission-check"><input type="checkbox" name="toolRefs" value="${escapeHtml(ref.id)}" ${state.selectedGrantRefs.includes(ref.id) ? "checked" : ""} /><span>${escapeHtml(ref.label)}</span></label>`).join("") : '<p class="field-hint">Install a skill or connect an MCP server to grant individual tools.</p>'}<button class="button button-primary button-small" type="submit">Save tool grants</button></form>`;
}

function skillsTab(state: UiState, bot: Bot): string {
  const installed = state.installedSkills;
  const available = state.catalog.filter((skill) => !installed.some((item) => item.id === skill.id));
  return `<section class="panel installed-panel"><div class="panel-heading"><div><div class="eyebrow">ACTIVE ON THIS BOT</div><h2>Installed skills</h2><p class="panel-subtitle">A tool is discoverable only when both bot-level and Telegram sender permissions allow it.</p></div><span class="quiet-badge">${installed.length} installed</span></div>
    ${installed.length ? `<div class="installed-skill-list">${installed.map((skill) => `<article class="installed-skill"><span class="skill-symbol">${icon("spark", 18)}</span><div class="installed-skill-copy"><h3>${escapeHtml(skill.name)}</h3><p>${escapeHtml(skill.description)}</p><div class="permission-tags">${(skill.grantedPermissions ?? []).length ? skill.grantedPermissions?.map((grant) => `<code>${escapeHtml(grant)}</code>`).join("") : '<span class="muted-text">No permissions granted</span>'}</div></div><span class="status-pill ${skill.enabled ? "status-connected" : "status-paused"}"><span class="status-dot"></span>${skill.enabled ? "enabled" : "disabled"}</span><button class="button button-secondary button-small" data-action="toggle-skill" data-skill-id="${escapeHtml(skill.id)}" data-enabled="${skill.enabled ? "false" : "true"}">${skill.enabled ? "Disable" : "Enable"}</button><button class="icon-button icon-danger" aria-label="Uninstall ${escapeHtml(skill.name)}" data-action="uninstall-skill" data-skill-id="${escapeHtml(skill.id)}">${icon("trash", 16)}</button></article>`).join("")}</div>` : '<div class="tools-empty">No skills are installed on this bot.</div>'}</section>
    <section class="panel install-panel"><div class="panel-heading"><div><div class="eyebrow">CATALOG</div><h2>Add a skill</h2></div><button class="text-button" data-route="skills">Browse all ${icon("arrow", 15)}</button></div>${available.length ? `<div class="skill-grid">${available.map((skill) => skillCard(skill, bot.id)).join("")}</div>` : `<p class="field-hint">${state.catalog.length ? "Every catalog skill is already installed." : "The workspace skill catalog is empty."}</p>`}</section>`;
}

function mcpTab(state: UiState): string {
  return `<section class="panel intro-panel"><div class="intro-icon intro-teal">${icon("plug", 21)}</div><div class="intro-copy"><div class="eyebrow">BOT-SCOPED CONNECTIONS</div><h2>Remote tools, reviewed here.</h2><p>Newly discovered tools are disabled. Grant <code>mcp:invoke</code> only after reviewing the server and tool schema.</p></div></section>
    <section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">NEW CONNECTION</div><h2>Add an MCP server</h2></div><span class="quiet-badge">HTTPS only</span></div><form id="mcp-add-form" class="form-grid"><label class="field"><span>Connection name</span><input name="name" placeholder="Company knowledge" required maxlength="80" /></label><label class="field field-wide"><span>Streamable HTTP endpoint</span><input name="endpoint" type="url" placeholder="https://tools.example.com/mcp" required /></label>${mcpAuthenticationFields()}<div class="form-actions field-wide"><p class="field-hint">The MCP endpoint and OAuth issuer must use approved origins in <code>MCP_ALLOWED_ORIGINS</code>. Credentials are encrypted and sent only after origin checks.</p><button class="button button-primary" type="submit">${icon("plus", 16)}<span>Add server</span></button></div></form></section>
    <section class="server-list">${state.servers.length ? state.servers.map((server) => mcpServerCard(server, state.toolsByServer[server.id] ?? [])).join("") : `<section class="panel empty-panel"><div class="empty-state"><span class="empty-icon">${icon("plug", 24)}</span><h3>No server attached</h3><p>Add a trusted HTTPS MCP endpoint to give this bot reviewed tools.</p></div></section>`}</section>`;
}

function automationTab(state: UiState, bot: Bot): string {
  const tasks = state.tasks;
  return `<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">AUTOMATION</div><h2>Create a scheduled task</h2><p class="panel-subtitle">The task prompt and execution result are stored durably.</p></div><span class="quiet-badge">${bot.status === "published" ? "Published" : "Publish to enable"}</span></div><form id="schedule-form" class="form-grid"><label class="field"><span>Repeat</span><select name="repeat"><option value="once">One time</option><option value="daily">Every day</option></select></label><label class="field" data-schedule-once><span>Date and time</span><input name="runAt" type="datetime-local" /></label><label class="field" data-schedule-daily hidden><span>Time of day</span><input name="dailyAt" type="time" value="09:00" /></label><label class="field"><span>Timezone</span><input name="timezone" value="${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}" required /></label><label class="field"><span>Approved Telegram user ID</span><input name="notifyTelegramUserId" inputmode="numeric" placeholder="123456789" required /></label><label class="field field-wide"><span>Bot instruction</span><textarea name="prompt" rows="3" placeholder="Summarize the last 24 hours and send the key points." required maxlength="10000"></textarea></label><div class="form-actions field-wide"><p class="field-hint">Requires a published bot, an active Telegram deployment, and an approved recipient.</p><button class="button button-primary" type="submit">${icon("plus", 16)}<span>Save schedule</span></button></div></form></section>
    <section class="panel task-panel"><div class="panel-heading"><div><div class="eyebrow">SCHEDULED RUNS</div><h2>For ${escapeHtml(bot.name)}</h2></div><span class="quiet-badge">${tasks.length}</span></div>${tasks.length ? `<div class="table-wrap"><table><thead><tr><th>Instruction</th><th>Next run</th><th>Recipient</th><th>Status</th><th></th></tr></thead><tbody>${tasks.map((task) => taskRow(task)).join("")}</tbody></table></div>` : '<div class="tools-empty">No schedules for this bot yet.</div>'}</section>`;
}

function taskRow(task: import("../types.js").ScheduledTask): string {
  const schedule = task.schedule.startsWith("daily:")
    ? `Daily · ${task.schedule.slice(6)} · ${task.timezone}`
    : formatDate(task.nextRunAt);
  const control =
    task.status === "active" || task.status === "paused"
      ? `<button class="button button-secondary button-small" data-action="toggle-task" data-task-id="${escapeHtml(task.id)}" data-status="${task.status}">${task.status === "active" ? "Pause" : "Resume"}</button>`
      : task.status === "failed"
        ? `<button class="button button-secondary button-small" data-action="retry-task" data-task-id="${escapeHtml(task.id)}">Retry run</button>`
        : "—";
  return `<tr><td><b>${escapeHtml(task.prompt.slice(0, 56))}${task.prompt.length > 56 ? "…" : ""}</b><small>${escapeHtml(schedule)}</small></td><td>${escapeHtml(formatDate(task.nextRunAt))}</td><td><code>${task.notifyTelegramUserId}</code></td><td>${statusPill(task.status)}</td><td>${control}</td></tr>`;
}

function renderChatLine(line: ChatLine): string {
  const images = (line.attachments ?? [])
    .slice(0, 4)
    .flatMap((attachment) => {
      try {
        const url = new URL(attachment.url);
        if (attachment.kind !== "image" || url.protocol !== "https:" || url.username || url.password) return [];
        return [
          `<img class="chat-image-attachment" src="${escapeHtml(url.toString())}" alt="${escapeHtml(attachment.alt || "Generated image")}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`,
        ];
      } catch {
        return [];
      }
    })
    .join("");
  return `<div class="chat-line chat-${line.role}"><span class="chat-avatar">${line.role === "assistant" ? icon("botfather", 15) : "You"}</span><div class="chat-line-body"><p>${escapeHtml(line.content)}</p>${images}</div></div>`;
}

function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length > 1
    ? `${words[0]?.[0] ?? "B"}${words[1]?.[0] ?? ""}`.toUpperCase()
    : (words[0]?.slice(0, 2) ?? "AI").toUpperCase();
}
