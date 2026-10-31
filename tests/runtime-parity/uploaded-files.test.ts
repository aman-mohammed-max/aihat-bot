import { describe, expect, test } from "bun:test";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteUploadedFileRepository } from "../../apps/bun-runtime/src/uploaded-file-repository.js";
import { CloudflareD1UploadedFileRepository } from "../../apps/cloudflare-runtime/src/uploaded-file-repository.js";
import type { UploadedFile } from "../../packages/core/src/types.js";
import { SqliteD1 } from "../helpers/sqlite-d1.js";

describe("uploaded file metadata runtime parity", () => {
  test("Bun SQLite and D1 implement owner-scoped create, scan, list, usage, and delete consistently", async () => {
    const bunDb = openSqliteDatabase(":memory:");
    const d1Db = openSqliteDatabase(":memory:");
    const bun = new BunSqliteUploadedFileRepository(bunDb);
    const d1 = new CloudflareD1UploadedFileRepository(new SqliteD1(d1Db) as unknown as D1Database);
    const tenantId = "tenant-file-parity";
    const ownerId = "user-file-parity";
    const botId = "bot_00000000-0000-4000-8000-000000000001";
    const now = "2026-10-31T00:00:00.000Z";
    try {
      seed(bunDb, tenantId, ownerId, botId, now);
      seed(d1Db, tenantId, ownerId, botId, now);
      const file: UploadedFile = {
        id: `file_${"a".repeat(32)}`,
        botId: botId as UploadedFile["botId"],
        fileName: "reference.txt",
        contentType: "text/plain",
        size: 12,
        etag: "etag-test-file",
        scanStatus: "pending_scan",
        createdAt: now,
        updatedAt: now,
      };
      await Promise.all([
        bun.createUploadedFile({ file, tenantId: tenantId as never, ownerId: ownerId as never }),
        d1.createUploadedFile({ file, tenantId: tenantId as never, ownerId: ownerId as never }),
      ]);
      const [bunFile, d1File, bunUsage, d1Usage, bunList, d1List] = await Promise.all([
        bun.getOwnedUploadedFile({
          tenantId: tenantId as never,
          ownerId: ownerId as never,
          botId: botId as never,
          fileId: file.id,
        }),
        d1.getOwnedUploadedFile({
          tenantId: tenantId as never,
          ownerId: ownerId as never,
          botId: botId as never,
          fileId: file.id,
        }),
        bun.getOwnedUploadedFileUsage({
          tenantId: tenantId as never,
          ownerId: ownerId as never,
          botId: botId as never,
        }),
        d1.getOwnedUploadedFileUsage({ tenantId: tenantId as never, ownerId: ownerId as never, botId: botId as never }),
        bun.listOwnedUploadedFiles({
          tenantId: tenantId as never,
          ownerId: ownerId as never,
          botId: botId as never,
          limit: 100,
        }),
        d1.listOwnedUploadedFiles({
          tenantId: tenantId as never,
          ownerId: ownerId as never,
          botId: botId as never,
          limit: 100,
        }),
      ]);
      expect(d1File).toEqual(bunFile);
      expect(d1Usage).toEqual(bunUsage);
      expect(d1List).toEqual(bunList);
      expect(bunUsage).toEqual({ files: 1, bytes: 12 });
      expect(
        await bun.getOwnedUploadedFile({
          tenantId: tenantId as never,
          ownerId: "other" as never,
          botId: botId as never,
          fileId: file.id,
        }),
      ).toBeUndefined();
      expect(
        await d1.getOwnedUploadedFile({
          tenantId: tenantId as never,
          ownerId: "other" as never,
          botId: botId as never,
          fileId: file.id,
        }),
      ).toBeUndefined();

      const scan = {
        tenantId: tenantId as never,
        ownerId: ownerId as never,
        botId: botId as never,
        fileId: file.id,
        status: "clean" as const,
        scanner: "test-av",
        scannedAt: "2026-10-31T00:01:00.000Z",
      };
      const [bunScanned, d1Scanned] = await Promise.all([
        bun.setUploadedFileScanStatus(scan),
        d1.setUploadedFileScanStatus(scan),
      ]);
      expect(d1Scanned).toEqual(bunScanned);
      expect(bunScanned).toMatchObject({ scanStatus: "clean", scanner: "test-av", scannedAt: scan.scannedAt });
      const [bunDeleted, d1Deleted] = await Promise.all([
        bun.deleteOwnedUploadedFile({
          tenantId: tenantId as never,
          ownerId: ownerId as never,
          botId: botId as never,
          fileId: file.id,
        }),
        d1.deleteOwnedUploadedFile({
          tenantId: tenantId as never,
          ownerId: ownerId as never,
          botId: botId as never,
          fileId: file.id,
        }),
      ]);
      expect(d1Deleted).toBe(bunDeleted);
      expect(bunDeleted).toBe(true);
      expect(
        await bun.getOwnedUploadedFileUsage({
          tenantId: tenantId as never,
          ownerId: ownerId as never,
          botId: botId as never,
        }),
      ).toEqual({ files: 0, bytes: 0 });
      expect(
        await d1.getOwnedUploadedFileUsage({
          tenantId: tenantId as never,
          ownerId: ownerId as never,
          botId: botId as never,
        }),
      ).toEqual({ files: 0, bytes: 0 });
    } finally {
      bunDb.close();
      d1Db.close();
    }
  });
});

function seed(
  db: ReturnType<typeof openSqliteDatabase>,
  tenantId: string,
  ownerId: string,
  botId: string,
  now: string,
): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)").run(tenantId, "File parity", now);
  db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, ?, ?, ?)").run(
    ownerId,
    "file-test",
    ownerId,
    now,
  );
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    tenantId,
    ownerId,
    now,
  );
  db.query(`INSERT INTO bots (id, tenant_id, owner_id, name, description, status, visibility, current_version, creation_key, created_at, updated_at)
    VALUES (?, ?, ?, 'File bot', '', 'draft', 'private', 1, 'file-parity', ?, ?)`).run(
    botId,
    tenantId,
    ownerId,
    now,
    now,
  );
}
