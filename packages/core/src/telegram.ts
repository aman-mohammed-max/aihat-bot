import { AppError } from "./errors.js";
import { DEFAULT_TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE } from "./config.js";
import {
  DOCX_CONTENT_TYPE,
  EXTRACTED_DOCUMENT_MAX_CHARS,
  TELEGRAM_DOCUMENT_MAX_BYTES,
  extractAgentDocumentText,
  hasPdfSignature,
  hasZipSignature,
} from "./document-extraction.js";
import type {
  AgentEngine,
  BotRepository,
  MalwareScanner,
  ObjectStore,
  SecretStore,
  SecretWriter,
  TelegramDeployment,
  TelegramRepository,
  Logger,
} from "./ports.js";
import type { AgentImageAttachment, BotId, TelegramDeploymentId, UserId } from "./types.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TelegramRetryPolicy {
  readonly maxAttempts: number;
  readonly maxRetryAfterSeconds: number;
}

export interface TelegramApiOptions {
  readonly retryPolicy?: TelegramRetryPolicy;
  readonly logger?: Pick<Logger, "warn">;
}

const DEFAULT_TELEGRAM_RETRY_POLICY: TelegramRetryPolicy = { maxAttempts: 2, maxRetryAfterSeconds: 3 };

interface TelegramAgentReply {
  readonly text: string;
  readonly attachments?: readonly AgentImageAttachment[];
}

/** Telegram webhook registration and delivery using encrypted per-deployment credentials. */
export class TelegramManager {
  readonly #repository: TelegramRepository;
  readonly #bots: BotRepository;
  readonly #secrets: SecretStore & SecretWriter;
  readonly #engine: AgentEngine;
  readonly #webhookBaseUrl: string;
  readonly #objects: ObjectStore | undefined;
  readonly #malwareScanner: MalwareScanner | undefined;
  readonly #fetch: FetchLike;
  readonly #retryPolicy: TelegramRetryPolicy;
  readonly #logger: Pick<Logger, "warn"> | undefined;
  readonly #requestsPerMinute: number;
  readonly #now: () => Date;

  constructor(input: {
    readonly repository: TelegramRepository;
    readonly bots: BotRepository;
    readonly secrets: SecretStore & SecretWriter;
    readonly engine: AgentEngine;
    readonly webhookBaseUrl: string;
    readonly objects?: ObjectStore;
    readonly malwareScanner?: MalwareScanner;
    readonly fetch?: FetchLike;
    readonly retryPolicy?: TelegramRetryPolicy;
    readonly requestsPerMinute?: number;
    readonly now?: () => Date;
    readonly logger?: Pick<Logger, "warn">;
  }) {
    this.#repository = input.repository;
    this.#bots = input.bots;
    this.#secrets = input.secrets;
    this.#engine = input.engine;
    this.#webhookBaseUrl = input.webhookBaseUrl;
    this.#objects = input.objects;
    this.#malwareScanner = input.malwareScanner;
    this.#fetch = input.fetch ?? globalThis.fetch.bind(globalThis);
    this.#retryPolicy = normalizeTelegramRetryPolicy(input.retryPolicy ?? DEFAULT_TELEGRAM_RETRY_POLICY);
    this.#requestsPerMinute = input.requestsPerMinute ?? DEFAULT_TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE;
    if (
      !Number.isSafeInteger(this.#requestsPerMinute) ||
      this.#requestsPerMinute < 1 ||
      this.#requestsPerMinute > 1000
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Telegram customer request limit must be from 1 to 1,000 per minute.",
        400,
      );
    }
    this.#now = input.now ?? (() => new Date());
    this.#logger = input.logger;
  }

  async connect(input: {
    readonly tenantId: TelegramDeployment["tenantId"];
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly token: string;
  }): Promise<TelegramDeployment> {
    const base = parseWebhookBaseUrl(this.#webhookBaseUrl);
    if (!/^\d{5,15}:[A-Za-z0-9_-]{20,128}$/.test(input.token)) {
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

    const identity = await this.#api<{ id: number; is_bot: boolean }>(input.token, "getMe", undefined);
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
      await this.#api<boolean>(input.token, "setWebhook", {
        url: webhookUrl(base, id),
        secret_token: webhookSecret,
        allowed_updates: ["message"],
        max_connections: 20,
        drop_pending_updates: false,
      });
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
    await this.#api<boolean>(token, "deleteWebhook", { drop_pending_updates: false });
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
      await this.#api<boolean>(token, "sendMessage", { chat_id: input.telegramUserId, text: chunk });
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

    const now = this.#now();
    const leaseUntil = new Date(now.getTime() + 120_000).toISOString();
    let shouldRelease = false;
    try {
      const reservation = await this.#repository.reserveTelegramUpdate({
        deploymentId: id,
        updateId: update.update_id,
        leaseUntil,
        now: now.toISOString(),
      });
      if (reservation.state === "completed") {
        await this.#cleanupTelegramAttachments(
          deployment.tenantId,
          id,
          update.update_id,
          reservation.attachmentRefs ?? [],
        );
        return new Response(null, { status: 200 });
      }
      if (reservation.state === "busy") return new Response(null, { status: 503 });
      shouldRelease = true;

      let responseText: string;
      let attachmentRefs: readonly { readonly kind: "image"; readonly secretRef: string }[] = [];
      if (reservation.state === "ready") {
        responseText = reservation.responseText;
        attachmentRefs = reservation.attachmentRefs ?? [];
      } else {
        const reply = await this.#processUpdate(deployment, update, expectedSecret);
        responseText = reply.text;
        const savedRefs: { kind: "image"; secretRef: string }[] = [];
        try {
          for (const attachment of reply.attachments ?? []) {
            if (attachment.kind !== "image") continue;
            if (!isHttpsImageUrl(attachment.url)) {
              throw new AppError("VALIDATION_ERROR", "Telegram image attachment URL is invalid.", 400);
            }
            savedRefs.push({ kind: "image", secretRef: await this.#secrets.put(deployment.tenantId, attachment.url) });
          }
          attachmentRefs = savedRefs;
          await this.#repository.saveTelegramUpdateResponse({
            deploymentId: id,
            updateId: update.update_id,
            responseText,
            ...(attachmentRefs.length ? { attachmentRefs } : {}),
            leaseUntil,
            now: this.#now().toISOString(),
          });
        } catch (cause) {
          await Promise.allSettled(
            savedRefs.map(({ secretRef }) => this.#secrets.delete(deployment.tenantId, secretRef)),
          );
          throw cause;
        }
      }

      if ((responseText || attachmentRefs.length) && update.message) {
        const token = await this.#secrets.resolve(deployment.tenantId, deployment.credentialRef);
        const chatId = update.message.chat.id;
        const threadId = Number.isSafeInteger(update.message.message_thread_id)
          ? update.message.message_thread_id
          : undefined;
        for (const chunk of splitTelegramText(responseText)) {
          if (chunk) {
            await this.#api<boolean>(token, "sendMessage", {
              chat_id: chatId,
              ...(threadId === undefined ? {} : { message_thread_id: threadId }),
              text: chunk,
            });
          }
        }
        for (const attachment of attachmentRefs) {
          const photo = await this.#secrets.resolve(deployment.tenantId, attachment.secretRef);
          if (!isHttpsImageUrl(photo)) throw new AppError("INTERNAL_ERROR", "Stored image attachment is invalid.", 500);
          await this.#api<boolean>(token, "sendPhoto", {
            chat_id: chatId,
            ...(threadId === undefined ? {} : { message_thread_id: threadId }),
            photo,
          });
        }
      }
      await this.#repository.completeTelegramUpdate({
        deploymentId: id,
        updateId: update.update_id,
        leaseUntil,
        now: this.#now().toISOString(),
      });
      shouldRelease = false;
      await this.#cleanupTelegramAttachments(deployment.tenantId, id, update.update_id, attachmentRefs);
      return new Response(null, { status: 200 });
    } catch {
      if (shouldRelease) {
        await this.#repository
          .releaseTelegramUpdate({
            deploymentId: id,
            updateId: update.update_id,
            leaseUntil,
            now: this.#now().toISOString(),
          })
          .catch(() => undefined);
      }
      return new Response(null, { status: 503 });
    }
  }

  async #processUpdate(
    deployment: TelegramDeployment,
    update: TelegramUpdate,
    webhookSecret: string,
  ): Promise<TelegramAgentReply> {
    const message = update.message;
    if (!message) return { text: "" };
    if (
      !message.chat ||
      !Number.isSafeInteger(message.chat.id) ||
      !message.from ||
      !Number.isSafeInteger(message.from.id) ||
      message.from.id < 1 ||
      message.from.is_bot
    ) {
      return { text: "" };
    }
    if (
      !message.text?.trim() &&
      !message.caption?.trim() &&
      !message.photo?.length &&
      !message.document &&
      !message.unsupportedAttachment
    ) {
      return { text: "" };
    }
    const allowed = await this.#repository.isTelegramSenderAllowed({
      deploymentId: deployment.id,
      telegramUserId: message.from.id,
    });
    if (!allowed) {
      await this.#repository.recordTelegramAccessRequest({
        deploymentId: deployment.id,
        telegramUserId: message.from.id,
        now: this.#now().toISOString(),
      });
      return { text: "" };
    }
    const actorHash = await hashTelegramIdentity(`${deployment.id}:${webhookSecret}:${message.from.id}`);
    const withinLimit = await this.#repository.consumeTelegramUserRequest({
      deploymentId: deployment.id,
      actorHash,
      now: this.#now().toISOString(),
      limitPerMinute: this.#requestsPerMinute,
    });
    if (!withinLimit) return { text: "" };
    const bot = await this.#bots.get(deployment.tenantId, deployment.botId);
    if (bot?.status !== "published") return { text: "" };
    if (message.unsupportedAttachment && !message.photo?.length && !message.document) {
      return {
        text: "I can read photos, small text files, and text-based PDF or DOCX documents.",
      };
    }
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
    const token = await this.#secrets.resolve(deployment.tenantId, deployment.credentialRef);
    let userContent = (message.text ?? message.caption ?? "").slice(0, 10_000);
    let images: readonly { readonly dataUrl: string; readonly detail: "auto" }[] | undefined;
    let containsUntrustedAttachments = false;
    if (message.photo?.length || message.document) {
      let attachment: { readonly image?: string; readonly text?: string; readonly unsupported?: string };
      try {
        attachment = await this.#loadAttachment(deployment, token, message);
      } catch (cause) {
        if (cause instanceof AppError && cause.code === "VALIDATION_ERROR") {
          return { text: "That attachment is too large or has an unsupported format." };
        }
        throw cause;
      }
      if (attachment.unsupported) return { text: attachment.unsupported };
      containsUntrustedAttachments = true;
      if (attachment.text) userContent = `${userContent}${userContent ? "\n\n" : ""}${attachment.text}`;
      if (attachment.image) {
        userContent = userContent || "Please describe this image.";
        images = [{ dataUrl: attachment.image, detail: "auto" }];
      }
    }
    if (!userContent && !images?.length) return { text: "" };

    const threadId = Number.isSafeInteger(message.message_thread_id) ? message.message_thread_id : undefined;
    const stopTyping = startTelegramTyping(token, message.chat.id, this.#fetch, threadId, {
      retryPolicy: this.#retryPolicy,
      ...(this.#logger ? { logger: this.#logger } : {}),
    });
    try {
      try {
        const result = await this.#engine.respond({
          bot,
          conversationId,
          executionId: `telegram:${deployment.id}:${update.update_id}`,
          actorId,
          actorContext: {
            platform: "telegram",
            telegramDeploymentId: deployment.id,
            telegramUserId: message.from.id,
          },
          ...(containsUntrustedAttachments ? { containsUntrustedAttachments: true } : {}),
          messages: [{ role: "user", content: userContent, ...(images ? { images } : {}) }],
        });
        return {
          text: result.message.content.slice(0, 100_000),
          ...(result.attachments?.length ? { attachments: result.attachments.slice(0, 4) } : {}),
        };
      } catch (cause) {
        if (cause instanceof AppError && cause.code === "UNSUPPORTED_CAPABILITY") {
          return {
            text: "This bot's configured model can't process images. Ask the bot owner to connect a vision-capable model.",
          };
        }
        throw cause;
      }
    } finally {
      stopTyping();
    }
  }

  async #loadAttachment(
    deployment: TelegramDeployment,
    token: string,
    message: TelegramMessage,
  ): Promise<{ readonly image?: string; readonly text?: string; readonly unsupported?: string }> {
    if (!this.#objects) return { unsupported: "File attachments are not configured for this bot runtime." };
    const photo = message.photo
      ? [...message.photo].sort((left, right) => (left.file_size ?? 0) - (right.file_size ?? 0)).at(-1)
      : undefined;
    const document = message.document;
    const name = document?.file_name ? safeFileName(document.file_name) : "attachment";
    const isDocumentImage = !!document && isSupportedImageNameOrType(name, document.mime_type);
    const isTextDocument = !!document && (isSupportedTextName(name) || isSupportedTextMime(document.mime_type));
    const isPdfDocument = !!document && isSupportedPdfNameOrType(name, document.mime_type);
    const isDocxDocument = !!document && isSupportedDocxNameOrType(name, document.mime_type);
    if (document && !isDocumentImage && !isTextDocument && !isPdfDocument && !isDocxDocument) {
      return {
        unsupported: "I can read photos, small text files, and text-based PDF or DOCX documents.",
      };
    }
    if (
      document &&
      document.file_size !== undefined &&
      document.file_size > MAX_TELEGRAM_TEXT_BYTES &&
      isTextDocument
    ) {
      return { unsupported: "Text attachments must be 64 KB or smaller." };
    }
    if (
      document &&
      document.file_size !== undefined &&
      document.file_size > TELEGRAM_DOCUMENT_MAX_BYTES &&
      (isPdfDocument || isDocxDocument)
    ) {
      return { unsupported: "PDF and DOCX attachments must be 2 MiB or smaller." };
    }
    const fileId = photo?.file_id ?? document?.file_id;
    if (!fileId) return { unsupported: "I couldn't read that attachment. Please send it again." };
    const imageRequested = !!photo || isDocumentImage;
    const isStructuredDocument = isPdfDocument || isDocxDocument;
    const maxBytes = imageRequested
      ? MAX_TELEGRAM_IMAGE_BYTES
      : isStructuredDocument
        ? TELEGRAM_DOCUMENT_MAX_BYTES
        : MAX_TELEGRAM_TEXT_BYTES;
    if ((photo?.file_size ?? document?.file_size ?? 0) > maxBytes) {
      return {
        unsupported: imageRequested
          ? "Images must be 8 MB or smaller."
          : isStructuredDocument
            ? "PDF and DOCX attachments must be 2 MiB or smaller."
            : "Text attachments must be 64 KB or smaller.",
      };
    }

    const file = await this.#api<{ readonly file_path?: unknown }>(token, "getFile", { file_id: fileId });
    if (typeof file.file_path !== "string" || !isSafeTelegramFilePath(file.file_path)) {
      return { unsupported: "Telegram couldn't provide that attachment. Please send it again." };
    }
    const bytes = await downloadTelegramFile(token, file.file_path, maxBytes, this.#fetch);
    const expectedSize = photo?.file_size ?? document?.file_size;
    if (expectedSize !== undefined && expectedSize !== bytes.byteLength) {
      return { unsupported: "Telegram attachment metadata did not match the downloaded file." };
    }
    const imageType = detectImageType(bytes);
    if (imageRequested) {
      if (!imageType) return { unsupported: "That image format isn't supported. Send a JPEG, PNG, or WebP image." };
      if (!(await this.#scanAttachment(name, imageType, bytes))) {
        return {
          unsupported: "That image could not pass security scanning. Ask the bot owner to check the file scanner.",
        };
      }
      const objectId = `tg_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await this.#objects.put({ tenantId: deployment.tenantId, objectId, contentType: imageType, bytes });
        const stored = await this.#objects.get(deployment.tenantId, objectId);
        if (!stored || stored.contentType !== imageType || stored.size !== bytes.byteLength) {
          throw new AppError("INTERNAL_ERROR", "Stored Telegram image failed validation.", 500);
        }
        return { image: `data:${imageType};base64,${encodeBase64(stored.bytes)}` };
      } finally {
        await this.#objects.delete(deployment.tenantId, objectId).catch(() => undefined);
      }
    }
    if (bytes.byteLength > MAX_TELEGRAM_TEXT_BYTES && !isStructuredDocument) {
      return { unsupported: "Text attachments must be 64 KB or smaller." };
    }
    if (isPdfDocument || isDocxDocument) {
      const contentType = isPdfDocument ? "application/pdf" : DOCX_CONTENT_TYPE;
      const hasSignature = isPdfDocument ? hasPdfSignature(bytes) : hasZipSignature(bytes);
      if (!hasSignature) {
        return { unsupported: "That file does not match its PDF or DOCX format." };
      }
      if (!(await this.#scanAttachment(name, contentType, bytes))) {
        return {
          unsupported: "That document could not pass security scanning. Ask the bot owner to check the file scanner.",
        };
      }
      const objectId = `tg_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await this.#objects.put({ tenantId: deployment.tenantId, objectId, contentType, bytes });
        const stored = await this.#objects.get(deployment.tenantId, objectId);
        if (!stored || stored.contentType !== contentType || stored.size !== bytes.byteLength) {
          throw new AppError("INTERNAL_ERROR", "Stored Telegram document failed validation.", 500);
        }
        let text: string;
        try {
          text = await extractAgentDocumentText(stored.bytes, contentType);
        } catch {
          return {
            unsupported:
              "I couldn't extract readable text from that document. It may be damaged, encrypted, or a scanned PDF that needs OCR.",
          };
        }
        const kind = isPdfDocument ? "PDF" : "DOCX";
        return { text: `[Attached ${kind} file: ${name}]\n${text.slice(0, EXTRACTED_DOCUMENT_MAX_CHARS)}` };
      } finally {
        await this.#objects.delete(deployment.tenantId, objectId).catch(() => undefined);
      }
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { unsupported: "That file isn't valid UTF-8 text. Send a supported text document instead." };
    }
    if (text.includes("\0")) return { unsupported: "That file doesn't look like a text document." };
    if (!(await this.#scanAttachment(name, "text/plain", bytes))) {
      return {
        unsupported: "That document could not pass security scanning. Ask the bot owner to check the file scanner.",
      };
    }
    const objectId = `tg_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await this.#objects.put({
        tenantId: deployment.tenantId,
        objectId,
        contentType: "text/plain; charset=utf-8",
        bytes,
      });
      const stored = await this.#objects.get(deployment.tenantId, objectId);
      if (!stored || stored.size !== bytes.byteLength) {
        throw new AppError("INTERNAL_ERROR", "Stored Telegram document failed validation.", 500);
      }
      return { text: `[Attached text file: ${name}]\n${text.slice(0, MAX_TELEGRAM_TEXT_CHARS)}` };
    } finally {
      await this.#objects.delete(deployment.tenantId, objectId).catch(() => undefined);
    }
  }

  async #scanAttachment(fileName: string, contentType: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.#malwareScanner) return false;
    try {
      const result = await this.#malwareScanner.scan({ fileName, contentType, bytes });
      return result.verdict === "clean";
    } catch {
      return false;
    }
  }

  async #cleanupTelegramAttachments(
    tenantId: TelegramDeployment["tenantId"],
    deploymentId: TelegramDeploymentId,
    updateId: number,
    attachments: readonly { readonly kind: "image"; readonly secretRef: string }[],
  ): Promise<void> {
    if (!attachments.length) return;
    const deleted = await Promise.allSettled(
      attachments.map(({ secretRef }) => this.#secrets.delete(tenantId, secretRef)),
    );
    if (deleted.every((result) => result.status === "fulfilled")) {
      await this.#repository.clearTelegramUpdateAttachments({ deploymentId, updateId });
    }
  }

  #api<T>(token: string, method: string, body: unknown): Promise<T> {
    return telegramApi(token, method, body, this.#fetch, {
      retryPolicy: this.#retryPolicy,
      ...(this.#logger ? { logger: this.#logger } : {}),
    });
  }
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

interface TelegramMessage {
  readonly text?: string;
  readonly caption?: string;
  readonly chat: { readonly id: number };
  readonly from?: { readonly id: number; readonly is_bot?: boolean };
  readonly message_thread_id?: number;
  readonly photo?: readonly { readonly file_id: string; readonly file_size?: number }[];
  readonly document?: {
    readonly file_id: string;
    readonly file_name?: string;
    readonly mime_type?: string;
    readonly file_size?: number;
  };
  readonly unsupportedAttachment?: boolean;
}

export async function readTelegramUpdate(request: Request): Promise<TelegramUpdate> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Telegram update must use JSON.", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 65_536)
    throw new AppError("VALIDATION_ERROR", "Telegram update is too large.", 413);
  const raw = await readBoundedRequestText(request, 65_536);
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
  const rawMessage = value.message as Record<string, unknown>;
  const from =
    isRecord(value.message.from) && Number.isSafeInteger(value.message.from.id)
      ? {
          id: value.message.from.id as number,
          ...(typeof value.message.from.is_bot === "boolean" ? { is_bot: value.message.from.is_bot } : {}),
        }
      : undefined;
  const photo = parseTelegramPhoto(value.message.photo);
  const document = parseTelegramDocument(value.message.document);
  const unsupportedAttachment = ["animation", "audio", "sticker", "video", "video_note", "voice"].some(
    (key) => rawMessage[key] !== undefined,
  );
  return {
    update_id: value.update_id as number,
    message: {
      chat: { id: value.message.chat.id as number },
      ...(typeof value.message.text === "string" ? { text: value.message.text } : {}),
      ...(typeof value.message.caption === "string" ? { caption: value.message.caption } : {}),
      ...(from ? { from } : {}),
      ...(photo ? { photo } : {}),
      ...(document ? { document } : {}),
      ...(unsupportedAttachment ? { unsupportedAttachment: true } : {}),
      ...(Number.isSafeInteger(value.message.message_thread_id)
        ? { message_thread_id: value.message.message_thread_id as number }
        : {}),
    },
  };
}

function parseTelegramPhoto(value: unknown): TelegramMessage["photo"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new AppError("VALIDATION_ERROR", "Telegram photo metadata is invalid.", 400);
  }
  const photo = value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.file_id !== "string" ||
      item.file_id.length < 1 ||
      item.file_id.length > 256 ||
      (item.file_size !== undefined &&
        (!Number.isSafeInteger(item.file_size) ||
          (item.file_size as number) < 0 ||
          (item.file_size as number) > 20_000_000))
    ) {
      throw new AppError("VALIDATION_ERROR", "Telegram photo metadata is invalid.", 400);
    }
    return {
      file_id: item.file_id,
      ...(typeof item.file_size === "number" ? { file_size: item.file_size } : {}),
    };
  });
  return photo;
}

function parseTelegramDocument(value: unknown): TelegramMessage["document"] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.file_id !== "string" ||
    value.file_id.length < 1 ||
    value.file_id.length > 256 ||
    (value.file_name !== undefined && (typeof value.file_name !== "string" || value.file_name.length > 512)) ||
    (value.mime_type !== undefined && (typeof value.mime_type !== "string" || value.mime_type.length > 255)) ||
    (value.file_size !== undefined &&
      (!Number.isSafeInteger(value.file_size) ||
        (value.file_size as number) < 0 ||
        (value.file_size as number) > 20_000_000))
  ) {
    throw new AppError("VALIDATION_ERROR", "Telegram document metadata is invalid.", 400);
  }
  return {
    file_id: value.file_id,
    ...(typeof value.file_name === "string" ? { file_name: value.file_name } : {}),
    ...(typeof value.mime_type === "string" ? { mime_type: value.mime_type } : {}),
    ...(typeof value.file_size === "number" ? { file_size: value.file_size } : {}),
  };
}

export async function telegramApi<T>(
  token: string,
  method: string,
  body: unknown,
  fetcher: FetchLike,
  options: TelegramApiOptions = {},
): Promise<T> {
  const retryPolicy = normalizeTelegramRetryPolicy(options.retryPolicy ?? DEFAULT_TELEGRAM_RETRY_POLICY);
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let retryAfter: number | undefined;
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (text.length > 65_536) throw new Error("Telegram response was too large.");
      const value: unknown = JSON.parse(text);
      if (response.ok && isRecord(value) && value.ok === true && "result" in value) {
        return value.result as T;
      }
      if (
        !response.ok &&
        response.status === 429 &&
        isRecord(value) &&
        isRecord(value.parameters) &&
        Number.isSafeInteger(value.parameters.retry_after) &&
        (value.parameters.retry_after as number) >= 0 &&
        (value.parameters.retry_after as number) <= retryPolicy.maxRetryAfterSeconds
      ) {
        retryAfter = value.parameters.retry_after as number;
      }
    } catch {
      // Network and malformed responses are ambiguous for write methods; don't replay them.
    } finally {
      clearTimeout(timeout);
    }
    if (retryAfter === undefined || attempt >= retryPolicy.maxAttempts) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram Bot API request failed.", 502);
    }
    try {
      options.logger?.warn("dependency.retry", {
        service: "telegram",
        attempt,
        maxAttempts: retryPolicy.maxAttempts,
        delayMs: retryAfter * 1000,
        statusCode: 429,
        method,
      });
    } catch {
      // Observability must not change retry behavior.
    }
    if (retryAfter > 0) await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
  throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram Bot API request failed.", 502);
}

function normalizeTelegramRetryPolicy(policy: TelegramRetryPolicy): TelegramRetryPolicy {
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 3 ||
    !Number.isSafeInteger(policy.maxRetryAfterSeconds) ||
    policy.maxRetryAfterSeconds < 0 ||
    policy.maxRetryAfterSeconds > 3
  ) {
    throw new AppError("VALIDATION_ERROR", "Telegram retry policy is invalid.", 400);
  }
  return { ...policy };
}

async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError("VALIDATION_ERROR", "Telegram update is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Telegram update must be valid UTF-8 JSON.", 400, { cause });
  }
}

const MAX_TELEGRAM_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TELEGRAM_TEXT_BYTES = 64 * 1024;
const MAX_TELEGRAM_TEXT_CHARS = 60_000;

async function downloadTelegramFile(
  token: string,
  filePath: string,
  maxBytes: number,
  fetcher: FetchLike,
): Promise<Uint8Array> {
  const url = new URL(`/file/bot${token}/${filePath}`, "https://api.telegram.org");
  if (url.origin !== "https://api.telegram.org" || !url.pathname.startsWith(`/file/bot${token}/`)) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram attachment URL was invalid.", 502);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetcher(url, { method: "GET", redirect: "error", signal: controller.signal });
    const contentLength = response.headers.get("content-length");
    const advertisedLength = contentLength === null ? undefined : Number(contentLength);
    if (
      !response.ok ||
      (advertisedLength !== undefined &&
        (!Number.isSafeInteger(advertisedLength) || advertisedLength < 0 || advertisedLength > maxBytes)) ||
      !response.body
    ) {
      throw new Error("Telegram attachment download failed.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new AppError("VALIDATION_ERROR", "Telegram attachment exceeds the supported size.", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (advertisedLength !== undefined && size !== advertisedLength) {
      throw new Error("Telegram attachment size was inconsistent.");
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Telegram attachment download failed.", 502, { cause });
  } finally {
    clearTimeout(timeout);
  }
}

function startTelegramTyping(
  token: string,
  chatId: number,
  fetcher: FetchLike,
  threadId?: number,
  options?: TelegramApiOptions,
): () => void {
  const send = () =>
    telegramApi<boolean>(
      token,
      "sendChatAction",
      { chat_id: chatId, ...(threadId === undefined ? {} : { message_thread_id: threadId }), action: "typing" },
      fetcher,
      options,
    );
  void send().catch(() => undefined);
  const timer = setInterval(() => void send().catch(() => undefined), 4_000);
  return () => clearInterval(timer);
}

function isSafeTelegramFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    value.split("/").every((segment) => /^[A-Za-z0-9_.-]{1,255}$/.test(segment) && segment !== "." && segment !== "..")
  );
}

function safeFileName(value: string): string {
  const basename = value.split(/[\\/]/).at(-1) ?? "attachment";
  const cleaned = basename
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .slice(0, 120)
    .trim();
  return cleaned || "attachment";
}

function isSupportedImageNameOrType(name: string, mimeType: string | undefined): boolean {
  return (
    /\.(?:jpe?g|png|webp)$/i.test(name) ||
    (mimeType !== undefined && ["image/jpeg", "image/png", "image/webp"].includes(mimeType.toLowerCase()))
  );
}

function isSupportedTextName(name: string): boolean {
  return /\.(?:txt|md|markdown|csv|tsv|json|jsonl|ndjson|xml|yaml|yml|log)$/i.test(name);
}

function isSupportedTextMime(mimeType: string | undefined): boolean {
  return (
    mimeType !== undefined &&
    [
      "text/plain",
      "text/markdown",
      "text/csv",
      "text/tab-separated-values",
      "application/json",
      "application/x-ndjson",
      "application/xml",
      "application/yaml",
    ].includes(mimeType.split(";")[0]?.trim().toLowerCase() ?? "")
  );
}

function isSupportedPdfNameOrType(name: string, mimeType: string | undefined): boolean {
  return /\.pdf$/i.test(name) || mimeType?.split(";")[0]?.trim().toLowerCase() === "application/pdf";
}

function isSupportedDocxNameOrType(name: string, mimeType: string | undefined): boolean {
  return /\.docx$/i.test(name) || mimeType?.split(";")[0]?.trim().toLowerCase() === DOCX_CONTENT_TYPE;
}

function detectImageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
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

function isHttpsImageUrl(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
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
