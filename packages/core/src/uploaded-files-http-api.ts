import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import { MAX_UPLOADED_FILE_BYTES, type UploadedFilesService, validateFileName } from "./uploaded-files.js";
import type { BotId } from "./types.js";

const BOT = "(bot_[a-f0-9-]{36})";
const FILE = "(file_[a-f0-9]{32})";
const COLLECTION_ROUTE = new RegExp(`^/v1/bots/${BOT}/files$`);
const ITEM_ROUTE = new RegExp(`^/v1/bots/${BOT}/files/${FILE}$`);
const CONTENT_ROUTE = new RegExp(`^/v1/bots/${BOT}/files/${FILE}/content$`);
const SCAN_ROUTE = new RegExp(`^/v1/bots/${BOT}/files/${FILE}/scan$`);

export function createUploadedFilesApiHandler(
  authenticator: ApiTokenAuthenticator,
  service: UploadedFilesService,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const collection = COLLECTION_ROUTE.exec(url.pathname);
    const item = ITEM_ROUTE.exec(url.pathname);
    const content = CONTENT_ROUTE.exec(url.pathname);
    const scan = SCAN_ROUTE.exec(url.pathname);
    if (!collection && !item && !content && !scan) return undefined;
    try {
      const principal = await authenticator.authenticate(request);
      const botId = (collection?.[1] ?? item?.[1] ?? content?.[1] ?? scan?.[1]) as BotId;
      if (collection && request.method === "GET") {
        await requireApiScope(principal, "bots:read");
        const items = await service.list({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
        });
        return Response.json({ items }, noStore);
      }
      if (collection && request.method === "POST") {
        await requireApiScope(principal, "bots:write");
        const fileName = decodeFileName(request.headers.get("x-file-name-encoded"));
        const contentType = request.headers.get("content-type") ?? "";
        const bytes = await readUploadBytes(request);
        const file = await service.upload({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          fileName,
          contentType,
          bytes,
        });
        return Response.json({ file }, { ...noStore, status: file.scanStatus === "clean" ? 201 : 202 });
      }
      if (content && request.method === "GET") {
        await requireApiScope(principal, "bots:read");
        const result = await service.getContent({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          fileId: content[2] ?? "",
        });
        return new Response(result.body, {
          headers: {
            ...noStore.headers,
            "content-type": result.file.contentType,
            "content-length": String(result.file.size),
            "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(result.file.fileName)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (scan && request.method === "POST") {
        await requireApiScope(principal, "bots:write");
        const file = await service.scan({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          fileId: scan[2] ?? "",
        });
        return Response.json({ file }, { ...noStore, status: 200 });
      }
      if (item && request.method === "GET") {
        await requireApiScope(principal, "bots:read");
        const file = await service.get({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          fileId: item[2] ?? "",
        });
        return Response.json({ file }, noStore);
      }
      if (item && request.method === "DELETE") {
        await requireApiScope(principal, "bots:write");
        await service.delete({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          fileId: item[2] ?? "",
        });
        return new Response(null, { status: 204, headers: noStore.headers });
      }
      return methodNotAllowed(collection ? "GET, POST" : content || item ? "GET, DELETE" : "POST");
    } catch (cause) {
      if (cause instanceof AppError) {
        await recordApiAuthorizationDenial(request, cause);
        return Response.json(
          { error: cause.code, message: cause.message },
          {
            status: cause.status,
            headers: { ...noStore.headers, ...(cause.status === 401 ? { "www-authenticate": "Bearer" } : {}) },
          },
        );
      }
      return Response.json(
        { error: "INTERNAL_ERROR", message: "The request could not be completed." },
        { status: 500, headers: noStore.headers },
      );
    }
  };
}

function decodeFileName(header: string | null): string {
  if (!header || header.length > 1_024) throw new AppError("VALIDATION_ERROR", "File name is required.", 400);
  let fileName: string;
  try {
    fileName = decodeURIComponent(header);
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "File name encoding is invalid.", 400, { cause });
  }
  validateFileName(fileName);
  return fileName;
}

async function readUploadBytes(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) < 1 || Number(declared) > MAX_UPLOADED_FILE_BYTES)
  ) {
    throw new AppError("VALIDATION_ERROR", "File size is outside the supported range.", 413);
  }
  if (!request.body) throw new AppError("VALIDATION_ERROR", "File data is required.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOADED_FILE_BYTES) {
        await reader.cancel();
        throw new AppError("VALIDATION_ERROR", "File size is outside the supported range.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== size) {
    throw new AppError("VALIDATION_ERROR", "File size does not match its content length.", 400);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { ...noStore.headers, allow } },
  );
}

const noStore = { headers: { "cache-control": "no-store" } } as const;
