import type { UiState } from "../state.js";
import { button, escapeHtml, icon } from "../view-utils.js";

const navigation = [
  { id: "dashboard", label: "Overview", glyph: "home" },
  { id: "bots", label: "Bots", glyph: "bots", count: true },
  { id: "skills", label: "Skills", glyph: "spark" },
  { id: "mcp", label: "MCP servers", glyph: "plug" },
  { id: "automation", label: "Automation", glyph: "clock" },
  { id: "usage", label: "Usage & analytics", glyph: "chart" },
];

export function loginView(error = ""): string {
  return `<main class="auth-screen">
    <div class="auth-orbit auth-orbit-one"></div><div class="auth-orbit auth-orbit-two"></div>
    <section class="auth-card">
      <div class="brand-lockup"><span class="brand-mark">${icon("botfather", 22)}</span><span>AI Hat<span class="brand-dot">.</span></span></div>
      <div class="auth-kicker"><span class="live-dot"></span> BOT WORKSPACE</div>
      <h1>Your bots,<br /><span>all in one place.</span></h1>
      <p class="muted-copy">Sign in through your Telegram launch or connect an owner API token to manage bots, tools, and automations.</p>
      ${error ? `<div class="alert alert-error" role="alert">${escapeHtml(error)}</div>` : ""}
      <form id="login-form" class="stack-form">
        <label for="api-token">Owner API token</label>
        <div class="input-with-icon">${icon("key", 17)}<input id="api-token" name="token" type="password" autocomplete="off" placeholder="ahf_live_…" required minlength="50" /></div>
        <p class="field-hint">The token stays in this browser tab and clears when the tab closes. It is sent only to this app.</p>
        <button class="button button-primary button-full" type="submit"><span>Open workspace</span>${icon("arrow", 17)}</button>
      </form>
      <div class="auth-foot"><span class="secure-lock">${icon("shield", 15)}</span><span>Owner-scoped access · HTTPS recommended</span></div>
    </section>
    <div class="auth-caption">AI Hat Bot Factory <span>·</span> built for Telegram</div>
  </main>`;
}

export function shell(state: UiState, title: string, subtitle: string, content: string): string {
  const isBot = state.page === "bot";
  const active = isBot ? "bots" : state.page;
  const navigationMarkup = navigation
    .map((item) => {
      const selected = active === item.id;
      const count = item.count ? `<span class="nav-count">${state.bots.length}</span>` : "";
      return `<button class="nav-item ${selected ? "active" : ""}" data-route="${item.id}" ${selected ? 'aria-current="page"' : ""}>${icon(item.glyph)}<span>${item.label}</span>${count}</button>`;
    })
    .join("");
  const rootName = state.principal?.userId ? `Workspace ${state.principal.userId.slice(0, 7)}` : "Your workspace";
  const telegramContext = Boolean(window.Telegram?.WebApp?.initData);

  return `<div class="workspace-frame">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-top">
        <button class="brand-button" data-route="dashboard"><span class="brand-mark">${icon("botfather", 20)}</span><span>AI Hat<span class="brand-dot">.</span></span></button>
        <div class="workspace-switcher"><span class="workspace-avatar">A</span><span class="workspace-meta"><b>${escapeHtml(rootName)}</b><small>Personal workspace</small></span><span class="switch-chevron">${icon("chevron", 15)}</span></div>
        <button class="search-trigger" data-action="open-search">${icon("search", 16)}<span>Search workspace</span><kbd>⌘ K</kbd></button>
      </div>
      <div class="nav-label">BOT WORKSPACE</div>
      <nav class="primary-nav" aria-label="Workspace">${navigationMarkup}</nav>
      <div class="sidebar-bottom">
        <div class="sidebar-help"><span class="help-orb">${icon("spark", 18)}</span><div><b>Build your next bot</b><small>Start with a new assistant</small></div><button aria-label="Create bot" data-route="create">${icon("plus", 17)}</button></div>
        <button class="nav-item ${state.page === "api" ? "active" : ""}" data-route="api">${icon("key")}<span>API access</span></button>
        <button class="nav-item ${state.page === "security" ? "active" : ""}" data-route="security">${icon("shield")}<span>Security</span></button>
        <div class="account-row"><div class="account-avatar">${escapeHtml((state.principal?.userId ?? "A").slice(0, 1).toUpperCase())}</div><div class="account-meta"><b>Owner account</b><small>${escapeHtml(state.principal?.userId.slice(0, 14) ?? "Connected")}</small></div><button class="icon-button" title="Sign out" aria-label="Sign out" data-action="sign-out">${icon("logout", 17)}</button></div>
      </div>
    </aside>
    <main class="main-column">
      <header class="topbar">
        <button class="icon-button mobile-menu" aria-label="Open menu" data-action="toggle-menu">${icon("menu")}</button>
        <div class="breadcrumb"><span>Workspace</span><span class="crumb-separator">/</span><strong>${escapeHtml(title)}</strong></div>
        <div class="topbar-actions"><span class="runtime-chip"><span class="live-dot"></span>${escapeHtml(state.capabilities?.runtime ?? "runtime")}</span>${telegramContext ? '<span class="telegram-chip">Telegram Mini App</span>' : ""}<button class="icon-button top-search" aria-label="Search" data-action="open-search">${icon("search")}</button><button class="avatar-button" data-route="security" aria-label="Account settings">${escapeHtml((state.principal?.userId ?? "A").slice(0, 1).toUpperCase())}</button></div>
      </header>
      <div class="page-scroll"><div class="page-wrap">
        <div class="page-heading"><div><div class="eyebrow">AI HAT WORKSPACE</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${state.page === "bots" || state.page === "dashboard" ? button("New bot", "navigate-create", "primary", "plus") : ""}</div>
        ${state.notice ? `<div class="alert alert-success" role="status">${escapeHtml(state.notice)}</div>` : ""}
        ${state.pageError ? `<div class="alert alert-error" role="alert">${escapeHtml(state.pageError)}</div>` : ""}
        ${content}
      </div></div>
      <nav class="mobile-nav" aria-label="Mobile workspace">${navigation
        .filter((item) => ["dashboard", "bots", "skills", "mcp", "usage"].includes(item.id))
        .map(
          (item) =>
            `<button class="mobile-nav-item ${active === item.id ? "active" : ""}" data-route="${item.id}">${icon(item.glyph, 20)}<span>${item.label}</span></button>`,
        )
        .join("")}<button class="mobile-nav-item" data-route="api">${icon("key", 20)}<span>Access</span></button></nav>
    </main>
    <div class="toast-host" id="toast-host" aria-live="polite"></div>
    <div class="modal-layer" id="modal-layer" hidden></div>
    <div class="search-layer" id="search-layer" hidden></div>
  </div>`;
}

export function pageTitle(page: string, botName?: string): { title: string; subtitle: string } {
  const labels: Record<string, [string, string]> = {
    dashboard: ["Overview", "Create, configure, and launch your Telegram bots."],
    bots: ["Bots", "Manage your bots and the bots shared with you."],
    create: ["Create a bot", "A guided setup for a purpose-built Telegram assistant."],
    skills: ["Skills marketplace", "Install reviewed capabilities on the bots you own."],
    mcp: ["MCP connections", "Connect remote tools and grant each one deliberately."],
    automation: ["Automation", "Schedule persistent bot tasks and Telegram reminders."],
    usage: ["Usage & analytics", "Review successful agent requests and provider-reported token totals."],
    api: ["API access", "Create scoped API tokens for your private integrations."],
    security: ["Security settings", "Review this session and how your workspace credentials are handled."],
    bot: [botName ?? "Bot settings", "Manage behavior, Telegram access, tools, and scheduled work."],
  };
  const [title, subtitle] = labels[page] ?? ["Overview", "A clear view of your bot workspace."];
  return { title, subtitle };
}
