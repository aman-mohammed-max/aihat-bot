import { AppError } from "./errors.js";
import type {
  AgentEngine,
  BotRepository,
  SecretStore,
  SecretWriter,
  TelegramDeployment,
  TelegramRepository,
} from "./ports.js";
import type { BotId, TelegramDeploymentId, UserId } from "./types.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Telegram webhook registration and delivery using encrypted per-deployment credentials. */
export class TelegramManager {
  readonly #repository: TelegramRepository;
  readonly #bots: BotRepository;
  readonly #secrets: SecretStore & SecretWriter;
  readonly #engine: AgentEngine;
  readonly #webhookBaseUrl: string;
  readonly #fetch: FetchLike;

  constructor(input: {
    readonly repository: TelegramRepository;
    readonly bots: BotRepository;
    readonly secrets: SecretStore & SecretWriter;
    readonly engine: AgentEngine;
    readonly webhookBaseUrl: string;
    readonly fetch?: FetchLike;
  }) {
    this.#repository = input.repository;
    this.#bots = input.bots;
    this.#secrets = input.secrets;
    this.#engine = input.engine;
    this.#webhookBaseUrl = input.webhookBaseUrl;
    this.#fetch = input.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async connect(input: {
    readonly tenantId: TelegramDeployment["tenantId"];
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly token: string;
  }): Promise<TelegramDeployment> {
    const base = parseWebhookBaseUrl(this.#webhookBaseUrl);
    if (!input.token || input.token.length > 512 || /\s/.test(input.token)) {
      throw new AppError("VALIDATION_ERROR", "Telegram bot token is invalid.", 400);
    }
    const bot = await this.#bots.get(input.tenantId, input.botId);
    if (!bot || bot.ownerId !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    if (bot.status !== "published") throw new AppError("CONFLICT", "Publish the bot before connecting Telegram.", 409);
    const existing = await this.#repository.getOwnedTelegramDeployment({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      botId: input.botId,
    });
    if (existing) throw new AppError("CONFLICT", "This bot already has a Telegram deployment.", 409);

    const identity = await telegramApi<{ id: number; is_bot: boolean }>(input.token, "getMe", undefined, this.#fetch);
    if (!Number.isSafeInteger(identity.id) || identity.id <= 0 || identity.is_bot !== true) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram did not return a valid bot identity.", 502);
    }
    const id = `dep_${crypto.randomUUID()}` as TelegramDeploymentId;
    const webhookSecret = createWebhookSecret();
    let credentialRef: string | undefined;
    let webhookSecretRef: string | undefined;
    let saved = false;
    try {
      credentialRef = await this.#secrets.put(input.tenantId, input.token);
      webhookSecretRef = await this.#secrets.put(input.tenantId, webhookSecret);
      const deployment: TelegramDeployment = {
        id,
        tenantId: input.tenantId,
        botId: input.botId,
        externalId: String(identity.id),
        credentialRef,
        webhookSecretRef,
        status: "pending",
      };
      await this.#repository.createTelegramDeployment(deployment);
      saved = true;
      await telegramApi<boolean>(
        input.token,
        "setWebhook",
        {
          url: webhookUrl(base, id),
          secret_token: webhookSecret,
          allowed_updates: ["message"],
          max_connections: 20,
          drop_pending_updates: false,
        },
        this.#fetch,
      );
      await this.#repository.setTelegramDeploymentStatus({ tenantId: input.tenantId, id, status: "active" });
      return { ...deployment, status: "active" };
    } catch (cause) {
      if (saved) {
        try {
          await this.#repository.setTelegramDeploymentStatus({ tenantId: input.tenantId, id, status: "failed" });
        } catch {
          // Keep the public response generic; a pending deployment remains visible for cleanup.
        }
      } else {
        await Promise.allSettled([
          ...(credentialRef ? [this.#secrets.delete(input.tenantId, credentialRef)] : []),
          ...(webhookSecretRef ? [this.#secrets.delete(input.tenantId, webhookSecretRef)] : []),
        ]);
      }
      if (cause instanceof AppError) throw cause;
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram webhook registration failed.", 502);
    }
  }

  async disconnect(input: {
    readonly tenantId: TelegramDeployment["tenantId"];
    readonly ownerId: UserId;
    readonly botId: BotId;
  }): Promise<void> {
    const deployment = await this.#repository.getOwnedTelegramDeployment(input);
    if (!deployment) throw new AppError("NOT_FOUND", "Telegram deployment was not found.", 404);
    const token = await this.#secrets.resolve(input.tenantId, deployment.credentialRef);
    await telegramApi<boolean>(token, "deleteWebhook", { drop_pending_updates: false }, this.#fetch);
    await this.#repository.deleteTelegramDeployment({ tenantId: input.tenantId, id: deployment.id });
    await Promise.all([
      this.#secrets.delete(input.tenantId, deployment.credentialRef),
      this.#secrets.delete(input.tenantId, deployment.webhookSecretRef),
    ]);
  }

  async sendScheduledMessage(input: {
    readonly tenantId: TelegramDeployment["tenantId"];
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly telegramUserId: number;
    readonly text: string;
  }): Promise<void> {
    await this.assertScheduledRecipient(input);
    const deployment = await this.#repository.getOwnedTelegramDeployment(input);
    if (!deployment) throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram deployment is unavailable.", 503);
    const token = await this.#secrets.resolve(input.tenantId, deployment.credentialRef);
    for (const chunk of splitTelegramText(input.text)) {
      await telegramApi<boolean>(token, "sendMessage", { chat_id: input.telegramUserId, text: chunk }, this.#fetch);
    }
  }

  async assertScheduledRecipient(input: {
    readonly tenantId: TelegramDeployment["tenantId"];
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly telegramUserId: number;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.telegramUserId) || input.telegramUserId < 1) {
      throw new AppError("VALIDATION_ERROR", "Telegram user ID is invalid.", 400);
    }
    const deployment = await this.#repository.getOwnedTelegramDeployment(input);
    if (deployment?.status !== "active") {
      throw new AppError(
        "DEPENDENCY_UNAVAILABLE",
        "An active Telegram deployment is required for scheduled delivery.",
        503,
      );
    }
    if (
      !(await this.#repository.isTelegramSenderAllowed({
        deploymentId: deployment.id,
        telegramUserId: input.telegramUserId,
      }))
    ) {
      throw new AppError("FORBIDDEN", "Scheduled delivery requires an approved Telegram recipient.", 403);
    }
  }

  async handleWebhook(request: Request, id: TelegramDeploymentId): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const deployment = await this.#repository.getTelegramDeployment(id);
    if (!deployment || (deployment.status !== "active" && deployment.status !== "pending")) {
      return new Response(null, { status: 404 });
    }
    const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    const expectedSecret = await this.#secrets.resolve(deployment.tenantId, deployment.webhookSecretRef);
    if (!constantTimeEqual(suppliedSecret, expectedSecret)) return new Response(null, { status: 401 });

    let update: TelegramUpdate;
    try {
      update = await readTelegramUpdate(request);
    } catch (cause) {
      if (cause instanceof AppError) return Response.json({ error: cause.code }, { status: cause.status });
      return Response.json({ error: "VALIDATION_ERROR" }, { status: 400 });
    }

    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 120_000).toISOString();
    let shouldRelease = false;
    try {
      const reservation = await this.#repository.reserveTelegramUpdate({
        deploymentId: id,
        updateId: update.update_id,
        leaseUntil,
        now: now.toISOString(),
      });
      if (reservation.state === "completed") return new Response(null, { status: 200 });
      if (reservation.state === "busy") return new Response(null, { status: 503 });
      shouldRelease = true;

      let responseText: string;
      if (reservation.state === "ready") {
        responseText = reservation.responseText;
      } else {
        responseText = await this.#processUpdate(deployment, update, expectedSecret);
        await this.#repository.saveTelegramUpdateResponse({
          deploymentId: id,
          updateId: update.update_id,
          responseText,
          leaseUntil,
          now: new Date().toISOString(),
        });
      }

      if (responseText && update.message) {
        const token = await this.#secrets.resolve(deployment.tenantId, deployment.credentialRef);
        const chatId = update.message.chat.id;
        for (const chunk of splitTelegramText(responseText)) {
          await telegramApi<boolean>(token, "sendMessage", { chat_id: chatId, text: chunk }, this.#fetch);
        }
      }
      await this.#repository.completeTelegramUpdate({
        deploymentId: id,
        updateId: update.update_id,
        now: new Date().toISOString(),
      });
      shouldRelease = false;
      return new Response(null, { status: 200 });
    } catch {
      if (shouldRelease) {
        await this.#repository
          .releaseTelegramUpdate({
            deploymentId: id,
            updateId: update.update_id,
            now: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      return new Response(null, { status: 503 });
    }
  }

  async #processUpdate(deployment: TelegramDeployment, update: TelegramUpdate, webhookSecret: string): Promise<string> {
    const message = update.message;
    if (!message || typeof message.text !== "string" || message.text.trim().length === 0) return "";
    if (
      !message.chat ||
      !Number.isSafeInteger(message.chat.id) ||
      !message.from ||
      !Number.isSafeInteger(message.from.id) ||
      message.from.id < 1 ||
      message.from.is_bot
    ) {
      return "";
    }
    const allowed = await this.#repository.isTelegramSenderAllowed({
      deploymentId: deployment.id,
      telegramUserId: message.from.id,
    });
    if (!allowed) {
      await this.#repository.recordTelegramAccessRequest({
        deploymentId: deployment.id,
        telegramUserId: message.from.id,
        now: new Date().toISOString(),
      });
      return "";
    }
    const bot = await this.#bots.get(deployment.tenantId, deployment.botId);
    if (bot?.status !== "published") return "";
    const thread = Number.isSafeInteger(message.message_thread_id) ? String(message.message_thread_id) : "0";
    const actorKey = await hashTelegramIdentity(
      `${deployment.id}:${webhookSecret}:${message.chat.id}:${thread}:${message.from.id}`,
    );
    const actorId = `telegram_${actorKey}` as UserId;
    const conversationId = await this.#repository.getOrCreateTelegramConversation({
      tenantId: deployment.tenantId,
      botId: deployment.botId,
      actorId: bot.ownerId,
      conversationKey: `telegram:${actorKey}`,
    });
    const result = await this.#engine.respond({
      bot,
      conversationId,
      actorId,
      messages: [{ role: "user", content: message.text.slice(0, 10_000) }],
    });
    return result.message.content.slice(0, 100_000);
  }
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly text?: string;
    readonly chat: { readonly id: number };
    readonly from?: { readonly id: number; readonly is_bot?: boolean };
    readonly message_thread_id?: number;
  };
}

export async function readTelegramUpdate(request: Request): Promise<TelegramUpdate> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Telegram update must use JSON.", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 65_536)
    throw new AppError("VALIDATION_ERROR", "Telegram update is too large.", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 65_536)
    throw new AppError("VALIDATION_ERROR", "Telegram update is too large.", 413);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Telegram update JSON is invalid.", 400, { cause });
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.update_id) || (value.update_id as number) < 0) {
    throw new AppError("VALIDATION_ERROR", "Telegram update is invalid.", 400);
  }
  if (value.message === undefined) return { update_id: value.update_id as number };
  if (!isRecord(value.message) || !isRecord(value.message.chat) || !Number.isSafeInteger(value.message.chat.id)) {
    throw new AppError("VALIDATION_ERROR", "Telegram message is invalid.", 400);
  }
  const from =
    isRecord(value.message.from) && Number.isSafeInteger(value.message.from.id)
      ? {
          id: value.message.from.id as number,
          ...(typeof value.message.from.is_bot === "boolean" ? { is_bot: value.message.from.is_bot } : {}),
        }
      : undefined;
  return {
    update_id: value.update_id as number,
    message: {
      chat: { id: value.message.chat.id as number },
      ...(typeof value.message.text === "string" ? { text: value.message.text } : {}),
      ...(from ? { from } : {}),
      ...(Number.isSafeInteger(value.message.message_thread_id)
        ? { message_thread_id: value.message.message_thread_id as number }
        : {}),
    },
  };
}

async function telegramApi<T>(token: string, method: string, body: unknown, fetcher: FetchLike): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error("Telegram request failed.");
    const text = await response.text();
    if (text.length > 65_536) throw new Error("Telegram response was too large.");
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.ok !== true || !("result" in value)) throw new Error("Telegram request failed.");
    return value.result as T;
  } catch {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram Bot API request failed.", 502);
  } finally {
    clearTimeout(timeout);
  }
}

function parseWebhookBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("UNSUPPORTED_CAPABILITY", "Telegram webhooks are not configured for this runtime.", 501);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new AppError("UNSUPPORTED_CAPABILITY", "Telegram requires a configured HTTPS webhook base URL.", 501);
  }
  return url;
}

function webhookUrl(base: URL, id: TelegramDeploymentId): string {
  return `${base.toString().replace(/\/+$/, "")}/webhooks/telegram/${id}`;
}

function createWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function hashTelegramIdentity(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function splitTelegramText(text: string): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += 4000)
    chunks.push(characters.slice(index, index + 4000).join(""));
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow, "cache-control": "no-store" } },
  );
}
