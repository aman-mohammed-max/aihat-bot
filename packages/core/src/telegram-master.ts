import { AppError } from "./errors.js";
import { type BotFactory, CREATION_STEPS } from "./bot-factory.js";
import { DEFAULT_TELEGRAM_MASTER_REQUESTS_PER_MINUTE } from "./config.js";
import { telegramAccountIds } from "./telegram-auth.js";
import type {
  BotManagementRepository,
  Logger,
  MasterBotReply,
  MasterBotRepository,
  TelegramAuthRepository,
} from "./ports.js";
import type { CreationSession, CreationStep, TenantId, UserId } from "./types.js";
import { telegramApi } from "./telegram.js";
import type { TelegramRetryPolicy } from "./telegram.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface TelegramMasterMessage {
  readonly chatId: number;
  readonly chatType?: string;
  readonly text?: string;
  readonly from?: { readonly id: number; readonly isBot?: boolean; readonly firstName?: string };
}

/** Telegram conversational entry point for creating and managing bots in the Mini App. */
export class TelegramMasterBot {
  readonly #token: string;
  readonly #webhookSecret: string;
  readonly #appBaseUrl: URL;
  readonly #accounts: TelegramAuthRepository;
  readonly #sessions: MasterBotRepository;
  readonly #factory: BotFactory;
  readonly #bots: BotManagementRepository;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #retryPolicy: TelegramRetryPolicy | undefined;
  readonly #logger: Pick<Logger, "warn"> | undefined;
  readonly #requestsPerMinute: number;

  constructor(input: {
    readonly token: string;
    readonly webhookSecret: string;
    readonly webhookBaseUrl: string;
    readonly accounts: TelegramAuthRepository;
    readonly sessions: MasterBotRepository;
    readonly factory: BotFactory;
    readonly bots: BotManagementRepository;
    readonly fetch?: FetchLike;
    readonly now?: () => Date;
    readonly retryPolicy?: TelegramRetryPolicy;
    readonly requestsPerMinute?: number;
    readonly logger?: Pick<Logger, "warn">;
  }) {
    if (!input.token || input.token.length > 512 || /\s/.test(input.token)) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "Master bot token is invalid.", 503);
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(input.webhookSecret)) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "Master bot webhook secret is invalid.", 503);
    }
    let webhookBase: URL;
    try {
      webhookBase = new URL(input.webhookBaseUrl);
    } catch (cause) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "Master bot HTTPS webhook URL is not configured.", 503, { cause });
    }
    if (
      webhookBase.protocol !== "https:" ||
      webhookBase.username ||
      webhookBase.password ||
      webhookBase.search ||
      webhookBase.hash
    ) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "Master bot requires a public HTTPS webhook URL.", 503);
    }
    this.#token = input.token;
    this.#webhookSecret = input.webhookSecret;
    this.#appBaseUrl = webhookBase;
    this.#accounts = input.accounts;
    this.#sessions = input.sessions;
    this.#factory = input.factory;
    this.#bots = input.bots;
    this.#fetch = input.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = input.now ?? (() => new Date());
    this.#retryPolicy = input.retryPolicy;
    this.#requestsPerMinute = input.requestsPerMinute ?? DEFAULT_TELEGRAM_MASTER_REQUESTS_PER_MINUTE;
    if (
      !Number.isSafeInteger(this.#requestsPerMinute) ||
      this.#requestsPerMinute < 1 ||
      this.#requestsPerMinute > 1000
    ) {
      throw new AppError("VALIDATION_ERROR", "Master bot request limit must be between 1 and 1000 per minute.", 400);
    }
    this.#logger = input.logger;
  }

  async handleWebhook(request: Request): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!constantTimeEqual(suppliedSecret, this.#webhookSecret)) return new Response(null, { status: 401 });

    let update: { readonly updateId: number; readonly message?: TelegramMasterMessage };
    try {
      update = await readUpdate(request);
    } catch (cause) {
      if (cause instanceof AppError) return Response.json({ error: cause.code }, { status: cause.status });
      return Response.json({ error: "VALIDATION_ERROR" }, { status: 400 });
    }

    const now = this.#now();
    const leaseUntil = new Date(now.getTime() + 120_000).toISOString();
    let reserved = false;
    try {
      const reservation = await this.#sessions.reserveUpdate({
        updateId: update.updateId,
        leaseUntil,
        now: now.toISOString(),
      });
      if (reservation.state === "completed") return new Response(null, { status: 200 });
      if (reservation.state === "busy") return new Response(null, { status: 503 });
      reserved = true;

      const rateAllowed =
        reservation.state === "ready" || (await this.#allowUserMessage(update.message, now.toISOString()));
      const reply =
        reservation.state === "ready"
          ? reservation.reply
          : rateAllowed
            ? await this.#respond(update.message)
            : undefined;
      if (reply?.text) {
        if (reservation.state !== "ready") {
          await this.#sessions.saveUpdateReply({
            updateId: update.updateId,
            reply,
            leaseUntil,
            now: this.#now().toISOString(),
          });
        }
        await telegramApi<boolean>(this.#token, "sendMessage", reply, this.#fetch, {
          ...(this.#retryPolicy ? { retryPolicy: this.#retryPolicy } : {}),
          ...(this.#logger ? { logger: this.#logger } : {}),
        });
      } else if (reservation.state !== "ready") {
        await this.#sessions.saveUpdateReply({
          updateId: update.updateId,
          reply: { chat_id: 1, text: "" },
          leaseUntil,
          now: this.#now().toISOString(),
        });
      }
      await this.#sessions.completeUpdate({ updateId: update.updateId, now: this.#now().toISOString() });
      reserved = false;
      return new Response(null, { status: 200 });
    } catch {
      if (reserved) {
        await this.#sessions
          .releaseUpdate({ updateId: update.updateId, now: this.#now().toISOString() })
          .catch(() => undefined);
      }
      return new Response(null, { status: 503 });
    }
  }

  async #respond(message: TelegramMasterMessage | undefined): Promise<MasterBotReply | undefined> {
    if (!message?.from || message.from.isBot || !Number.isSafeInteger(message.from.id) || message.from.id < 1) {
      return undefined;
    }
    if (message.chatType !== "private" || message.chatId !== message.from.id) return undefined;
    const text = message.text?.trim() ?? "";
    if (!text) return undefined;
    const command = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
    const name = command?.[1]?.toLowerCase();
    if (name === "start" || name === "help") {
      return { chat_id: message.chatId, text: helpText(), ...this.#miniAppButton() };
    }

    const session = await this.#sessions.getSession(message.from.id);
    if (name === "cancel") {
      if (session) {
        const active = await this.#loadFactorySession(session);
        if (active?.status === "in_progress") {
          await this.#factory.pause(session.tenantId, session.ownerId, session.sessionId);
        }
        await this.#sessions.deleteSession(message.from.id);
      }
      return { chat_id: message.chatId, text: "Setup cancelled. Send /create whenever you want to start a new bot." };
    }
    if (name === "mybots") return this.#listBots(message.chatId, message.from.id, message.from.firstName);
    if (name === "create") {
      const account = await this.#ensureAccount(message.from.id, message.from.firstName);
      const current = session ? await this.#loadFactorySession(session) : undefined;
      if (current && session) {
        if (current.status === "paused")
          await this.#factory.resume(session.tenantId, session.ownerId, session.sessionId);
        if (current.status === "ready") {
          const draft = await this.#factory.createDraft(session.tenantId, session.ownerId, session.sessionId);
          return {
            chat_id: message.chatId,
            text: "Your bot draft is ready. Open the Mini App to review the settings and publish it when you’re ready.",
            ...this.#miniAppButton(draft.id),
          };
        }
        if (current.status === "paused" || current.status === "in_progress") {
          return this.#sessionPrompt(
            message.chatId,
            await this.#factory.get(session.tenantId, session.ownerId, session.sessionId),
          );
        }
        return this.#sessionPrompt(message.chatId, current);
      }
      const created = await this.#factory.start(account.tenantId, account.ownerId);
      const ownerSession = {
        telegramUserId: message.from.id,
        chatId: message.chatId,
        tenantId: account.tenantId,
        ownerId: account.ownerId,
        sessionId: created.id,
        updatedAt: this.#now().toISOString(),
      };
      await this.#sessions.saveSession(ownerSession);
      return this.#sessionPrompt(message.chatId, created);
    }
    if (name === "continue") {
      if (!session)
        return { chat_id: message.chatId, text: "There is no saved setup to continue. Send /create to start." };
      const current = await this.#loadFactorySession(session);
      if (!current) {
        await this.#sessions.deleteSession(message.from.id);
        return { chat_id: message.chatId, text: "That setup is no longer available. Send /create to begin again." };
      }
      if (current.status === "paused") await this.#factory.resume(session.tenantId, session.ownerId, session.sessionId);
      return this.#sessionPrompt(
        message.chatId,
        await this.#factory.get(session.tenantId, session.ownerId, session.sessionId),
      );
    }
    if (name)
      return { chat_id: message.chatId, text: "I don’t recognize that command. Send /help to see what I can do." };
    if (!session)
      return { chat_id: message.chatId, text: "Send /create to build a bot, or /mybots to list your bots." };

    const current = await this.#loadFactorySession(session);
    if (!current) {
      await this.#sessions.deleteSession(message.from.id);
      return { chat_id: message.chatId, text: "That setup is no longer available. Send /create to begin again." };
    }
    if (current.status === "paused") {
      return {
        chat_id: message.chatId,
        text: "This setup is paused. Send /continue to resume it, or /create for a new bot.",
      };
    }
    if (current.status === "draft" || current.status === "published")
      return this.#sessionPrompt(message.chatId, current);
    if (current.status !== "in_progress" || !current.currentStep) {
      return {
        chat_id: message.chatId,
        text: "This setup is ready. Open it in the Mini App to review your bot.",
        ...this.#miniAppButton(current.id),
      };
    }
    if (current.currentStep === "credentialRef") {
      return {
        chat_id: message.chatId,
        text: "For your security, don’t send model keys in chat. Continue in the Mini App to add the key over HTTPS and store it encrypted.",
        ...this.#miniAppButton(current.id),
      };
    }
    if (current.currentStep === "visibility" && text.toLowerCase() !== "private") {
      return {
        chat_id: message.chatId,
        text: "Choose private, shared, public, or invitation access in the Mini App. Wider access needs an explicit confirmation there.",
        ...this.#miniAppButton(current.id),
      };
    }
    try {
      const value = parseAnswer(current.currentStep, text);
      const updated = await this.#factory.answer(
        session.tenantId,
        session.ownerId,
        session.sessionId,
        current.currentStep,
        value,
      );
      await this.#sessions.saveSession({ ...session, updatedAt: this.#now().toISOString() });
      if (updated.status === "ready") {
        const draft = await this.#factory.createDraft(session.tenantId, session.ownerId, session.sessionId);
        return {
          chat_id: message.chatId,
          text: "Your bot draft is ready. Open the Mini App to review the settings and publish it when you’re ready.",
          ...this.#miniAppButton(draft.id),
        };
      }
      return this.#sessionPrompt(message.chatId, updated);
    } catch (cause) {
      if (cause instanceof AppError && cause.code === "VALIDATION_ERROR") {
        return {
          chat_id: message.chatId,
          text: `That answer doesn’t fit this step.\n\n${stepPrompt(current.currentStep)}`,
        };
      }
      throw cause;
    }
  }

  async #allowUserMessage(message: TelegramMasterMessage | undefined, now: string): Promise<boolean> {
    if (
      !message?.from ||
      message.from.isBot ||
      !Number.isSafeInteger(message.from.id) ||
      message.from.id < 1 ||
      message.chatType !== "private" ||
      message.chatId !== message.from.id ||
      !message.text?.trim()
    ) {
      return true;
    }
    const { ownerId } = await telegramAccountIds(message.from.id);
    return this.#sessions.consumeUserRequest({
      actorId: ownerId,
      now,
      limitPerMinute: this.#requestsPerMinute,
    });
  }

  async #ensureAccount(telegramUserId: number, firstName?: string): Promise<{ ownerId: UserId; tenantId: TenantId }> {
    const ids = await telegramAccountIds(telegramUserId);
    const safeName = Array.from(firstName ?? "Telegram user", (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
      .join("")
      .trim()
      .slice(0, 80);
    return this.#accounts.getOrCreateOwner({
      telegramUserId,
      ownerId: ids.ownerId,
      tenantId: ids.tenantId,
      workspaceName: `${safeName || "Telegram user"}'s workspace`,
      now: this.#now().toISOString(),
    });
  }

  async #listBots(chatId: number, telegramUserId: number, firstName?: string): Promise<MasterBotReply> {
    const account = await this.#ensureAccount(telegramUserId, firstName);
    const bots = await this.#bots.listOwned(account.tenantId, account.ownerId);
    if (bots.length === 0)
      return { chat_id: chatId, text: "You haven’t created a bot yet. Send /create to get started." };
    const lines = bots.slice(0, 20).map((bot) => `• ${bot.name} — ${bot.status}`);
    return {
      chat_id: chatId,
      text: `Your bots:\n${lines.join("\n")}${bots.length > lines.length ? `\n…and ${bots.length - lines.length} more.` : ""}\n\nOpen the Mini App to manage settings, integrations, and Telegram connections.`,
      ...this.#miniAppButton(),
    };
  }

  async #loadFactorySession(session: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly sessionId: string;
  }): Promise<CreationSession | undefined> {
    try {
      return await this.#factory.get(session.tenantId, session.ownerId, session.sessionId);
    } catch (cause) {
      if (cause instanceof AppError && cause.code === "NOT_FOUND") return undefined;
      throw cause;
    }
  }

  #sessionPrompt(chatId: number, session: CreationSession): MasterBotReply {
    if (session.status === "draft" || session.status === "published") {
      return {
        chat_id: chatId,
        text:
          session.status === "draft"
            ? "Your bot draft is saved. Open the Mini App to review the configuration and publish it."
            : "Your bot is published. Open the Mini App to manage it.",
        ...this.#miniAppButton(session.id),
      };
    }
    if (session.status === "ready" || !session.currentStep) {
      return {
        chat_id: chatId,
        text: "Your setup is complete. Open the Mini App to review your bot.",
        ...this.#miniAppButton(session.id),
      };
    }
    if (session.currentStep === "credentialRef") {
      return {
        chat_id: chatId,
        text: "The model credential is sensitive, so add it in the Mini App. It is sent over HTTPS and stored encrypted.",
        ...this.#miniAppButton(session.id),
      };
    }
    return {
      chat_id: chatId,
      text: `Bot setup (${CREATION_STEPS.indexOf(session.currentStep) + 1}/${CREATION_STEPS.length})\n\n${stepPrompt(session.currentStep)}`,
    };
  }

  #miniAppButton(sessionId?: string): Pick<MasterBotReply, "reply_markup"> | Record<string, never> {
    const appUrl = new URL("/miniapp/", this.#appBaseUrl);
    if (sessionId) {
      appUrl.searchParams.set("factorySession", sessionId);
      appUrl.hash = "/create";
    }
    return {
      reply_markup: {
        inline_keyboard: [[{ text: "Open AI Hat Mini App", web_app: { url: appUrl.toString() } }]],
      },
    };
  }
}

export function createTelegramMasterWebhookHandler(
  masterBot: TelegramMasterBot | undefined,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    if (new URL(request.url).pathname !== "/webhooks/telegram/master") return undefined;
    if (!masterBot) return new Response(null, { status: 404 });
    return masterBot.handleWebhook(request);
  };
}

function stepPrompt(step: CreationStep): string {
  const prompts: Record<CreationStep, string> = {
    name: "What should your bot be called? (2–64 characters)",
    description: "Describe what the bot does. (1–2,000 characters)",
    purpose: "What main task should the bot help with?",
    audience: "Who is the bot for?",
    personality: "Describe its tone, style, and boundaries.",
    providerId: "Which model provider should it use? Enter an ID such as openai.",
    endpoint: "Enter the provider’s HTTPS API endpoint.",
    model: "Which model ID should it use?",
    credentialRef: "Add model credentials in the Mini App. Do not send secrets in chat.",
    imageModel: "Which image model should it use? Reply skip if image generation is not needed.",
    searchModel: "Which search model should it use? Reply skip if search is not needed.",
    skills: "Which skills should it have? Enter IDs separated by commas, or leave blank.",
    mcpConnections: "Which MCP connections should it use? Enter names separated by commas, or leave blank.",
    integrations: "Which integrations should it use? Enter names separated by commas, or leave blank.",
    memoryEnabled: "Enable persistent memory notes? Reply yes or no.",
    scheduledTasks: "Which scheduled tasks should it have? Enter one per line, or leave blank.",
    privacySettings: "List privacy settings or guardrails, separated by commas.",
    visibility: "Choose private, shared, public, or invitation. Confirm wider access in the Mini App.",
    interfaces: "Which interfaces? Enter telegram, web_chat, and/or api separated by commas.",
  };
  return prompts[step];
}

function parseAnswer(step: CreationStep, text: string): unknown {
  if (step === "credentialRef") throw new AppError("FORBIDDEN", "Credentials must be added in the Mini App.", 403);
  if ((step === "imageModel" || step === "searchModel") && ["skip", "none"].includes(text.trim().toLowerCase())) {
    return "";
  }
  if (step === "memoryEnabled") {
    const value = text.toLowerCase();
    if (["yes", "y", "true", "on"].includes(value)) return true;
    if (["no", "n", "false", "off"].includes(value)) return false;
    throw new AppError("VALIDATION_ERROR", "Choose yes or no.", 400);
  }
  if (["skills", "mcpConnections", "integrations", "scheduledTasks", "privacySettings", "interfaces"].includes(step)) {
    const list = text
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (step === "interfaces") return list.map((item) => item.toLowerCase().replaceAll(" ", "_"));
    return list;
  }
  return text;
}

function helpText(): string {
  return [
    "Welcome to AI Hat Bot Factory.",
    "",
    "/create — start a bot setup",
    "/continue — resume your saved setup",
    "/mybots — list your bots",
    "/cancel — pause and clear this chat’s setup shortcut",
    "",
    "The Mini App handles model credentials and sensitive publishing choices securely.",
  ].join("\n");
}

async function readUpdate(
  request: Request,
): Promise<{ readonly updateId: number; readonly message?: TelegramMasterMessage }> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 65_536) {
    throw new AppError("VALIDATION_ERROR", "Telegram update is too large.", 413);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 65_536) {
    throw new AppError("VALIDATION_ERROR", "Telegram update is too large.", 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Telegram update JSON is invalid.", 400, { cause });
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.update_id) || Number(value.update_id) < 0) {
    throw new AppError("VALIDATION_ERROR", "Telegram update is invalid.", 400);
  }
  if (value.message === undefined) return { updateId: Number(value.update_id) };
  if (!isRecord(value.message) || !isRecord(value.message.chat) || !Number.isSafeInteger(value.message.chat.id)) {
    throw new AppError("VALIDATION_ERROR", "Telegram message is invalid.", 400);
  }
  const from =
    isRecord(value.message.from) && Number.isSafeInteger(value.message.from.id)
      ? {
          id: Number(value.message.from.id),
          ...(typeof value.message.from.is_bot === "boolean" ? { isBot: value.message.from.is_bot } : {}),
          ...(typeof value.message.from.first_name === "string" ? { firstName: value.message.from.first_name } : {}),
        }
      : undefined;
  return {
    updateId: Number(value.update_id),
    message: {
      chatId: Number(value.message.chat.id),
      ...(typeof value.message.chat.type === "string" ? { chatType: value.message.chat.type } : {}),
      ...(typeof value.message.text === "string" ? { text: value.message.text } : {}),
      ...(from ? { from } : {}),
    },
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow } },
  );
}
