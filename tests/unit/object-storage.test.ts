import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileObjectStore } from "../../apps/bun-runtime/src/file-object-store.js";
import { CloudflareR2ObjectStore } from "../../apps/cloudflare-runtime/src/r2-object-store.js";
import type { TenantId } from "../../packages/core/src/types.js";

const tenantId = "tenant-storage" as TenantId;
const otherTenantId = "tenant-other" as TenantId;
const objectId = "document_01";

describe("tenant-scoped object storage", () => {
  test("Bun storage writes atomically with private permissions and checks bytes on read", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "aihat-objects-")), "objects");
    const store = new BunFileObjectStore(root);
    const bytes = new Uint8Array([0, 1, 2, 127, 255]);
    try {
      const metadata = await store.put({ tenantId, objectId, contentType: "application/octet-stream", bytes });
      expect(metadata).toMatchObject({ tenantId, objectId, contentType: "application/octet-stream", size: 5 });
      expect(metadata.etag).toMatch(/^[a-f0-9]{64}$/);
      expect((await store.get(tenantId, objectId))?.bytes).toEqual(bytes);
      expect(await store.get(otherTenantId, objectId)).toBeUndefined();

      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, tenantId))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, tenantId, `${objectId}.object`))).mode & 0o777).toBe(0o600);

      await expect(
        store.put({ tenantId, objectId: "../../escape", contentType: "text/plain", bytes }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      await expect(store.put({ tenantId, objectId, contentType: "not a content type", bytes })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });

      const objectPath = join(root, tenantId, `${objectId}.object`);
      const corrupted = await readFile(objectPath);
      const last = corrupted.length - 1;
      const lastByte = corrupted.at(-1);
      if (lastByte === undefined) throw new Error("Stored test object unexpectedly has no bytes.");
      corrupted[last] = lastByte ^ 0xff;
      await Bun.write(objectPath, corrupted);
      await expect(store.get(tenantId, objectId)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Bun storage streams files to disk and verifies the stream while reading", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "aihat-stream-")), "objects");
    const store = new BunFileObjectStore(root);
    const bytes = new Uint8Array([0, 1, 2, 127, 255]);
    try {
      const metadata = await store.putStream({
        tenantId,
        objectId,
        contentType: "application/octet-stream",
        size: bytes.byteLength,
        body: streamChunks([bytes.slice(0, 2), bytes.slice(2)]),
      });
      expect(metadata.size).toBe(bytes.byteLength);
      const stored = await store.getStream(tenantId, objectId);
      expect(stored?.etag).toBe(metadata.etag);
      expect(await readStream(stored?.body)).toEqual(bytes);
      await expect(
        store.putStream({
          tenantId,
          objectId: "short",
          contentType: "application/octet-stream",
          size: bytes.byteLength + 1,
          body: streamChunks([bytes]),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await store.getStream(tenantId, "short")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("R2 storage scopes object keys and verifies tenant metadata", async () => {
    const objects = new Map<string, StoredR2Object>();
    const bucket = {
      put: async (key: string, value: Uint8Array | ReadableStream<Uint8Array>, options: R2PutOptions) => {
        const bytes = value instanceof Uint8Array ? new Uint8Array(value) : await readStream(value);
        const object: StoredR2Object = {
          bytes,
          etag: await digest(bytes),
          httpMetadata: options.httpMetadata,
          customMetadata: options.customMetadata,
          uploaded: new Date("2026-10-30T00:00:00.000Z"),
        };
        objects.set(key, object);
        return { etag: object.etag, size: object.bytes.byteLength, uploaded: object.uploaded };
      },
      get: async (key: string) => {
        const object = objects.get(key);
        if (!object) return null;
        return {
          size: object.bytes.byteLength,
          etag: object.etag,
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
          uploaded: object.uploaded,
          arrayBuffer: async () => object.bytes.slice().buffer,
          body: new Response(object.bytes.slice()).body as ReadableStream<Uint8Array>,
        };
      },
      delete: async (key: string) => void objects.delete(key),
    } as unknown as R2Bucket;
    const store = new CloudflareR2ObjectStore(bucket);
    const bytes = new Uint8Array([10, 20, 30]);

    await store.put({ tenantId, objectId, contentType: "image/png", bytes });
    expect([...objects.keys()]).toEqual([`tenants/${tenantId}/objects/${objectId}`]);
    expect((await store.get(tenantId, objectId))?.bytes).toEqual(bytes);
    const streamed = await store.putStream({
      tenantId,
      objectId: "streamed",
      contentType: "image/png",
      size: bytes.byteLength,
      body: streamChunks([bytes]),
    });
    expect(streamed.size).toBe(bytes.byteLength);
    expect(await readStream((await store.getStream(tenantId, "streamed"))?.body)).toEqual(bytes);
    expect(await store.get(otherTenantId, objectId)).toBeUndefined();
    await store.delete(tenantId, objectId);
    expect(await store.get(tenantId, objectId)).toBeUndefined();
  });
});

interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

interface StoredR2Object {
  bytes: Uint8Array;
  etag: string;
  httpMetadata: R2PutOptions["httpMetadata"];
  customMetadata: R2PutOptions["customMetadata"];
  uploaded: Date;
}

function streamChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!stream) throw new Error("Expected stored object stream.");
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
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
  return bytes;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
