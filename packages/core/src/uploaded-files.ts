import { AppError, unsupportedCapability } from "./errors.js";
import type { BotRepository, MalwareScanner, ObjectStore, UploadedFileRepository } from "./ports.js";
import type { BotId, TenantId, UploadedFile, UserId } from "./types.js";

export const MAX_UPLOADED_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOADED_FILES_PER_BOT = 100;
export const MAX_UPLOADED_BYTES_PER_BOT = 250 * 1024 * 1024;
export const MAX_UPLOADED_FILE_LIST = 100;

const SUPPORTED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

export interface UploadedFilesServiceOptions {
  readonly bots: BotRepository;
  readonly files: UploadedFileRepository;
  readonly objects: ObjectStore;
  readonly scanner?: MalwareScanner;
  readonly runtime: "bun" | "cloudflare";
  readonly now?: () => Date;
}

/** Owns file metadata, quarantine state, scanning, and tenant-scoped object access. */
export class UploadedFilesService {
  readonly #bots: BotRepository;
  readonly #files: UploadedFileRepository;
  readonly #objects: ObjectStore;
  readonly #scanner: MalwareScanner | undefined;
  readonly #runtime: "bun" | "cloudflare";
  readonly #now: () => Date;

  constructor(options: UploadedFilesServiceOptions) {
    this.#bots = options.bots;
    this.#files = options.files;
    this.#objects = options.objects;
    this.#scanner = options.scanner;
    this.#runtime = options.runtime;
    this.#now = options.now ?? (() => new Date());
  }

  async list(input: { readonly tenantId: TenantId; readonly ownerId: UserId; readonly botId: BotId }) {
    await this.#requireOwnedBot(input);
    return this.#files.listOwnedUploadedFiles({ ...input, limit: MAX_UPLOADED_FILE_LIST });
  }

  async get(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly fileId: string;
  }): Promise<UploadedFile> {
    await this.#requireOwnedBot(input);
    const file = await this.#files.getOwnedUploadedFile(input);
    if (!file) throw new AppError("NOT_FOUND", "Uploaded file was not found.", 404);
    return file;
  }

  async upload(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly fileName: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<UploadedFile> {
    await this.#requireOwnedBot(input);
    validateFileName(input.fileName);
    const contentType = normalizeContentType(input.contentType);
    validateExtension(input.fileName, contentType);
    validateFileBytes(contentType, input.bytes);
    const usage = await this.#files.getOwnedUploadedFileUsage({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      botId: input.botId,
    });
    if (
      usage.files >= MAX_UPLOADED_FILES_PER_BOT ||
      usage.bytes + input.bytes.byteLength > MAX_UPLOADED_BYTES_PER_BOT
    ) {
      throw new AppError("VALIDATION_ERROR", "This bot has reached its uploaded-file storage limit.", 413);
    }

    const id = `file_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = this.#now().toISOString();
    const stored = await this.#objects.put({
      tenantId: input.tenantId,
      objectId: id,
      contentType,
      bytes: input.bytes,
    });
    const file: UploadedFile = {
      id,
      botId: input.botId,
      fileName: input.fileName,
      contentType,
      size: stored.size,
      etag: stored.etag,
      scanStatus: "pending_scan",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#files.createUploadedFile({
        file,
        tenantId: input.tenantId,
        ownerId: input.ownerId,
      });
    } catch (cause) {
      await this.#objects.delete(input.tenantId, id).catch(() => undefined);
      throw cause;
    }
    return this.#scanner ? this.#scanBytes(input, file, input.bytes) : file;
  }

  async scan(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly fileId: string;
  }): Promise<UploadedFile> {
    const file = await this.get(input);
    if (file.scanStatus === "clean" || file.scanStatus === "rejected") return file;
    if (!this.#scanner) throw unsupportedCapability("fileMalwareScanning", this.#runtime);
    const stored = await this.#objects.get(input.tenantId, file.id);
    if (!stored) throw new AppError("INTERNAL_ERROR", "Uploaded file data is missing.", 500);
    if (stored.size !== file.size || stored.contentType !== file.contentType) {
      throw new AppError("INTERNAL_ERROR", "Uploaded file metadata failed validation.", 500);
    }
    return this.#scanBytes(input, file, stored.bytes);
  }

  async getContent(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly fileId: string;
  }) {
    const file = await this.get(input);
    if (file.scanStatus !== "clean") {
      throw new AppError("CONFLICT", "Only files that passed malware scanning can be downloaded.", 409);
    }
    const object = await this.#objects.getStream(input.tenantId, file.id);
    if (!object) throw new AppError("NOT_FOUND", "Uploaded file data was not found.", 404);
    if (object.size !== file.size || object.contentType !== file.contentType || object.etag !== file.etag) {
      await object.body.cancel().catch(() => undefined);
      throw new AppError("INTERNAL_ERROR", "Uploaded file metadata failed validation.", 500);
    }
    return { file, body: object.body };
  }

  async delete(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly fileId: string;
  }): Promise<void> {
    const file = await this.get(input);
    await this.#objects.delete(input.tenantId, file.id);
    const deleted = await this.#files.deleteOwnedUploadedFile(input);
    if (!deleted) throw new AppError("CONFLICT", "Uploaded file changed before deletion.", 409);
  }

  async #scanBytes(
    owner: { readonly tenantId: TenantId; readonly ownerId: UserId; readonly botId: BotId; readonly fileId?: string },
    file: UploadedFile,
    bytes: Uint8Array,
  ): Promise<UploadedFile> {
    if (!this.#scanner) throw unsupportedCapability("fileMalwareScanning", this.#runtime);
    let status: UploadedFile["scanStatus"] = "scan_failed";
    let scanner: string | undefined;
    try {
      const result = await this.#scanner.scan({ fileName: file.fileName, contentType: file.contentType, bytes });
      status = result.verdict === "clean" ? "clean" : "rejected";
      scanner = result.scanner;
    } catch {
      status = "scan_failed";
    }
    const scannedAt = this.#now().toISOString();
    const updated = await this.#files.setUploadedFileScanStatus({
      tenantId: owner.tenantId,
      ownerId: owner.ownerId,
      botId: owner.botId,
      fileId: file.id,
      status,
      ...(scanner === undefined ? {} : { scanner }),
      scannedAt,
    });
    if (!updated) throw new AppError("CONFLICT", "Uploaded file changed while being scanned.", 409);
    if (status === "rejected") await this.#objects.delete(owner.tenantId, file.id).catch(() => undefined);
    return updated;
  }

  async #requireOwnedBot(input: { readonly tenantId: TenantId; readonly ownerId: UserId; readonly botId: BotId }) {
    const bot = await this.#bots.get(input.tenantId, input.botId);
    if (!bot || bot.ownerId !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    return bot;
  }
}

export function validateFileName(fileName: string): void {
  if (
    typeof fileName !== "string" ||
    fileName.length < 1 ||
    fileName.length > 255 ||
    fileName.trim() !== fileName ||
    hasInvalidPathCharacters(fileName) ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new AppError("VALIDATION_ERROR", "File name is invalid.", 400);
  }
}

function hasInvalidPathCharacters(value: string): boolean {
  if (value.includes("/") || value.includes("\\")) return true;
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

export function normalizeContentType(contentType: string): string {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!SUPPORTED_CONTENT_TYPES.has(normalized)) {
    throw new AppError("UNSUPPORTED_CAPABILITY", "This file type is not supported.", 415);
  }
  return normalized;
}

function validateExtension(fileName: string, contentType: string): void {
  const separator = fileName.lastIndexOf(".");
  if (separator < 0) return;
  const extension = fileName.slice(separator + 1).toLowerCase();
  const expected: Readonly<Record<string, string>> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
  };
  if (expected[extension] !== contentType) {
    throw new AppError("VALIDATION_ERROR", "File name extension does not match its supported content type.", 415);
  }
}

export function validateFileBytes(contentType: string, bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_UPLOADED_FILE_BYTES) {
    throw new AppError("VALIDATION_ERROR", "File size is outside the supported range.", 413);
  }
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const isValid =
    (contentType === "image/jpeg" && starts(0xff, 0xd8, 0xff)) ||
    (contentType === "image/png" && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ||
    (contentType === "image/webp" &&
      bytes.byteLength >= 12 &&
      starts(0x52, 0x49, 0x46, 0x46) &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50) ||
    (contentType === "application/pdf" && starts(0x25, 0x50, 0x44, 0x46, 0x2d)) ||
    (contentType.startsWith("text/") && isUtf8Text(bytes));
  if (!isValid) throw new AppError("VALIDATION_ERROR", "File bytes do not match the declared file type.", 415);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
