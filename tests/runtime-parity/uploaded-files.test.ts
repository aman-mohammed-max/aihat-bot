import { describe, expect, test } from "bun:test";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import { BunSqliteUploadedFileRepository } from "../../apps/bun-runtime/src/uploaded-file-repository.js";
import { CloudflareD1Repositories } from "../../apps/cloudflare-runtime/src/d1-repositories.js";
import { CloudflareD1UploadedFileRepository } from "../../apps/cloudflare-runtime/src/uploaded-file-repository.js";
import { UploadedDocumentTools } from "../../packages/core/src/uploaded-document-tools.js";
import { UploadedFilesService } from "../../packages/core/src/uploaded-files.js";
import type { ObjectStore, StoredObject } from "../../packages/core/src/ports.js";
import type { BotId, TenantId, UploadedFile, UserId } from "../../packages/core/src/types.js";
import { SqliteD1 } from "../helpers/sqlite-d1.js";

describe("uploaded file metadata runtime parity", () => {
  test("Bun and Cloudflare agent tools expose the same owner-scoped clean document content", async () => {
    const bunDb = openSqliteDatabase(":memory:");
    const d1Db = openSqliteDatabase(":memory:");
    const tenantId = "tenant-document-parity" as TenantId;
    const ownerId = "user-document-parity" as UserId;
    const botId = "bot_00000000-0000-4000-8000-000000000001" as BotId;
    const now = "2026-10-31T00:00:00.000Z";
    try {
      seed(bunDb, tenantId, ownerId, botId, now);
      seed(d1Db, tenantId, ownerId, botId, now);
      const bunRepositories = new BunSqliteRepositories(bunDb);
      const d1 = new SqliteD1(d1Db) as unknown as D1Database;
      const cloudflareRepositories = new CloudflareD1Repositories(d1);
      const bunService = new UploadedFilesService({
        bots: bunRepositories,
        files: new BunSqliteUploadedFileRepository(bunDb),
        objects: createMemoryObjectStore(),
        scanner: { scan: async () => ({ verdict: "clean", scanner: "test-scanner" }) },
        runtime: "bun",
      });
      const cloudflareService = new UploadedFilesService({
        bots: cloudflareRepositories,
        files: new CloudflareD1UploadedFileRepository(d1),
        objects: createMemoryObjectStore(),
        scanner: { scan: async () => ({ verdict: "clean", scanner: "test-scanner" }) },
        runtime: "cloudflare",
      });
      const content = "Shared owner knowledge for both runtimes.";
      const upload = {
        tenantId,
        ownerId,
        botId,
        fileName: "notes.txt",
        contentType: "text/plain",
        bytes: new TextEncoder().encode(content),
      };
      const [bunFile, d1File] = await Promise.all([bunService.upload(upload), cloudflareService.upload(upload)]);
      const bunTools = new UploadedDocumentTools({ bots: bunRepositories, files: bunService });
      const d1Tools = new UploadedDocumentTools({ bots: cloudflareRepositories, files: cloudflareService });
      const context = { tenantId, botId, actorId: ownerId, platform: "api" as const };
      expect(await d1Tools.available(context)).toEqual(await bunTools.available(context));
      const [bunList, d1List] = await Promise.all([
        bunTools.execute(context, "list_bot_documents", {}),
        d1Tools.execute(context, "list_bot_documents", {}),
      ]);
      expect(normalizeListedDocuments(d1List)).toEqual(normalizeListedDocuments(bunList));
      const [bunContent, d1Content] = await Promise.all([
        bunTools.execute(context, "read_bot_document", { fileId: bunFile.id }),
        d1Tools.execute(context, "read_bot_document", { fileId: d1File.id }),
      ]);
      expect(d1Content).toEqual(bunContent);
      expect(d1Content).toMatchObject({ content, untrustedReferenceData: true });
    } finally {
      bunDb.close();
      d1Db.close();
    }
  });

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

function createMemoryObjectStore(): ObjectStore {
  const objects = new Map<string, StoredObject>();
  const key = (tenantId: TenantId, objectId: string) => `${tenantId}:${objectId}`;
  const store: ObjectStore = {
    put: async ({ tenantId, objectId, contentType, bytes }) => {
      const object: StoredObject = {
        tenantId,
        objectId,
        contentType,
        size: bytes.byteLength,
        etag: `etag-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        bytes: bytes.slice(),
      };
      objects.set(key(tenantId, objectId), object);
      return object;
    },
    get: async (tenantId, objectId) => objects.get(key(tenantId, objectId)),
    putStream: async ({ tenantId, objectId, contentType, body }) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      return store.put({ tenantId, objectId, contentType, bytes });
    },
    getStream: async (tenantId, objectId) => {
      const object = objects.get(key(tenantId, objectId));
      return object ? { ...object, body: new Blob([object.bytes.slice().buffer as ArrayBuffer]).stream() } : undefined;
    },
    delete: async (tenantId, objectId) => void objects.delete(key(tenantId, objectId)),
  };
  return store;
}

function normalizeListedDocuments(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("documents" in value) || !Array.isArray(value.documents)) return value;
  return {
    documents: value.documents.map((entry: Record<string, unknown>) => {
      const { id: _id, ...document } = entry;
      return document;
    }),
  };
}

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
  db.query(`INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
    VALUES (?, ?, 1, ?, ?, ?)`).run(
    botId,
    tenantId,
    JSON.stringify({ systemPrompt: "You are a file parity test bot.", model: { providerId: "test", model: "test" } }),
    ownerId,
    now,
  );
}
