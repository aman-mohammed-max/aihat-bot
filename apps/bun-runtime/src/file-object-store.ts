import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { join } from "node:path";
import { AppError } from "@aihat/core";
import type { ObjectStore, StoredObject, StoredObjectMetadata, StoredObjectStream, TenantId } from "@aihat/core";

const MAX_OBJECT_SIZE = 25 * 1024 * 1024;
const MAGIC = new Uint8Array([0x41, 0x49, 0x48, 0x41, 0x54, 0x4f, 0x42, 0x4a]);
const HEADER_SIZE = MAGIC.byteLength + 4;

/** Private, atomic file-backed storage for self-hosted Bun installations. */
export class BunFileObjectStore implements ObjectStore {
  readonly #root: string;
  #ready: Promise<void> | undefined;

  constructor(root: string) {
    this.#root = root;
  }

  async initialize(): Promise<void> {
    await this.#ensureRoot();
  }

  async put(input: {
    readonly tenantId: TenantId;
    readonly objectId: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<StoredObjectMetadata> {
    await this.#ensureRoot();
    validateObjectRef(input.tenantId, input.objectId);
    validateContent(input.contentType, input.bytes);
    const directory = join(this.#root, input.tenantId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new AppError("INTERNAL_ERROR", "Tenant object storage directory is unsafe.", 500);
    }
    await chmod(directory, 0o700);

    const createdAt = new Date().toISOString();
    const etag = await sha256(input.bytes);
    const metadata: Omit<StoredObjectMetadata, "tenantId" | "objectId"> = {
      contentType: input.contentType,
      size: input.bytes.byteLength,
      etag,
      createdAt,
    };
    const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
    const output = new Uint8Array(HEADER_SIZE + encodedMetadata.byteLength + input.bytes.byteLength);
    output.set(MAGIC, 0);
    new DataView(output.buffer).setUint32(MAGIC.byteLength, encodedMetadata.byteLength, false);
    output.set(encodedMetadata, HEADER_SIZE);
    output.set(input.bytes, HEADER_SIZE + encodedMetadata.byteLength);

    const path = this.#path(input.tenantId, input.objectId);
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(output);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } catch (cause) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new AppError("INTERNAL_ERROR", "Object could not be committed to local storage.", 500, { cause });
    }
    return { tenantId: input.tenantId, objectId: input.objectId, ...metadata };
  }

  async get(tenantId: TenantId, objectId: string): Promise<StoredObject | undefined> {
    await this.#ensureRoot();
    validateObjectRef(tenantId, objectId);
    const path = this.#path(tenantId, objectId);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AppError("INTERNAL_ERROR", "Stored object is not a regular file.", 500);
    }
    if (info.size < HEADER_SIZE || info.size > HEADER_SIZE + MAX_OBJECT_SIZE + 4096) {
      throw new AppError("INTERNAL_ERROR", "Stored object has an invalid size.", 500);
    }
    const encoded = await readFile(path);
    if (!MAGIC.every((byte, index) => encoded[index] === byte)) {
      throw new AppError("INTERNAL_ERROR", "Stored object header is invalid.", 500);
    }
    const metadataLength = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(
      MAGIC.byteLength,
      false,
    );
    if (metadataLength > 4096 || HEADER_SIZE + metadataLength > encoded.byteLength) {
      throw new AppError("INTERNAL_ERROR", "Stored object metadata is invalid.", 500);
    }
    let metadata: Omit<StoredObjectMetadata, "tenantId" | "objectId">;
    try {
      metadata = JSON.parse(
        new TextDecoder().decode(encoded.subarray(HEADER_SIZE, HEADER_SIZE + metadataLength)),
      ) as Omit<StoredObjectMetadata, "tenantId" | "objectId">;
    } catch (cause) {
      throw new AppError("INTERNAL_ERROR", "Stored object metadata could not be read.", 500, { cause });
    }
    const bytes = encoded.slice(HEADER_SIZE + metadataLength);
    if (
      typeof metadata.contentType !== "string" ||
      !Number.isSafeInteger(metadata.size) ||
      !/^[a-f0-9]{64}$/.test(metadata.etag) ||
      typeof metadata.createdAt !== "string" ||
      !Number.isFinite(Date.parse(metadata.createdAt)) ||
      bytes.byteLength !== metadata.size ||
      (await sha256(bytes)) !== metadata.etag
    ) {
      throw new AppError("INTERNAL_ERROR", "Stored object checksum validation failed.", 500);
    }
    if (!validContentType(metadata.contentType) || bytes.byteLength > MAX_OBJECT_SIZE) {
      throw new AppError("INTERNAL_ERROR", "Stored object metadata is invalid.", 500);
    }
    return { tenantId, objectId, ...metadata, bytes };
  }

  async putStream(input: {
    readonly tenantId: TenantId;
    readonly objectId: string;
    readonly contentType: string;
    readonly size: number;
    readonly body: ReadableStream<Uint8Array>;
  }): Promise<StoredObjectMetadata> {
    await this.#ensureRoot();
    validateObjectRef(input.tenantId, input.objectId);
    validateContentType(input.contentType);
    validateObjectSize(input.size);
    const directory = join(this.#root, input.tenantId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new AppError("INTERNAL_ERROR", "Tenant object storage directory is unsafe.", 500);
    }
    await chmod(directory, 0o700);

    const createdAt = new Date().toISOString();
    const placeholder: Omit<StoredObjectMetadata, "tenantId" | "objectId"> = {
      contentType: input.contentType,
      size: input.size,
      etag: "0".repeat(64),
      createdAt,
    };
    const placeholderBytes = new TextEncoder().encode(JSON.stringify(placeholder));
    const prefix = new Uint8Array(HEADER_SIZE + placeholderBytes.byteLength);
    prefix.set(MAGIC, 0);
    new DataView(prefix.buffer).setUint32(MAGIC.byteLength, placeholderBytes.byteLength, false);
    prefix.set(placeholderBytes, HEADER_SIZE);

    const path = this.#path(input.tenantId, input.objectId);
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(temporaryPath, "wx", 0o600);
      await writeAll(file, prefix, 0);
      const reader = input.body.getReader();
      const hash = createHash("sha256");
      let size = 0;
      let position = prefix.byteLength;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array)) {
            throw new AppError("VALIDATION_ERROR", "Object stream contains a non-binary chunk.", 400);
          }
          size += value.byteLength;
          if (size > input.size || size > MAX_OBJECT_SIZE) {
            throw new AppError("VALIDATION_ERROR", "Object stream exceeds its declared size.", 413);
          }
          hash.update(value);
          await writeAll(file, value, position);
          position += value.byteLength;
        }
      } catch (cause) {
        await reader.cancel(cause).catch(() => undefined);
        throw cause;
      } finally {
        reader.releaseLock();
      }
      if (size !== input.size) {
        throw new AppError("VALIDATION_ERROR", "Object stream size does not match its declaration.", 400);
      }
      const metadata: Omit<StoredObjectMetadata, "tenantId" | "objectId"> = {
        ...placeholder,
        etag: hash.digest("hex"),
      };
      const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
      if (metadataBytes.byteLength !== placeholderBytes.byteLength) {
        throw new AppError("INTERNAL_ERROR", "Object stream metadata size changed unexpectedly.", 500);
      }
      await writeAll(file, metadataBytes, HEADER_SIZE);
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
      return { tenantId: input.tenantId, objectId: input.objectId, ...metadata };
    } catch (cause) {
      await file?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (cause instanceof AppError) throw cause;
      throw new AppError("INTERNAL_ERROR", "Object stream could not be committed to local storage.", 500, { cause });
    }
  }

  async getStream(tenantId: TenantId, objectId: string): Promise<StoredObjectStream | undefined> {
    await this.#ensureRoot();
    validateObjectRef(tenantId, objectId);
    const path = this.#path(tenantId, objectId);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AppError("INTERNAL_ERROR", "Stored object is not a regular file.", 500);
    }
    if (info.size < HEADER_SIZE || info.size > HEADER_SIZE + MAX_OBJECT_SIZE + 4096) {
      throw new AppError("INTERNAL_ERROR", "Stored object has an invalid size.", 500);
    }
    const headerFile = await open(path, "r");
    let metadata: Omit<StoredObjectMetadata, "tenantId" | "objectId">;
    let bodyOffset: number;
    try {
      const header = new Uint8Array(HEADER_SIZE);
      const headerRead = await headerFile.read(header, 0, HEADER_SIZE, 0);
      if (headerRead.bytesRead !== HEADER_SIZE || !MAGIC.every((byte, index) => header[index] === byte)) {
        throw new AppError("INTERNAL_ERROR", "Stored object header is invalid.", 500);
      }
      const metadataLength = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
        MAGIC.byteLength,
        false,
      );
      if (metadataLength > 4096 || HEADER_SIZE + metadataLength > info.size) {
        throw new AppError("INTERNAL_ERROR", "Stored object metadata is invalid.", 500);
      }
      const metadataBytes = new Uint8Array(metadataLength);
      const metadataRead = await headerFile.read(metadataBytes, 0, metadataLength, HEADER_SIZE);
      if (metadataRead.bytesRead !== metadataLength) {
        throw new AppError("INTERNAL_ERROR", "Stored object metadata is incomplete.", 500);
      }
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new AppError("INTERNAL_ERROR", "Stored object metadata is invalid.", 500);
        }
        metadata = parsed as typeof metadata;
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError("INTERNAL_ERROR", "Stored object metadata could not be read.", 500, { cause });
      }
      bodyOffset = HEADER_SIZE + metadataLength;
    } finally {
      await headerFile.close();
    }
    if (
      !validContentType(metadata.contentType) ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > MAX_OBJECT_SIZE ||
      !/^[a-f0-9]{64}$/.test(metadata.etag) ||
      typeof metadata.createdAt !== "string" ||
      !Number.isFinite(Date.parse(metadata.createdAt)) ||
      info.size !== bodyOffset + metadata.size
    ) {
      throw new AppError("INTERNAL_ERROR", "Stored object metadata is invalid.", 500);
    }

    const hash = createHash("sha256");
    let size = 0;
    const source =
      metadata.size === 0
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          })
        : (Readable.toWeb(
            createReadStream(path, { start: bodyOffset, end: bodyOffset + metadata.size - 1 }),
          ) as unknown as ReadableStream<Uint8Array>);
    const body = source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > metadata.size) throw new AppError("INTERNAL_ERROR", "Stored object size validation failed.", 500);
          hash.update(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          if (size !== metadata.size || hash.digest("hex") !== metadata.etag) {
            throw new AppError("INTERNAL_ERROR", "Stored object checksum validation failed.", 500);
          }
        },
      }),
    );
    return { tenantId, objectId, ...metadata, body };
  }

  async delete(tenantId: TenantId, objectId: string): Promise<void> {
    await this.#ensureRoot();
    validateObjectRef(tenantId, objectId);
    try {
      await unlink(this.#path(tenantId, objectId));
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
  }

  #path(tenantId: TenantId, objectId: string): string {
    return join(this.#root, tenantId, `${objectId}.object`);
  }

  #ensureRoot(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const rootInfo = await lstat(this.#root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new AppError("VALIDATION_ERROR", "Object storage root must be a real directory.", 400);
      }
      await chmod(this.#root, 0o700);
    })();
    return this.#ready;
  }
}

function validateObjectRef(tenantId: string, objectId: string): void {
  if (!isSegment(tenantId) || !isSegment(objectId)) {
    throw new AppError("VALIDATION_ERROR", "Object reference is invalid.", 400);
  }
}

function validateContent(contentType: string, bytes: Uint8Array): void {
  if (!validContentType(contentType)) {
    throw new AppError("VALIDATION_ERROR", "Object content type is invalid.", 400);
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_OBJECT_SIZE) {
    throw new AppError("VALIDATION_ERROR", "Object is too large or is not binary data.", 413);
  }
}

function validateContentType(contentType: string): void {
  if (!validContentType(contentType)) {
    throw new AppError("VALIDATION_ERROR", "Object content type is invalid.", 400);
  }
}

function validateObjectSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_SIZE) {
    throw new AppError("VALIDATION_ERROR", "Object size is outside the supported range.", 413);
  }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (result.bytesWritten < 1) throw new AppError("INTERNAL_ERROR", "Object file write made no progress.", 500);
    offset += result.bytesWritten;
  }
}

function validContentType(value: string): boolean {
  return (
    value.length <= 255 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+"'-]+)*$/i.test(value)
  );
}

function isSegment(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function isNotFound(cause: unknown): boolean {
  return !!cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT";
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
