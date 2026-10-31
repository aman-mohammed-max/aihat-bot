import type { Database } from "bun:sqlite";
import { AppError } from "@aihat/core";
import type { UploadedFileRepository, TenantId, UserId, BotId, UploadedFile } from "@aihat/core";

interface UploadedFileRow {
  id: string;
  bot_id: string;
  file_name: string;
  content_type: string;
  size: number;
  etag: string;
  scan_status: UploadedFile["scanStatus"];
  scanner: string | null;
  scanned_at: string | null;
  created_at: string;
  updated_at: string;
}

export class BunSqliteUploadedFileRepository implements UploadedFileRepository {
  constructor(private readonly db: Database) {}

  async getOwnedUploadedFileUsage(input: { tenantId: TenantId; ownerId: UserId; botId: BotId }) {
    const row = this.db
      .query<{ files: number; bytes: number }, [string, string, string]>(`
        SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes FROM bot_files
        WHERE tenant_id = ? AND owner_id = ? AND bot_id = ?
      `)
      .get(input.tenantId, input.ownerId, input.botId);
    return { files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
  }

  async createUploadedFile(input: { file: UploadedFile; tenantId: TenantId; ownerId: UserId }): Promise<void> {
    try {
      this.db
        .query(`
          INSERT INTO bot_files (
            id, tenant_id, bot_id, owner_id, file_name, content_type, size, etag,
            scan_status, scanner, scanned_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.file.id,
          input.tenantId,
          input.file.botId,
          input.ownerId,
          input.file.fileName,
          input.file.contentType,
          input.file.size,
          input.file.etag,
          input.file.scanStatus,
          input.file.scanner ?? null,
          input.file.scannedAt ?? null,
          input.file.createdAt,
          input.file.updatedAt,
        );
    } catch (cause) {
      throw new AppError("CONFLICT", "Uploaded file metadata could not be saved.", 409, { cause });
    }
  }

  async getOwnedUploadedFile(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    fileId: string;
  }): Promise<UploadedFile | undefined> {
    const row = this.db
      .query<UploadedFileRow, [string, string, string, string]>(`
        SELECT id, bot_id, file_name, content_type, size, etag, scan_status, scanner, scanned_at, created_at, updated_at
        FROM bot_files WHERE tenant_id = ? AND owner_id = ? AND bot_id = ? AND id = ?
      `)
      .get(input.tenantId, input.ownerId, input.botId, input.fileId);
    return row ? mapUploadedFile(row) : undefined;
  }

  async listOwnedUploadedFiles(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    limit: number;
  }): Promise<readonly UploadedFile[]> {
    validateLimit(input.limit);
    const rows = this.db
      .query<UploadedFileRow, [string, string, string, number]>(`
        SELECT id, bot_id, file_name, content_type, size, etag, scan_status, scanner, scanned_at, created_at, updated_at
        FROM bot_files WHERE tenant_id = ? AND owner_id = ? AND bot_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?
      `)
      .all(input.tenantId, input.ownerId, input.botId, input.limit);
    return rows.map(mapUploadedFile);
  }

  async setUploadedFileScanStatus(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    fileId: string;
    status: UploadedFile["scanStatus"];
    scanner?: string;
    scannedAt: string;
  }): Promise<UploadedFile | undefined> {
    const row = this.db
      .query<UploadedFileRow, [string, string | null, string, string, string, string, string, string]>(`
        UPDATE bot_files SET scan_status = ?, scanner = ?, scanned_at = ?, updated_at = ?
        WHERE tenant_id = ? AND owner_id = ? AND bot_id = ? AND id = ?
        RETURNING id, bot_id, file_name, content_type, size, etag, scan_status, scanner, scanned_at, created_at, updated_at
      `)
      .get(
        input.status,
        input.scanner ?? null,
        input.scannedAt,
        input.scannedAt,
        input.tenantId,
        input.ownerId,
        input.botId,
        input.fileId,
      );
    return row ? mapUploadedFile(row) : undefined;
  }

  async deleteOwnedUploadedFile(input: {
    tenantId: TenantId;
    ownerId: UserId;
    botId: BotId;
    fileId: string;
  }): Promise<boolean> {
    const result = this.db
      .query(`DELETE FROM bot_files WHERE tenant_id = ? AND owner_id = ? AND bot_id = ? AND id = ?`)
      .run(input.tenantId, input.ownerId, input.botId, input.fileId);
    return result.changes === 1;
  }
}

function mapUploadedFile(row: UploadedFileRow): UploadedFile {
  return {
    id: row.id,
    botId: row.bot_id as BotId,
    fileName: row.file_name,
    contentType: row.content_type,
    size: row.size,
    etag: row.etag,
    scanStatus: row.scan_status,
    ...(row.scanner === null ? {} : { scanner: row.scanner }),
    ...(row.scanned_at === null ? {} : { scannedAt: row.scanned_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("VALIDATION_ERROR", "Uploaded file page size is invalid.", 400);
  }
}
