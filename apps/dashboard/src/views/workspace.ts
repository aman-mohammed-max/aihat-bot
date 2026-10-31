import type { UiState } from "../state.js";
import type { ApiScope, Bot, McpServer, ScheduledTask, Skill, UsageSummary } from "../types.js";
import { button, escapeHtml, formatDate, icon, statusPill } from "../view-utils.js";

const scopeLabels: Record<ApiScope, string> = {
  "factory:read": "Read bot builder sessions",
  "factory:write": "Create and publish bots",
  "bots:read": "Read bot configuration",
  "bots:write": "Change bots, connections, and permissions",
  "skills:publish": "Publish tenant-only prompt, HTTPS, and workflow skills",
  "agent:run": "Run bot conversations and scheduled work",
  "tokens:manage": "Create and revoke API tokens",
  "members:manage": "Manage workspace members and roles",
};

export function dashboardView(state: UiState): string {
  const published = state.bots.filter((bot) => bot.status === "published").length;
  const drafts = state.bots.filter((bot) => bot.status === "draft").length;
  const disabled = state.bots.filter((bot) => bot.status === "disabled").length;
  const recent = state.bots.slice(0, 4);
  const featureCount = Object.values(state.capabilities?.features ?? {}).filter(Boolean).length;
  const miniAppUrl = `${location.origin}/miniapp/`;

  return `<section class="botfather-hero">
      <div class="botfather-hero-copy"><div class="welcome-tag"><span class="live-dot"></span> TELEGRAM BOT WORKSPACE</div><h2>Build your next<br /><em>great bot.</em></h2><p>Create, connect, and launch Telegram assistants from one calm control room. Your bots, tools, and Mini App setup stay together.</p><div class="welcome-actions"><button class="button button-primary" data-route="create">${icon("plus", 16)}<span>Create a bot</span></button><button class="button button-glass" data-route="bots"><span>Manage my bots</span>${icon("arrow", 16)}</button></div></div>
      <div class="botfather-preview" aria-label="Example Telegram bot conversation"><div class="botfather-preview-head"><span class="botfather-preview-avatar">${icon("botfather", 17)}</span><span><b>AI Hat assistant</b><small><i></i> bot workspace</small></span><span class="preview-menu">···</span></div><div class="botfather-preview-body"><div class="preview-date">TODAY</div><div class="preview-message preview-user">Can you help me build a Telegram bot?</div><div class="preview-message preview-bot">Absolutely. Set its purpose, connect the tools it needs, then publish when you’re ready.<small>Just now <span>✓✓</span></small></div></div><div class="botfather-preview-input"><span>Message your assistant…</span><b>${icon("arrow", 14)}</b></div></div>
    </section>
    <section class="stat-grid" aria-label="Bot totals">
      ${statCard("Total bots", state.bots.length, "Your assistant lineup", "bots", "blue")}
      ${statCard("Published", published, "Ready to answer", "globe", "mint")}
      ${statCard("Drafts", drafts, "Still taking shape", "spark", "violet")}
      ${statCard("Paused", disabled, "Disabled by you", "pause", "amber")}
    </section>
    <div class="content-grid dashboard-grid botfather-home-grid">
      <section class="panel panel-large"><div class="panel-heading"><div><div class="eyebrow">YOUR TELEGRAM BOTS</div><h2>Recently updated</h2></div><button class="text-button" data-route="bots">All bots ${icon("arrow", 15)}</button></div>
        ${recent.length ? `<div class="bot-list-compact">${recent.map((bot) => compactBot(bot)).join("")}</div>` : emptyState("bots", "Your first bot starts here", "Build a focused assistant and connect it to the tools you trust.", "Create a bot", "navigate-create")}
      </section>
      <section class="panel panel-side botfather-launch-panel"><div class="panel-heading"><div><div class="eyebrow">OPEN IN TELEGRAM</div><h2>Your Mini App link</h2></div><span class="panel-icon">${icon("globe", 18)}</span></div>
        <p class="botfather-launch-copy">After deploying to a public HTTPS host, add this URL in BotFather.</p><div class="botfather-url"><code>${escapeHtml(miniAppUrl)}</code><button class="icon-button" aria-label="Copy Mini App URL" data-action="copy-miniapp-url">${icon("copy", 16)}</button></div>
        <a class="botfather-open-link" href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">Open BotFather ${icon("arrow", 14)}</a>
        <div class="botfather-steps"><div><span>1</span><p>Choose your bot in <b>@BotFather</b></p></div><div><span>2</span><p>Open <b>Bot Settings → Mini App</b></p></div><div><span>3</span><p>Paste your URL and save</p></div></div>
        <div class="quick-list botfather-quick-list"><button class="quick-action" data-route="skills"><span class="quick-icon qi-blue">${icon("spark", 17)}</span><span><b>Add a skill</b><small>Give a bot a new ability</small></span>${icon("chevron", 16)}</button><button class="quick-action" data-route="mcp"><span class="quick-icon qi-mint">${icon("plug", 17)}</span><span><b>Connect a tool</b><small>Bring your MCP server</small></span>${icon("chevron", 16)}</button></div>
      </section>
    </div>
    <section class="runtime-strip"><div class="runtime-title"><span class="runtime-pulse"></span><div><b>${escapeHtml(state.capabilities?.runtime ?? "Runtime")} runtime</b><small>Live capability report</small></div></div><div class="runtime-features"><span>${featureCount} capabilities available</span><span class="runtime-divider"></span><span>${state.capabilities?.features.telegram ? "Telegram ready" : "Telegram needs a webhook URL"}</span><span class="runtime-divider"></span><span>${state.capabilities?.features.mcp ? "MCP supported" : "MCP unavailable"}</span></div><button class="text-button" data-route="security">Details ${icon("arrow", 15)}</button></section>`;
}

export function botsView(state: UiState): string {
  const bots = state.bots;
  return `<div class="toolbar-row"><div class="search-field">${icon("search", 16)}<input id="bot-filter" type="search" placeholder="Find a bot by name…" aria-label="Filter bots" /></div><div class="toolbar-meta"><span>${bots.length} ${bots.length === 1 ? "bot" : "bots"}</span><button class="button button-primary" data-route="create">${icon("plus", 16)}<span>New bot</span></button></div></div>
    ${bots.length ? `<section class="bot-card-grid" id="bot-card-grid">${bots.map((bot) => botCard(bot)).join("")}</section>` : `<section class="panel empty-panel">${emptyState("bots", "Nothing on the roster yet", "Your bots will show up here. Start with a name and a clear purpose.", "Create your first bot", "navigate-create")}</section>`}`;
}

export function skillMarketplaceView(state: UiState): string {
  const selectedBotId = state.botId ?? state.bots[0]?.id ?? "";
  const canPublish = state.principal?.scopes.includes("skills:publish") === true;
  const targetSelector = state.bots.length
    ? `<label class="inline-select"><span>Install to</span><select id="skill-target-bot">${state.bots.map((bot) => `<option value="${escapeHtml(bot.id)}" ${bot.id === selectedBotId ? "selected" : ""}>${escapeHtml(bot.name)}</option>`).join("")}</select></label>`
    : "";
  return `<section class="panel marketplace-banner"><div class="marketplace-symbol">${icon("spark", 23)}</div><div><div class="eyebrow">WORKSPACE CAPABILITIES</div><h2>Small skills. Bigger bots.</h2><p>Publish reusable tools for this workspace, then review each permission before installing.</p></div>${targetSelector}</section>
    ${state.catalog.length ? `<div class="skill-grid">${state.catalog.map((skill) => skillCard(skill, selectedBotId)).join("")}</div>` : `<section class="panel empty-panel">${emptyState("spark", "Your catalog is ready", "Publish a prompt, HTTPS, or workflow skill for this workspace. Published skill IDs are immutable; use a new ID for each revision.", "Go to my bots", "navigate-bots")}</section>`}
    ${canPublish ? `<section class="panel form-panel skill-publish-panel"><div class="panel-heading"><div><div class="eyebrow">WORKSPACE CATALOG</div><h2>Publish a skill</h2><p class="panel-subtitle">This skill is visible only to this tenant. HTTP calls still require a deployment origin allowlist.</p></div><span class="quiet-badge">skills:publish</span></div><form id="skill-publish-form" class="stack-form"><label class="field"><span>Skill definition · JSON</span><textarea name="definition" rows="18" spellcheck="false" required aria-label="Skill definition JSON" placeholder='{"id":"example.instructions.v1","name":"Workspace instructions","version":"1.0.0","author":"Your team","category":"productivity","description":"Adds focused instructions to a bot.","executionType":"prompt","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"outputSchema":{"type":"object","properties":{},"additionalProperties":false},"requiredPermissions":[],"configuration":{"instructions":"Add the instruction text here."}}'></textarea></label><div class="form-actions"><p class="field-hint">Supported execution types are <code>prompt</code>, <code>http</code>, and <code>workflow</code>. Use an unused ID for each published revision.</p><button class="button button-primary" type="submit">${icon("plus", 16)}<span>Validate & publish</span></button></div></form></section>` : `<section class="panel info-panel"><div class="eyebrow">PUBLISHING ACCESS</div><h2>Bring your own capabilities.</h2><p class="panel-subtitle">Publishing requires an API token with the <code>skills:publish</code> scope. Add that scope through API access if your token is allowed to grant it.</p></section>`}`;
}

export function mcpWorkspaceView(state: UiState): string {
  const selectedBotId = state.botId ?? state.bots[0]?.id ?? "";
  const selector = state.bots.length
    ? `<label class="inline-select"><span>Bot</span><select id="mcp-target-bot">${state.bots.map((bot) => `<option value="${escapeHtml(bot.id)}" ${bot.id === selectedBotId ? "selected" : ""}>${escapeHtml(bot.name)}</option>`).join("")}</select></label>`
    : "";
  const servers = state.botId ? state.servers : [];
  return `<section class="panel intro-panel"><div class="intro-icon intro-teal">${icon("plug", 21)}</div><div class="intro-copy"><div class="eyebrow">MODEL CONTEXT PROTOCOL</div><h2>Give your bot a safe set of tools.</h2><p>Servers start disconnected. Discovered tools stay disabled until you grant <code>mcp:invoke</code> individually.</p></div>${selector}</section>
    ${
      state.bots.length
        ? `<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">NEW CONNECTION</div><h2>Add an MCP server</h2></div><span class="quiet-badge">HTTPS only</span></div><form id="mcp-add-form" class="form-grid"><label class="field"><span>Connection name</span><input name="name" placeholder="Company knowledge" required maxlength="80" /></label><label class="field field-wide"><span>Streamable HTTP endpoint</span><input name="endpoint" type="url" placeholder="https://tools.example.com/mcp" required /></label><div class="form-actions field-wide"><p class="field-hint">The endpoint must be HTTPS and present in the runtime’s <code>MCP_ALLOWED_ORIGINS</code> list. Add a server only if you trust its owner.</p><button class="button button-primary" type="submit" data-action="add-mcp">${icon("plus", 16)}<span>Add connection</span></button></div></form></section>
    ${servers.length ? `<section class="server-list">${servers.map((server) => mcpServerCard(server, state.toolsByServer[server.id] ?? [])).join("")}</section>` : `<section class="panel empty-panel">${emptyState("plug", "No MCP connections for this bot", "Add a reviewed HTTPS server above, then discover and approve its tools.", "Browse my bots", "navigate-bots")}</section>`}`
        : `<section class="panel empty-panel">${emptyState("bots", "Choose a bot first", "MCP servers are attached to individual bots, so each tool grant stays scoped.", "Create a bot", "navigate-create")}</section>`
    }`;
}

export function automationWorkspaceView(state: UiState): string {
  const selectedBotId = state.botId ?? state.bots[0]?.id ?? "";
  const selector = state.bots.length
    ? `<label class="inline-select"><span>Bot</span><select id="automation-target-bot">${state.bots.map((bot) => `<option value="${escapeHtml(bot.id)}" ${bot.id === selectedBotId ? "selected" : ""}>${escapeHtml(bot.name)} · ${escapeHtml(bot.status)}</option>`).join("")}</select></label>`
    : "";
  const tasks = state.botId ? state.tasks : [];
  const bot = state.bots.find((item) => item.id === selectedBotId);
  return `<section class="panel intro-panel"><div class="intro-icon intro-blue">${icon("clock", 21)}</div><div class="intro-copy"><div class="eyebrow">PERSISTENT SCHEDULES</div><h2>Let the right bot show up on time.</h2><p>One-time reminders and daily runs use your timezone and deliver to an approved Telegram sender.</p></div>${selector}</section>
    ${
      state.bots.length
        ? `<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">CREATE A SCHEDULE</div><h2>Plan an automated run</h2></div>${bot?.status === "published" ? statusChip("Ready to schedule", "connected") : statusChip("Publish bot first", "paused")}</div><form id="schedule-form" class="form-grid"><label class="field"><span>Repeat</span><select name="repeat"><option value="once">One time</option><option value="daily">Every day</option></select></label><label class="field" data-schedule-once><span>Date and time</span><input name="runAt" type="datetime-local" /></label><label class="field" data-schedule-daily hidden><span>Time of day</span><input name="dailyAt" type="time" value="09:00" /></label><label class="field"><span>Timezone</span><input name="timezone" value="${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}" required /></label><label class="field"><span>Notify Telegram user ID</span><input name="notifyTelegramUserId" inputmode="numeric" placeholder="Your approved numeric ID" required /></label><label class="field field-wide"><span>What should the bot do?</span><textarea name="prompt" rows="3" placeholder="Summarize today's updates and send me the key points." required maxlength="10000"></textarea></label><div class="form-actions field-wide"><p class="field-hint">The bot must be published and Telegram connected. The recipient must already be on the bot's owner-approved sender list.</p><button class="button button-primary" type="submit">${icon("plus", 16)}<span>Create schedule</span></button></div></form></section>
    ${tasks.length ? `<section class="panel task-panel"><div class="panel-heading"><div><div class="eyebrow">SAVED JOBS</div><h2>Scheduled tasks</h2></div><span class="quiet-badge">${tasks.length} total</span></div><div class="table-wrap"><table><thead><tr><th>Task</th><th>Next run</th><th>Recipient</th><th>Status</th><th></th></tr></thead><tbody>${tasks.map((task) => taskRow(task)).join("")}</tbody></table></div></section>` : `<section class="panel empty-panel">${emptyState("clock", "No scheduled tasks yet", "Use a one-time reminder or repeat a useful report each day.", "View my bots", "navigate-bots")}</section>`}`
        : `<section class="panel empty-panel">${emptyState("bots", "Choose a bot first", "Schedules belong to one published bot and one approved Telegram recipient.", "Create a bot", "navigate-create")}</section>`
    }`;
}

export function usageView(summary?: UsageSummary): string {
  if (!summary) {
    return `<section class="panel empty-panel">${emptyState("chart", "Usage is not available", "This API token needs bots:read access to load owner-scoped usage totals.", "Review access", "navigate-api")}</section>`;
  }
  const dates: string[] = [];
  const start = new Date(summary.from);
  for (let index = 0; index < 30; index += 1) {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + index);
    const key = day.toISOString().slice(0, 10);
    if (key <= summary.through.slice(0, 10)) dates.push(key);
  }
  const perDay = new Map(summary.byDay.map((item) => [item.date, item]));
  const series = dates.map((date) => ({ date, requests: perDay.get(date)?.requests ?? 0 }));
  const peak = Math.max(1, ...series.map((item) => item.requests));
  const chart = series
    .map((item, index) => {
      const height = item.requests ? Math.max(4, Math.round((item.requests / peak) * 100)) : 0;
      const label = new Date(`${item.date}T00:00:00Z`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
      const tick = index % 5 === 0 || index === series.length - 1 ? label : "";
      return `<div class="usage-bar-column" title="${escapeHtml(`${label}: ${item.requests} requests`)}" aria-label="${escapeHtml(`${label}: ${item.requests} requests`)}"><div class="usage-bar-track"><span class="usage-bar" style="height:${height}%"></span></div><small>${escapeHtml(tick)}</small></div>`;
    })
    .join("");
  const botRows = summary.byBot.length
    ? summary.byBot
        .map(
          (bot) =>
            `<tr><td><b>${escapeHtml(bot.botName)}</b><small>${escapeHtml(bot.botId)}</small></td><td>${formatCount(bot.requests)}</td><td>${formatCount(bot.inputTokens)}</td><td>${formatCount(bot.outputTokens)}</td><td>${formatCount(bot.reportedRequests)} / ${formatCount(bot.requests)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="usage-empty-cell">No successful agent requests recorded in this period.</td></tr>`;
  return `<section class="panel intro-panel usage-intro"><div class="intro-icon intro-blue">${icon("chart", 21)}</div><div class="intro-copy"><div class="eyebrow">USAGE & ANALYTICS</div><h2>Your workspace activity</h2><p>Owner-scoped totals for the last 30 days. Token counts are included only when the model provider reports them.</p></div><span class="quiet-badge">${escapeHtml(formatDate(summary.from))} – ${escapeHtml(formatDate(summary.through))}</span></section>
    <section class="stat-grid usage-stat-grid" aria-label="Usage totals">${statCard("Successful requests", summary.total.requests, "Agent replies completed", "chat", "blue")}${statCard("Input tokens", summary.total.inputTokens, `${summary.total.reportedRequests} calls reported usage`, "arrow", "violet")}${statCard("Output tokens", summary.total.outputTokens, "Reported by model providers", "spark", "mint")}${statCard("Total tokens", summary.total.inputTokens + summary.total.outputTokens, "Reported input + output", "chart", "amber")}</section>
    <section class="panel usage-chart-panel"><div class="panel-heading"><div><div class="eyebrow">DAILY REQUESTS</div><h2>Activity over time</h2><p class="panel-subtitle">Successful agent replies by UTC date</p></div><span class="quiet-badge">30 days</span></div><div class="usage-chart" role="img" aria-label="Daily successful agent requests over the last 30 days">${chart}</div><div class="usage-chart-legend"><span><i></i> Successful replies</span><span>UTC dates</span></div></section>
    <section class="panel usage-table-panel"><div class="panel-heading"><div><div class="eyebrow">BOT BREAKDOWN</div><h2>Usage by bot</h2></div><span class="quiet-badge">${summary.byBot.length}</span></div><div class="table-wrap"><table><thead><tr><th>Bot</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th><th>Reported</th></tr></thead><tbody>${botRows}</tbody></table></div><p class="field-hint">Usage records include model and bot identifiers in storage. This view omits actor identifiers, prompts, and generated replies. Pricing is not estimated because provider rates vary.</p></section>`;
}

export function apiAccessView(state: UiState): string {
  const scopes = state.principal?.scopes ?? [];
  const token = state.newToken;
  return `<div class="content-grid settings-grid"><section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">TOKEN FACTORY</div><h2>Create a scoped token</h2><p class="panel-subtitle">A new secret is shown once. Copy it now and keep it out of source control.</p></div><span class="panel-icon">${icon("key", 18)}</span></div>
      ${
        scopes.includes("tokens:manage")
          ? `<form id="new-token-form" class="stack-form"><fieldset class="scope-fieldset"><legend>Choose from the scopes you already have</legend>${(
              Object.keys(scopeLabels) as ApiScope[]
            )
              .filter((scope) => scopes.includes(scope))
              .map(
                (scope) =>
                  `<label class="check-row"><input type="checkbox" name="scopes" value="${scope}" ${["bots:read", "bots:write"].includes(scope) ? "checked" : ""} /><span><b>${scope}</b><small>${scopeLabels[scope]}</small></span></label>`,
              )
              .join(
                "",
              )}</fieldset><label class="field"><span>Expires in</span><select name="expiresDays"><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></label><button class="button button-primary" type="submit">${icon("plus", 16)}<span>Create token</span></button></form>`
          : `<div class="alert alert-info">This session does not have the <code>tokens:manage</code> scope. Use a token that does to create a narrower token.</div>`
      }
      ${token ? `<div class="token-reveal"><div class="token-reveal-head"><span class="status-pill status-connected"><span class="status-dot"></span>Created · copy now</span><button class="icon-button" data-action="dismiss-token" aria-label="Dismiss token">${icon("close", 16)}</button></div><code id="new-token-value">${escapeHtml(token.token)}</code><button class="button button-secondary" data-action="copy-new-token">${icon("copy", 15)}<span>Copy token</span></button><small>Expires ${escapeHtml(formatDate(token.expiresAt))}. This plaintext is not saved after leaving the page.</small></div>` : ""}
    </section><section class="panel info-panel"><div class="eyebrow">TOKEN HYGIENE</div><h2>Keep access intentional.</h2><ul class="security-list"><li>${icon("check", 16)}<span>Tokens can only grant scopes this token already holds.</span></li><li>${icon("check", 16)}<span>Plaintext is returned once and stored in this page only until you leave.</span></li><li>${icon("check", 16)}<span>Use HTTPS for any browser or Telegram Mini App session.</span></li><li>${icon("check", 16)}<span>Never paste a bot token or provider API key into an API-token field.</span></li></ul><div class="mini-note">To revoke a token, use <code>DELETE /v1/tokens/{tokenId}</code> with a token that has <code>tokens:manage</code>.</div></section></div>`;
}

export function securityView(state: UiState): string {
  const principal = state.principal;
  const featureRows = Object.entries(state.capabilities?.features ?? {});
  const miniAppUrl = `${location.origin}/miniapp/`;
  const memberScope = principal?.scopes.includes("members:manage") ?? false;
  const currentMember = state.tenantMembers.find((member) => member.userId === principal?.userId);
  const canManageMembers = currentMember?.role === "owner" && currentMember.status === "active";
  const memberRows = state.tenantMembers.length
    ? state.tenantMembers
        .map((member) => {
          const isSelf = member.userId === principal?.userId;
          const roleControl =
            canManageMembers && member.status === "active"
              ? `<form class="member-role-form" data-form="tenant-member-role-form" data-user-id="${escapeHtml(member.userId)}"><label class="visually-hidden" for="member-role-${escapeHtml(member.userId)}">Role for ${escapeHtml(member.userId)}</label><select id="member-role-${escapeHtml(member.userId)}" name="role">${(["owner", "admin", "member"] as const).map((role) => `<option value="${role}" ${member.role === role ? "selected" : ""}>${role}</option>`).join("")}</select><button class="button button-secondary button-small" type="submit">Save</button></form><button class="button button-danger-outline button-small" data-action="deactivate-tenant-member" data-user-id="${escapeHtml(member.userId)}" ${isSelf && member.role === "owner" && state.tenantMembers.filter((item) => item.status === "active" && item.role === "owner").length < 2 ? 'disabled title="Add another owner first"' : ""}>Remove</button>`
              : member.status === "inactive" && canManageMembers
                ? `<button class="button button-secondary button-small" data-action="reactivate-tenant-member" data-user-id="${escapeHtml(member.userId)}" data-role="${escapeHtml(member.role)}">Reactivate</button>`
                : "";
          return `<li class="member-row"><div class="member-identity"><b>${escapeHtml(member.userId)}${isSelf ? " · you" : ""}</b><small>${member.ownedBotCount} owned ${member.ownedBotCount === 1 ? "bot" : "bots"} · added ${escapeHtml(formatDate(member.createdAt))}</small></div><span class="member-role member-role-${member.role}">${escapeHtml(member.role)}</span><span class="member-status ${member.status === "active" ? "active" : "inactive"}">${escapeHtml(member.status)}</span><div class="member-actions">${roleControl}</div></li>`;
        })
        .join("")
    : `<li class="audit-empty">No workspace members were returned.</li>`;
  const memberManagement = !memberScope
    ? `<div class="alert alert-info">This token needs the <code>members:manage</code> scope to view workspace membership.</div>`
    : state.tenantMembersError
      ? `<div class="alert alert-info">${escapeHtml(state.tenantMembersError)}</div>`
      : `<div class="member-list-wrap"><ul class="member-list">${memberRows}</ul></div>${
          canManageMembers
            ? `<form id="tenant-member-add-form" class="member-add-form"><div class="field"><label for="member-user-id">Existing account user ID</label><input id="member-user-id" name="userId" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,127}" autocomplete="off" placeholder="usr_…" /></div><label class="field"><span>Role</span><select name="role"><option value="member">member</option><option value="admin">admin</option></select></label><button class="button button-primary" type="submit">${icon("plus", 15)}<span>Add member</span></button></form><p class="field-hint">This adds an existing account by its user ID. Removing a member revokes their active API tokens; reactivation requires creating a new token. Private bots still need an explicit bot access grant.</p>`
            : `<p class="field-hint">Only an active workspace owner can add members or change roles. Membership does not automatically grant access to other members’ private bots.</p>`
        }`;
  const invitationRows = state.tenantInvitations.length
    ? state.tenantInvitations
        .map((invitation) => {
          const revoke =
            canManageMembers && invitation.status === "pending"
              ? `<button class="button button-danger-outline button-small" data-action="revoke-workspace-invitation" data-invitation-id="${escapeHtml(invitation.id)}">Revoke</button>`
              : "";
          return `<li class="member-row"><div class="member-identity"><b>${escapeHtml(invitation.role)} invitation</b><small>Expires ${escapeHtml(formatDate(invitation.expiresAt))} · created ${escapeHtml(formatDate(invitation.createdAt))}</small></div><span class="member-role member-role-${invitation.role}">${escapeHtml(invitation.role)}</span><span class="member-status ${invitation.status === "pending" ? "active" : "inactive"}">${escapeHtml(invitation.status)}</span><div class="member-actions">${revoke}</div></li>`;
        })
        .join("")
    : `<li class="audit-empty">No invitations have been created.</li>`;
  const invitationManagement = !memberScope
    ? ""
    : `<section class="invitation-management"><div class="panel-heading"><div><div class="eyebrow">INVITATION LINKS</div><h3>Invite someone to this workspace</h3><p class="panel-subtitle">Links grant account access after the recipient signs in. They expire and can be revoked.</p></div></div>${
        state.tenantInvitationsError
          ? `<div class="alert alert-info">${escapeHtml(state.tenantInvitationsError)}</div>`
          : `<div class="member-list-wrap"><ul class="member-list">${invitationRows}</ul></div>`
      }${
        canManageMembers
          ? `<form id="tenant-invitation-form" class="member-add-form"><label class="field"><span>Workspace role</span><select name="role"><option value="member">member</option><option value="admin">admin</option></select></label><label class="field"><span>Link expires in</span><select name="expiresInDays"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label><button class="button button-primary" type="submit">${icon("plus", 15)}<span>Create invitation link</span></button></form>${
              state.newWorkspaceInvitation
                ? `<div class="one-time-invitation"><div><b>Copy this private invite now</b><code>${escapeHtml(state.newWorkspaceInvitation.url)}</code><code>${escapeHtml(state.newWorkspaceInvitation.token)}</code><small>Expires ${escapeHtml(formatDate(state.newWorkspaceInvitation.expiresAt))}. The link and token are shown once and kept only in this page session.</small></div><div class="member-actions"><button class="button button-secondary button-small" data-action="copy-workspace-invitation">${icon("copy", 14)}<span>Copy link</span></button><button class="button button-secondary button-small" data-action="copy-workspace-invitation-token">Copy token</button></div></div>`
                : ""
            }<p class="field-hint">Recipients must open the link while signed in to an AI Hat account. Invitation links are single-use and do not grant access to private bots.</p>`
          : `<p class="field-hint">Only workspace owners can create or revoke invitation links.</p>`
      }</section>`;
  const workspaceRows = state.workspaces.length
    ? `<ul class="workspace-list">${state.workspaces
        .map((workspace) => {
          const active = workspace.tenantId === principal?.tenantId;
          return `<li class="workspace-row"><div class="member-identity"><b>${escapeHtml(workspace.name)}${active ? " · current" : ""}</b><small>Added ${escapeHtml(formatDate(workspace.createdAt))} · workspace role</small></div><span class="member-role member-role-${workspace.role}">${escapeHtml(workspace.role)}</span>${active ? `<span class="workspace-current">Active</span>` : `<button class="button button-secondary button-small" data-action="switch-workspace" data-tenant-id="${escapeHtml(workspace.tenantId)}">Switch</button>`}</li>`;
        })
        .join("")}</ul>`
    : `<div class="audit-empty">No active workspaces were returned.</div>`;
  const workspaceManagement = state.workspacesError
    ? `<div class="alert alert-info">${escapeHtml(state.workspacesError)}</div>`
    : workspaceRows;
  const auditRows = state.auditLogs.length
    ? state.auditLogs
        .map((event) => {
          const actionLabel =
            event.action === "authorization.permission_decision"
              ? "Tool permission checked"
              : event.action === "bot.access.decision"
                ? "Bot access checked"
                : event.action === "api.mutation_attempt"
                  ? "API write attempted"
                  : event.action === "authorization.scope_denied"
                    ? "API access denied"
                    : event.action.replaceAll("_", " ");
          const outcome = typeof event.metadata.outcome === "string" ? ` · ${event.metadata.outcome}` : "";
          const permission =
            typeof event.metadata.permission === "string"
              ? event.metadata.permission
              : typeof event.metadata.requiredScope === "string"
                ? event.metadata.requiredScope
                : undefined;
          const detail = permission ? `${permission}${outcome}` : `${event.resourceId}${outcome}`;
          return `<li><span class="audit-event-icon">${icon("shield", 15)}</span><div class="audit-event-copy"><b>${escapeHtml(actionLabel)}</b><code>${escapeHtml(detail)}</code></div><time>${escapeHtml(formatDate(event.createdAt))}</time></li>`;
        })
        .join("")
    : `<li class="audit-empty">No security events have been recorded yet.</li>`;
  return `<div class="content-grid settings-grid"><section class="panel info-panel"><div class="eyebrow">SESSION IDENTITY</div><h2>Workspace access is scoped.</h2><dl class="detail-list"><div><dt>Tenant</dt><dd><code>${escapeHtml(principal?.tenantId)}</code></dd></div><div><dt>User</dt><dd><code>${escapeHtml(principal?.userId)}</code></dd></div><div><dt>Session token</dt><dd><code>${escapeHtml(principal?.tokenId)}</code></dd></div><div><dt>Token scopes</dt><dd>${(principal?.scopes ?? []).map((scope) => `<span class="scope-tag">${escapeHtml(scope)}</span>`).join(" ")}</dd></div></dl><button class="button button-danger-outline" data-action="sign-out">${icon("logout", 16)}<span>End this browser session</span></button></section>
    <section class="panel info-panel"><div class="eyebrow">TELEGRAM MINI APP</div><h2>Your app address</h2><p class="panel-subtitle">Use this URL in BotFather after the app is deployed on an HTTPS hostname.</p><div class="copy-url"><code>${escapeHtml(miniAppUrl)}</code><button class="icon-button" data-action="copy-miniapp-url" aria-label="Copy URL">${icon("copy", 16)}</button></div><div class="alert alert-info compact-alert">${state.capabilities?.features.telegramMiniAppAuth ? "Open this from the configured AI Hat master bot for verified Telegram sign-in. Other Telegram launches and browsers can use an owner API token." : "Telegram identity sign-in needs TELEGRAM_MASTER_BOT_TOKEN. Until configured, use an owner API token."}</div><ol class="steps-list"><li>Open <b>@BotFather → /mybots</b> and choose the configured master bot.</li><li>Set <b>Main Mini App</b> or use <b>/setmenubutton</b> for the chat menu button.</li><li>Paste the public HTTPS URL above and save.</li></ol></section>
    <section class="panel member-panel field-wide"><div class="panel-heading"><div><div class="eyebrow">YOUR WORKSPACES</div><h2>Switch workspace</h2><p class="panel-subtitle">Your access is checked again in each workspace, and permissions follow your role there.</p></div><span class="quiet-badge">${state.workspaces.length} active</span></div>${workspaceManagement}</section>
    <section class="panel member-panel field-wide"><div class="panel-heading"><div><div class="eyebrow">JOIN A TEAM</div><h2>Accept a workspace invitation</h2><p class="panel-subtitle">Open an invite link while signed in, or paste the one-time invitation token here.</p></div></div><form id="workspace-invitation-accept-form" class="member-add-form"><label class="field"><span>Invitation token</span><input name="token" required maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ahf_invite_…" /></label><button class="button button-primary" type="submit">Join workspace</button></form></section>
    <section class="panel member-panel field-wide"><div class="panel-heading"><div><div class="eyebrow">WORKSPACE ACCESS</div><h2>Members and roles</h2><p class="panel-subtitle">Owners can add existing accounts, invite people, assign roles, and revoke workspace access.</p></div><span class="quiet-badge">${state.tenantMembers.length} members</span></div>${memberManagement}${invitationManagement}</section>
    <section class="panel audit-panel field-wide"><div class="panel-heading"><div><div class="eyebrow">SECURITY HISTORY</div><h2>Recent security events</h2><p class="panel-subtitle">API writes and bot, skill, and MCP access decisions. Message contents and Telegram user IDs are not stored.</p></div><span class="quiet-badge">${state.auditLogs.length} recent</span></div><ul class="audit-activity-list">${auditRows}</ul></section>
    <section class="panel capability-panel field-wide"><div class="panel-heading"><div><div class="eyebrow">RUNTIME CAPABILITIES</div><h2>${escapeHtml(state.capabilities?.runtime ?? "Unknown")} environment</h2></div><span class="quiet-badge">${featureRows.filter(([, enabled]) => enabled).length} enabled</span></div><div class="capability-grid">${featureRows.map(([feature, enabled]) => `<div class="capability-item"><span class="capability-check ${enabled ? "on" : "off"}">${icon(enabled ? "check" : "close", 13)}</span><span>${escapeHtml(feature.replaceAll(/([A-Z])/g, " $1").replaceAll("_", " "))}</span></div>`).join("")}</div><p class="field-hint">Capabilities describe the runtime adapter. They do not indicate that external credentials, allowlists, or Cloudflare resources have been provisioned.</p></section></div>`;
}

export function skillCard(skill: Skill, botId: string): string {
  const permissions = skill.requiredPermissions ?? [];
  return `<article class="skill-card"><div class="card-topline"><span class="skill-symbol">${icon(skill.executionType === "http" ? "globe" : "spark", 19)}</span><span class="type-chip">${escapeHtml(skill.executionType)}</span></div><div><h3>${escapeHtml(skill.name)}</h3><p>${escapeHtml(skill.description)}</p></div><div class="skill-meta"><span>${escapeHtml(skill.category)}</span><span>v${escapeHtml(skill.version)}</span><span>by ${escapeHtml(skill.author)}</span></div>
    ${permissions.length ? `<form data-form="install-skill" data-skill-id="${escapeHtml(skill.id)}" class="skill-grants"><div class="grant-heading"><span>Required permissions</span><span>Review each one</span></div>${permissions.map((permission) => `<label class="permission-check"><input type="checkbox" name="grants" value="${escapeHtml(permission)}" /><code>${escapeHtml(permission)}</code></label>`).join("")}<button class="button button-secondary button-small" type="submit" ${botId ? "" : "disabled"}>Install on selected bot</button></form>` : `<button class="button button-secondary button-small" data-action="install-skill-no-permission" data-skill-id="${escapeHtml(skill.id)}" ${botId ? "" : "disabled"}>Install on selected bot</button>`}
    </article>`;
}

export function mcpServerCard(server: McpServer, tools: import("../types.js").McpTool[]): string {
  return `<article class="server-card"><div class="server-main"><div class="server-symbol">${icon("plug", 19)}</div><div class="server-info"><div class="server-title"><h3>${escapeHtml(server.name)}</h3>${statusPill(server.status)}</div><code class="server-endpoint">${escapeHtml(server.endpoint)}</code><small>${server.hasCredential ? "Bearer credential stored" : "No credential configured"} · added ${escapeHtml(formatDate(server.createdAt))}</small></div><div class="server-actions">${server.status === "connected" ? button("Discover again", `mcp-connect:${server.id}`, "secondary", "spark") : button("Connect & discover", `mcp-connect:${server.id}`, "primary", "plug")}${button("Remove", `mcp-delete:${server.id}`, "danger-outline", "trash")}</div></div>
    ${tools.length ? `<div class="mcp-tools"><div class="eyebrow">DISCOVERED TOOLS · ${tools.length}</div>${tools.map((tool) => `<div class="mcp-tool-row"><div><b>${escapeHtml(tool.name)}</b><small>${escapeHtml(tool.description || "No description supplied by this MCP server.")}</small></div><span class="scope-tag">${tool.enabled ? "Enabled" : "Disabled"}</span><button class="button button-${tool.enabled ? "secondary" : "primary"} button-small" data-action="toggle-mcp-tool" data-server-id="${escapeHtml(server.id)}" data-tool-name="${escapeHtml(tool.name)}" data-enabled="${tool.enabled ? "false" : "true"}">${tool.enabled ? "Disable" : "Review & enable"}</button></div>`).join("")}</div>` : server.status === "connected" ? `<div class="tools-empty">Tools are not loaded yet. Select “Discover again” to refresh the server catalog.</div>` : ""}</article>`;
}

function statCard(label: string, value: number, description: string, glyph: string, color: string): string {
  return `<article class="stat-card"><div class="stat-label"><span>${escapeHtml(label)}</span><span class="stat-icon stat-${color}">${icon(glyph, 17)}</span></div><strong>${value}</strong><small>${escapeHtml(description)}</small><div class="stat-rule stat-rule-${color}"></div></article>`;
}

function compactBot(bot: Bot): string {
  return `<button class="compact-bot" data-route="bot/${escapeHtml(bot.id)}/overview"><span class="bot-avatar avatar-${colorIndex(bot.name)}">${escapeHtml(monogram(bot.name))}</span><span class="compact-bot-copy"><b>${escapeHtml(bot.name)}</b><small>${escapeHtml(bot.model.model)} · updated ${escapeHtml(formatDate(bot.updatedAt))}</small></span>${statusPill(bot.status)}${icon("chevron", 16)}</button>`;
}

function botCard(bot: Bot): string {
  return `<article class="bot-card" data-bot-card="${escapeHtml(`${bot.name} ${bot.description}`.toLowerCase())}"><div class="bot-card-top"><span class="bot-avatar bot-avatar-large avatar-${colorIndex(bot.name)}">${escapeHtml(monogram(bot.name))}</span>${statusPill(bot.status)}<button class="icon-button card-menu" aria-label="Open ${escapeHtml(bot.name)}" data-route="bot/${escapeHtml(bot.id)}/overview">${icon("dots", 18)}</button></div><button class="bot-card-title" data-route="bot/${escapeHtml(bot.id)}/overview">${escapeHtml(bot.name)}</button><p>${escapeHtml(bot.description || "No description yet.")}</p><div class="bot-card-model"><span class="model-chip">${icon("spark", 13)}${escapeHtml(bot.model.providerId)}</span><span>${escapeHtml(bot.model.model)}</span></div><div class="bot-card-footer"><span>v${bot.version} · ${escapeHtml(bot.visibility)}</span><button class="text-button" data-route="bot/${escapeHtml(bot.id)}/overview">Manage ${icon("arrow", 14)}</button></div></article>`;
}

function taskRow(task: ScheduledTask): string {
  const run = task.schedule.startsWith("daily:")
    ? `Daily · ${task.schedule.slice(6)} (${task.timezone})`
    : formatDate(task.nextRunAt);
  const control =
    task.status === "active" || task.status === "paused"
      ? `<button class="button button-secondary button-small" data-action="toggle-task" data-task-id="${escapeHtml(task.id)}" data-status="${task.status}">${task.status === "active" ? "Pause" : "Resume"}</button>`
      : "—";
  return `<tr><td><b>${escapeHtml(task.prompt.slice(0, 64))}${task.prompt.length > 64 ? "…" : ""}</b><small>${escapeHtml(run)}</small></td><td>${escapeHtml(formatDate(task.nextRunAt))}</td><td><code>${task.notifyTelegramUserId}</code></td><td>${statusPill(task.status)}</td><td>${control}</td></tr>`;
}

function emptyState(glyph: string, title: string, description: string, actionLabel: string, action: string): string {
  return `<div class="empty-state"><span class="empty-icon">${icon(glyph, 24)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p><button class="button button-primary button-small" data-action="${escapeHtml(action)}">${icon("plus", 15)}<span>${escapeHtml(actionLabel)}</span></button></div>`;
}

function statusChip(label: string, status: string): string {
  return `<span class="status-pill status-${escapeHtml(status)}"><span class="status-dot"></span>${escapeHtml(label)}</span>`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length > 1
    ? `${words[0]?.[0] ?? "B"}${words[1]?.[0] ?? ""}`.toUpperCase()
    : (words[0]?.slice(0, 2) ?? "AI").toUpperCase();
}

function colorIndex(name: string): number {
  return [...name].reduce((total, character) => total + character.charCodeAt(0), 0) % 5;
}
