import { AppError } from "@aihat/core";
import type { ObjectStore, StoredObject, StoredObjectMetadata, StoredObjectStream, TenantId } from "@aihat/core";

const MAX_OBJECT_SIZE = 25 * 1024 * 1024;

/** Tenant-prefixed R2 adapter. It stores no public URLs or credentials in metadata. */
export class CloudflareR2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(input: {
    readonly tenantId: TenantId;
    readonly objectId: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<StoredObjectMetadata> {
    validateObjectRef(input.tenantId, input.objectId);
    validateContent(input.contentType, input.bytes);
    const key = objectKey(input.tenantId, input.objectId);
    const object = await this.bucket.put(key, input.bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: { tenantId: input.tenantId, objectId: input.objectId },
    });
    if (!object) throw new AppError("DEPENDENCY_UNAVAILABLE", "R2 did not confirm the object write.", 503);
    return {
      tenantId: input.tenantId,
      objectId: input.objectId,
      contentType: input.contentType,
      size: input.bytes.byteLength,
      etag: object.etag,
      createdAt: new Date().toISOString(),
    };
  }

  async get(tenantId: TenantId, objectId: string): Promise<StoredObject | undefined> {
    validateObjectRef(tenantId, objectId);
    const object = await this.bucket.get(objectKey(tenantId, objectId));
    if (!object) return undefined;
    if (object.customMetadata?.tenantId !== tenantId || object.customMetadata.objectId !== objectId) {
      throw new AppError("INTERNAL_ERROR", "Stored object ownership metadata is invalid.", 500);
    }
    if (object.size > MAX_OBJECT_SIZE) {
      throw new AppError("INTERNAL_ERROR", "Stored object exceeds the application size limit.", 500);
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== object.size) {
      throw new AppError("INTERNAL_ERROR", "Stored object size validation failed.", 500);
    }
    return {
      tenantId,
      objectId,
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      size: object.size,
      etag: object.etag,
      createdAt: object.uploaded.toISOString(),
      bytes,
    };
  }

  async putStream(input: {
    readonly tenantId: TenantId;
    readonly objectId: string;
    readonly contentType: string;
    readonly size: number;
    readonly body: ReadableStream<Uint8Array>;
  }): Promise<StoredObjectMetadata> {
    validateObjectRef(input.tenantId, input.objectId);
    validateContentType(input.contentType);
    validateSize(input.size);
    const key = objectKey(input.tenantId, input.objectId);
    const object = await this.bucket.put(key, checkedStream(input.body, input.size, "VALIDATION_ERROR", 413), {
      httpMetadata: { contentType: input.contentType },
      customMetadata: { tenantId: input.tenantId, objectId: input.objectId },
    });
    if (!object) throw new AppError("DEPENDENCY_UNAVAILABLE", "R2 did not confirm the object write.", 503);
    if (object.size !== input.size) {
      await this.bucket.delete(key).catch(() => undefined);
      throw new AppError("DEPENDENCY_UNAVAILABLE", "R2 stored an unexpected object size.", 503);
    }
    return {
      tenantId: input.tenantId,
      objectId: input.objectId,
      contentType: input.contentType,
      size: object.size,
      etag: object.etag,
      createdAt: object.uploaded.toISOString(),
    };
  }

  async getStream(tenantId: TenantId, objectId: string): Promise<StoredObjectStream | undefined> {
    validateObjectRef(tenantId, objectId);
    const object = await this.bucket.get(objectKey(tenantId, objectId));
    if (!object) return undefined;
    if (object.customMetadata?.tenantId !== tenantId || object.customMetadata.objectId !== objectId) {
      throw new AppError("INTERNAL_ERROR", "Stored object ownership metadata is invalid.", 500);
    }
    if (object.size > MAX_OBJECT_SIZE) {
      throw new AppError("INTERNAL_ERROR", "Stored object exceeds the application size limit.", 500);
    }
    const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
    validateContentType(contentType, true);
    return {
      tenantId,
      objectId,
      contentType,
      size: object.size,
      etag: object.etag,
      createdAt: object.uploaded.toISOString(),
      body: checkedStream(object.body, object.size, "INTERNAL_ERROR", 500),
    };
  }

  async delete(tenantId: TenantId, objectId: string): Promise<void> {
    validateObjectRef(tenantId, objectId);
    await this.bucket.delete(objectKey(tenantId, objectId));
  }
}

function objectKey(tenantId: string, objectId: string): string {
  return `tenants/${tenantId}/objects/${objectId}`;
}

function validateObjectRef(tenantId: string, objectId: string): void {
  if (!isSegment(tenantId) || !isSegment(objectId)) {
    throw new AppError("VALIDATION_ERROR", "Object reference is invalid.", 400);
  }
}

function validateContent(contentType: string, bytes: Uint8Array): void {
  validateContentType(contentType);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_OBJECT_SIZE) {
    throw new AppError("VALIDATION_ERROR", "Object is too large or is not binary data.", 413);
  }
}

function validateContentType(contentType: string, stored = false): void {
  if (
    contentType.length > 255 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+"'-]+)*$/i.test(contentType)
  ) {
    throw new AppError(
      stored ? "INTERNAL_ERROR" : "VALIDATION_ERROR",
      "Object content type is invalid.",
      stored ? 500 : 400,
    );
  }
}

function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_SIZE) {
    throw new AppError("VALIDATION_ERROR", "Object size is outside the supported range.", 413);
  }
}

function checkedStream(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  errorCode: "VALIDATION_ERROR" | "INTERNAL_ERROR",
  status: number,
): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) {
          throw new AppError(errorCode, "Object stream contains a non-binary chunk.", status);
        }
        size += chunk.byteLength;
        if (size > expectedSize || size > MAX_OBJECT_SIZE) {
          throw new AppError(errorCode, "Object stream exceeds its declared size.", status);
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (size !== expectedSize) {
          throw new AppError(errorCode, "Object stream size does not match its declaration.", status);
        }
      },
    }),
  );
}

function isSegment(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
