import type { ChatLine } from "../state.js";
import type { PublicChatBot } from "../types.js";
import { escapeHtml, icon } from "../view-utils.js";

export function publicChatLoginView(bot: PublicChatBot | undefined, error = "", telegramClientId = ""): string {
  const name = bot?.name ?? "this assistant";
  return `<main class="public-chat-auth"><a class="public-chat-brand" href="/miniapp/">${icon("botfather", 20)}<span>AI Hat<span class="brand-dot">.</span></span></a><section class="public-chat-auth-card"><div class="public-chat-avatar">${icon("spark", 22)}</div><div class="eyebrow">PUBLIC WEB CHAT</div><h1>Chat with ${escapeHtml(name)}</h1><p>${escapeHtml(bot?.description || "Sign in to start a conversation with this public bot.")}</p>${error ? `<div class="alert alert-error" role="alert">${escapeHtml(error)}</div>` : ""}${telegramClientId ? `<button class="button button-secondary button-full telegram-login-button" type="button" data-action="telegram-login"><span>Continue with Telegram</span>${icon("arrow", 17)}</button><div class="auth-divider"><span>or connect with an API token</span></div>` : `<div class="alert alert-info compact-alert">Telegram browser sign-in is not configured on this host. You can still sign in with an API token.</div>`}<form id="login-form" class="stack-form"><label for="public-chat-token">API token</label><div class="input-with-icon">${icon("key", 17)}<input id="public-chat-token" name="token" type="password" autocomplete="off" placeholder="ahf_live_…" required minlength="50" /></div><p class="field-hint">Your token stays in this browser tab and is sent only to this app.</p><button class="button button-primary button-full" type="submit"><span>Sign in and chat</span>${icon("arrow", 17)}</button></form><div class="public-chat-auth-foot">The bot owner may review conversations. Per-user usage limits apply.</div></section></main>`;
}

export function publicChatView(input: {
  bot: PublicChatBot;
  lines: readonly ChatLine[];
  busy: boolean;
  error?: string;
}): string {
  const transcript = input.lines.length
    ? input.lines.map((line) => renderLine(input.bot, line)).join("")
    : `<div class="public-chat-empty"><span>${icon("chat", 23)}</span><b>Start a conversation</b><small>Ask ${escapeHtml(input.bot.name)} anything.</small></div>`;
  return `<main class="public-chat-page"><header class="public-chat-header"><a class="public-chat-brand" href="/miniapp/">${icon("botfather", 20)}<span>AI Hat<span class="brand-dot">.</span></span></a><a class="public-chat-manage" href="/miniapp/">Manage your bots ${icon("arrow", 14)}</a></header><section class="public-chat-shell"><div class="public-chat-identity"><div class="public-chat-avatar">${icon("spark", 22)}</div><div><div class="eyebrow">PUBLIC AI ASSISTANT</div><h1>${escapeHtml(input.bot.name)}</h1><p>${escapeHtml(input.bot.description || "Ready when you are.")}</p></div></div><div class="public-chat-transcript" id="public-chat-transcript" aria-live="polite">${transcript}</div>${input.error ? `<div class="alert alert-error public-chat-error" role="alert">${escapeHtml(input.error)}</div>` : ""}<form id="public-chat-form" class="public-chat-composer"><label class="visually-hidden" for="public-chat-message">Message ${escapeHtml(input.bot.name)}</label><textarea id="public-chat-message" name="message" rows="1" maxlength="10000" placeholder="Message ${escapeHtml(input.bot.name)}…" required ${input.busy ? "disabled" : ""}></textarea><button class="send-button" type="submit" aria-label="Send message" ${input.busy ? "disabled" : ""}>${input.busy ? icon("loader", 17) : icon("send", 17)}</button></form><div class="public-chat-foot"><span>${icon("shield", 13)} The bot owner may review this chat</span><span>Limits apply per user</span></div></section><footer class="public-chat-footer">Powered by <a href="/miniapp/">AI Hat Bot Factory</a></footer></main>`;
}

export function publicChatErrorView(error: string): string {
  return `<main class="public-chat-page"><header class="public-chat-header"><a class="public-chat-brand" href="/miniapp/">${icon("botfather", 20)}<span>AI Hat<span class="brand-dot">.</span></span></a></header><section class="public-chat-shell public-chat-not-found"><div class="public-chat-avatar">${icon("search", 22)}</div><div class="eyebrow">WEB CHAT UNAVAILABLE</div><h1>This bot can’t be opened</h1><p>${escapeHtml(error || "The public chat link may be invalid, unpublished, or disabled by its owner.")}</p><a class="button button-secondary" href="/miniapp/">Open AI Hat</a></section></main>`;
}

function renderLine(bot: PublicChatBot, line: ChatLine): string {
  const assistant = line.role === "assistant";
  const attachments =
    line.attachments
      ?.map((attachment) => {
        const url = safeHttpsUrl(attachment.url) ?? safeInlineGeneratedImage(attachment.url);
        return url
          ? `<img class="public-chat-attachment" src="${escapeHtml(url)}" alt="${escapeHtml(attachment.alt ?? "Generated image")}" loading="lazy" referrerpolicy="no-referrer" />`
          : "";
      })
      .join("") ?? "";
  return `<article class="public-chat-line ${assistant ? "public-chat-assistant" : "public-chat-user"}"><div class="public-chat-line-avatar">${assistant ? icon("spark", 13) : "You"}</div><div class="public-chat-line-body"><b>${assistant ? escapeHtml(bot.name) : "You"}</b><p>${escapeHtml(line.content || (assistant ? "Thinking…" : ""))}</p>${attachments}</div></article>`;
}

function safeInlineGeneratedImage(value: string): string | undefined {
  if (value.length > 1_000_000 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return undefined;
  }
  return value;
}

function safeHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
