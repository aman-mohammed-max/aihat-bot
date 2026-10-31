import { describe, expect, test } from "bun:test";
import { AppError } from "../../packages/core/src/errors.js";
import { DOCX_CONTENT_TYPE } from "../../packages/core/src/document-extraction.js";
import { UploadedDocumentTools } from "../../packages/core/src/uploaded-document-tools.js";
import { HttpMalwareScanner, createOptionalHttpMalwareScanner } from "../../packages/core/src/file-scanner.js";
import type { ApiTokenAuthenticator } from "../../packages/core/src/api-auth.js";
import { UploadedFilesService } from "../../packages/core/src/uploaded-files.js";
import { createUploadedFilesApiHandler } from "../../packages/core/src/uploaded-files-http-api.js";
import type {
  BotRepository,
  MalwareScanner,
  ObjectStore,
  StoredObject,
  UploadedFileRepository,
} from "../../packages/core/src/ports.js";
import type { BotId, TenantId, UploadedFile, UserId } from "../../packages/core/src/types.js";
import type { ToolContext } from "../../packages/core/src/tools.js";
import { createDocx } from "../helpers/document-fixtures.js";

const tenantId = "tenant-files" as TenantId;
const ownerId = "user-files" as UserId;
const otherOwnerId = "user-other" as UserId;
const botId = "bot_00000000-0000-4000-8000-000000000001" as BotId;
const text = new TextEncoder().encode("hello file");

describe("uploaded files", () => {
  test("lets only the owner read bounded, malware-clean dashboard documents in API chats", async () => {
    const fixture = createFixture();
    const bots = createBots();
    const service = createService(fixture, { scan: async () => ({ verdict: "clean", scanner: "test-scanner" }) }, bots);
    const pdfText = "A safe uploaded reference.";
    const file = await service.upload({
      tenantId,
      ownerId,
      botId,
      fileName: "reference.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode(pdfText),
    });
    const docx = createDocx("<w:document><w:body><w:p><w:r><w:t>DOCX handbook</w:t></w:r></w:p></w:body></w:document>");
    const wordFile = await service.upload({
      tenantId,
      ownerId,
      botId,
      fileName: "handbook.docx",
      contentType: DOCX_CONTENT_TYPE,
      bytes: docx,
    });
    const large = await service.upload({
      tenantId,
      ownerId,
      botId,
      fileName: "long.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("x".repeat(20_000)),
    });
    const unicode = await service.upload({
      tenantId,
      ownerId,
      botId,
      fileName: "unicode.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("世".repeat(11_000)),
    });
    for (let index = 0; index < 10; index += 1) {
      await service.upload({
        tenantId,
        ownerId,
        botId,
        fileName: `extra-${index}.txt`,
        contentType: "text/plain",
        bytes: new TextEncoder().encode("extra reference"),
      });
    }
    const tools = new UploadedDocumentTools({ bots, files: service });
    const ownerContext = { tenantId, botId, actorId: ownerId, platform: "api" } as ToolContext;

    expect((await tools.available(ownerContext)).map((tool) => tool.name)).toEqual([
      "list_bot_documents",
      "read_bot_document",
    ]);
    const listed = (await tools.execute(ownerContext, "list_bot_documents", {})) as {
      documents: Array<{ id: string; scanStatus: string }>;
      total: number;
      nextOffset?: number;
    };
    expect(listed.documents).toHaveLength(12);
    expect(listed).toMatchObject({ total: 14, nextOffset: 12 });
    expect(listed.documents.every((item) => item.scanStatus === "clean")).toBe(true);
    const lastPage = (await tools.execute(ownerContext, "list_bot_documents", { offset: 12 })) as {
      documents: Array<{ id: string }>;
      total: number;
      nextOffset?: number;
    };
    expect(lastPage.total).toBe(14);
    expect(lastPage.documents).toHaveLength(2);
    expect(lastPage.nextOffset).toBeUndefined();

    const read = (await tools.execute(ownerContext, "read_bot_document", { fileId: file.id })) as {
      content: string;
      untrustedReferenceData: boolean;
    };
    expect(read).toMatchObject({ content: pdfText, untrustedReferenceData: true });
    const readWord = (await tools.execute(ownerContext, "read_bot_document", { fileId: wordFile.id })) as {
      content: string;
    };
    expect(readWord.content).toContain("DOCX handbook");
    const readLarge = (await tools.execute(ownerContext, "read_bot_document", { fileId: large.id })) as {
      content: string;
    };
    expect(readLarge.content).toContain("truncated at the safe context limit");
    expect(new TextEncoder().encode(JSON.stringify(readLarge)).byteLength).toBeLessThan(16_384);
    const readUnicode = (await tools.execute(ownerContext, "read_bot_document", { fileId: unicode.id })) as {
      content: string;
    };
    expect(readUnicode.content).toContain("世");
    expect(readUnicode.content).toContain("truncated at the safe context limit");
    expect((await tools.promptInstructions(ownerContext)).join("\n")).toContain("untrusted reference data");

    const publicContext = { ...ownerContext, includeOwnerMemory: false };
    expect(await tools.available(publicContext)).toEqual([]);
    expect(await tools.available({ ...ownerContext, platform: "telegram" })).toEqual([]);
    expect(await tools.available({ ...ownerContext, actorId: otherOwnerId })).toEqual([]);
    await expect(tools.execute(publicContext, "read_bot_document", { fileId: file.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      tools.execute(ownerContext, "read_bot_document", { fileId: wordFile.id, other: true }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(tools.execute(ownerContext, "list_bot_documents", { offset: 100 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  test("accepts bounded UTF-8 structured text formats with matching extensions and media types", async () => {
    const fixture = createFixture();
    const service = createService(fixture);
    const samples = [
      { fileName: "settings.json", contentType: "application/json", value: '{"enabled":true}' },
      { fileName: "events.jsonl", contentType: "application/x-ndjson", value: '{"event":1}\n' },
      { fileName: "feed.xml", contentType: "application/xml", value: "<feed />" },
      { fileName: "config.yaml", contentType: "application/yaml", value: "enabled: true\n" },
      { fileName: "table.tsv", contentType: "text/tab-separated-values", value: "name\tcount\nitem\t2" },
      { fileName: "service.log", contentType: "text/plain", value: "service started\n" },
    ];

    for (const sample of samples) {
      const file = await service.upload({
        tenantId,
        ownerId,
        botId,
        fileName: sample.fileName,
        contentType: sample.contentType,
        bytes: new TextEncoder().encode(sample.value),
      });
      expect(file).toMatchObject({
        fileName: sample.fileName,
        contentType: sample.contentType,
        scanStatus: "pending_scan",
      });
    }

    await expect(
      service.upload({
        tenantId,
        ownerId,
        botId,
        fileName: "settings.json",
        contentType: "text/plain",
        bytes: new TextEncoder().encode('{"enabled":true}'),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 415 });
  });

  test("keeps uploads quarantined without a scanner and scopes access to the bot owner", async () => {
    const fixture = createFixture();
    const service = createService(fixture);
    const file = await service.upload({
      tenantId,
      ownerId,
      botId,
      fileName: "notes.txt",
      contentType: "text/plain",
      bytes: text,
    });

    expect(file.scanStatus).toBe("pending_scan");
    expect(await service.list({ tenantId, ownerId, botId })).toEqual([file]);
    await expect(service.getContent({ tenantId, ownerId, botId, fileId: file.id })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
    await expect(service.list({ tenantId, ownerId: otherOwnerId, botId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(
      service.upload({ tenantId, ownerId, botId, fileName: "../notes.txt", contentType: "text/plain", bytes: text }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      service.upload({ tenantId, ownerId, botId, fileName: "picture.png", contentType: "image/png", bytes: text }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    const authenticator = {
      authenticate: async () => ({
        tenantId,
        ownerId,
        tokenId: "file-test-token",
        scopes: ["bots:read", "bots:write"],
      }),
    } as unknown as ApiTokenAuthenticator;
    const handler = createUploadedFilesApiHandler(authenticator, service);
    const listed = await handler(new Request(`https://factory.example.test/v1/bots/${botId}/files`));
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toMatchObject({ items: [{ id: file.id, scanStatus: "pending_scan" }] });
    const download = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/files/${file.id}/content`),
    );
    expect(download?.status).toBe(409);
  });

  test("makes clean files downloadable, rejects infected files, and permits retry after scanner failure", async () => {
    const fixture = createFixture();
    let verdict: "clean" | "infected" = "clean";
    let fail = false;
    const scanner: MalwareScanner = {
      scan: async () => {
        if (fail) throw new Error("scanner unavailable");
        return { verdict, scanner: "test-scanner" };
      },
    };
    const service = createService(fixture, scanner);
    const clean = await service.upload({
      tenantId,
      ownerId,
      botId,
      fileName: "notes.txt",
      contentType: "text/plain",
      bytes: text,
    });
    expect(clean.scanStatus).toBe("clean");
    const content = await service.getContent({ tenantId, ownerId, botId, fileId: clean.id });
    expect(await new Response(content.body).text()).toBe("hello file");

    verdict = "infected";
    const infected = await service.upload({
      tenantId,
      ownerId,
      botId,
      fileName: "bad.txt",
      contentType: "text/plain",
      bytes: text,
    });
    expect(infected.scanStatus).toBe("rejected");
    expect(await fixture.objects.get(tenantId, infected.id)).toBeUndefined();
    await expect(service.getContent({ tenantId, ownerId, botId, fileId: infected.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    fail = true;
    const failed = await service.upload({
      tenantId,
      ownerId,
      botId,
      fileName: "retry.txt",
      contentType: "text/plain",
      bytes: text,
    });
    expect(failed.scanStatus).toBe("scan_failed");
    fail = false;
    verdict = "clean";
    expect((await service.scan({ tenantId, ownerId, botId, fileId: failed.id })).scanStatus).toBe("clean");
  });

  test("scanner sends bytes only to its approved HTTPS origin and bounds responses", async () => {
    let received: Request | undefined;
    const scanner = new HttpMalwareScanner({
      endpoint: "https://scanner.example.test/v1/scan",
      token: "scanner-secret-long-enough",
      allowedOrigins: new Set(["https://scanner.example.test"]),
      fetch: async (input, init) => {
        received = input instanceof Request ? input : new Request(input, init);
        return Response.json({ verdict: "clean", scanner: "Clam AV" });
      },
    });
    expect(await scanner.scan({ fileName: "notes.txt", contentType: "text/plain", bytes: text })).toEqual({
      verdict: "clean",
      scanner: "Clam AV",
    });
    expect(received?.headers.get("authorization")).toBe("Bearer scanner-secret-long-enough");
    expect(received?.headers.get("x-file-name-encoded")).toBe("notes.txt");
    const capturedRequest = received;
    if (!capturedRequest) throw new Error("Scanner request was not captured.");
    expect(new Uint8Array(await capturedRequest.arrayBuffer())).toEqual(text);

    expect(() =>
      createOptionalHttpMalwareScanner({
        endpoint: "http://scanner.example.test/scan",
        token: "scanner-secret-long-enough",
        allowedOrigins: new Set(["http://scanner.example.test"]),
      }),
    ).toThrow(AppError);
    const oversized = new HttpMalwareScanner({
      endpoint: "https://scanner.example.test/v1/scan",
      token: "scanner-secret-long-enough",
      allowedOrigins: new Set(["https://scanner.example.test"]),
      fetch: async () => new Response("x".repeat(4_097)),
    });
    await expect(
      oversized.scan({ fileName: "notes.txt", contentType: "text/plain", bytes: text }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
  });

  test("treats redirects and scanner errors as unavailable without leaking its token", async () => {
    let redirectMode = "";
    const scanner = new HttpMalwareScanner({
      endpoint: "https://scanner.example.test/v1/scan",
      token: "scanner-secret-long-enough",
      allowedOrigins: new Set(["https://scanner.example.test"]),
      fetch: async (_input, init) => {
        redirectMode = String(init?.redirect);
        return new Response("scanner failure", {
          status: 302,
          headers: { location: "https://attacker.example.test/" },
        });
      },
    });
    await expect(scanner.scan({ fileName: "notes.txt", contentType: "text/plain", bytes: text })).rejects.toMatchObject(
      {
        code: "DEPENDENCY_UNAVAILABLE",
      },
    );
    expect(redirectMode).toBe("error");
    try {
      await scanner.scan({ fileName: "notes.txt", contentType: "text/plain", bytes: text });
    } catch (error) {
      expect(String(error)).not.toContain("scanner-secret-long-enough");
    }
  });
});

interface Fixture {
  readonly repository: UploadedFileRepository;
  readonly objects: ObjectStore;
}

function createFixture(): Fixture {
  const rows = new Map<string, { file: UploadedFile; tenantId: TenantId; ownerId: UserId }>();
  const objects = new Map<string, StoredObject>();
  const key = (tenant: TenantId, bot: BotId, id: string) => `${tenant}:${bot}:${id}`;
  const repository: UploadedFileRepository = {
    getUploadedFileUsage: async ({ tenantId: tenant, botId: bot }) => {
      const owned = [...rows.values()].filter((row) => row.tenantId === tenant && row.file.botId === bot);
      return { files: owned.length, bytes: owned.reduce((total, row) => total + row.file.size, 0) };
    },
    createUploadedFile: async ({ file, tenantId: tenant, ownerId: owner }) => {
      rows.set(key(tenant, file.botId, file.id), { file, tenantId: tenant, ownerId: owner });
    },
    getOwnedUploadedFile: async ({ tenantId: tenant, ownerId: owner, botId: bot, fileId }) => {
      const row = rows.get(key(tenant, bot, fileId));
      return row?.tenantId === tenant && row.ownerId === owner ? row.file : undefined;
    },
    listOwnedUploadedFiles: async ({ tenantId: tenant, ownerId: owner, botId: bot }) =>
      [...rows.values()]
        .filter((row) => row.tenantId === tenant && row.ownerId === owner && row.file.botId === bot)
        .map((row) => row.file),
    setUploadedFileScanStatus: async ({
      tenantId: tenant,
      ownerId: owner,
      botId: bot,
      fileId,
      status,
      scanner,
      scannedAt,
    }) => {
      const mapKey = key(tenant, bot, fileId);
      const row = rows.get(mapKey);
      if (!row || row.tenantId !== tenant || row.ownerId !== owner) return undefined;
      const file = {
        ...row.file,
        scanStatus: status,
        updatedAt: scannedAt,
        scannedAt,
        ...(scanner ? { scanner } : {}),
      };
      rows.set(mapKey, { ...row, file });
      return file;
    },
    deleteOwnedUploadedFile: async ({ tenantId: tenant, ownerId: owner, botId: bot, fileId }) => {
      const mapKey = key(tenant, bot, fileId);
      const row = rows.get(mapKey);
      if (!row || row.tenantId !== tenant || row.ownerId !== owner) return false;
      rows.delete(mapKey);
      return true;
    },
  };
  const store: ObjectStore = {
    put: async ({ tenantId: tenant, objectId, contentType, bytes }) => {
      const createdAt = new Date().toISOString();
      const item: StoredObject = {
        tenantId: tenant,
        objectId,
        contentType,
        size: bytes.byteLength,
        etag: `etag-${objectId}`,
        createdAt,
        bytes: bytes.slice(),
      };
      objects.set(`${tenant}:${objectId}`, item);
      return item;
    },
    get: async (tenant, objectId) => objects.get(`${tenant}:${objectId}`),
    putStream: async ({ tenantId: tenant, objectId, contentType, body }) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      return store.put({ tenantId: tenant, objectId, contentType, bytes });
    },
    getStream: async (tenant, objectId) => {
      const stored = objects.get(`${tenant}:${objectId}`);
      if (!stored) return undefined;
      const body = new Blob([stored.bytes.slice().buffer as ArrayBuffer]).stream();
      return { ...stored, body };
    },
    delete: async (tenant, objectId) => void objects.delete(`${tenant}:${objectId}`),
  };
  return { repository, objects: store };
}

function createBots(): BotRepository {
  return {
    get: async (tenant: TenantId, id: BotId) =>
      tenant === tenantId && id === botId ? ({ id, tenantId, ownerId } as never) : undefined,
  } as unknown as BotRepository;
}

function createService(fixture: Fixture, scanner?: MalwareScanner, bots = createBots()): UploadedFilesService {
  return new UploadedFilesService({
    bots,
    files: fixture.repository,
    objects: fixture.objects,
    runtime: "bun",
    ...(scanner ? { scanner } : {}),
    now: () => new Date("2026-10-31T00:00:00.000Z"),
  });
}
