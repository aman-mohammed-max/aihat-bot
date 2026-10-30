import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@aihat/core";
import type { ObjectStore, StoredObject, StoredObjectMetadata, TenantId } from "@aihat/core";

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
