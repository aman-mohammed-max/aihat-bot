import { Buffer } from "node:buffer";
import { createServer } from "node:net";
import { describe, expect, test } from "bun:test";
import { AppError } from "../../packages/core/src/index.js";
import { ClamDScanner, createOptionalClamDScanner } from "../../apps/bun-runtime/src/clamav-scanner.js";

describe("Bun ClamAV scanner adapter", () => {
  test("sends the bounded INSTREAM protocol and returns a clean verdict", async () => {
    const bytes = Uint8Array.from({ length: 130_123 }, (_, index) => index % 251);
    const daemon = await fakeClamD("stream: OK");
    try {
      const result = await scannerFor(daemon.port).scan({
        fileName: "notes.txt",
        contentType: "text/plain",
        bytes,
      });
      expect(result).toEqual({ verdict: "clean", scanner: "ClamAV" });
      expect(daemon.received()).toEqual(bytes);
    } finally {
      await daemon.close();
    }
  });

  test("maps detected signatures to infected without exposing the signature", async () => {
    const daemon = await fakeClamD("stream: Eicar-Test-Signature FOUND");
    try {
      const result = await scannerFor(daemon.port).scan({
        fileName: "sample.txt",
        contentType: "text/plain",
        bytes: new Uint8Array([1, 2, 3]),
      });
      expect(result).toEqual({ verdict: "infected", scanner: "ClamAV" });
      expect(JSON.stringify(result)).not.toContain("Eicar");
    } finally {
      await daemon.close();
    }
  });

  test("fails closed when the daemon returns an error", async () => {
    const errorDaemon = await fakeClamD("stream: scan failed ERROR");
    try {
      await expect(
        scannerFor(errorDaemon.port).scan({
          fileName: "sample.txt",
          contentType: "text/plain",
          bytes: new Uint8Array([1]),
        }),
      ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
    } finally {
      await errorDaemon.close();
    }
  });

  test("fails closed when the daemon times out", async () => {
    const stalledSockets = new Set<import("node:net").Socket>();
    const stalled = createServer((socket) => {
      stalledSockets.add(socket);
      socket.once("close", () => stalledSockets.delete(socket));
    });
    const port = await listen(stalled);
    try {
      await expect(
        new ClamDScanner({ host: "127.0.0.1", port, timeoutMs: 100 }).scan({
          fileName: "sample.txt",
          contentType: "text/plain",
          bytes: new Uint8Array([1]),
        }),
      ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
    } finally {
      await close(stalled, stalledSockets);
    }
  });

  test("validates optional configuration and scan bounds", async () => {
    expect(createOptionalClamDScanner({ host: "", port: "3310" })).toBeUndefined();
    expect(() => createOptionalClamDScanner({ host: "clamav", port: "70000" })).toThrow(AppError);
    expect(() => createOptionalClamDScanner({ host: "bad host" })).toThrow(AppError);

    const daemon = await fakeClamD("stream: OK");
    try {
      await expect(
        scannerFor(daemon.port).scan({
          fileName: "too-large.bin",
          contentType: "application/octet-stream",
          bytes: new Uint8Array(25 * 1024 * 1024 + 1),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 413 });
      expect(daemon.received()).toBeUndefined();
    } finally {
      await daemon.close();
    }
  });
});

function scannerFor(port: number): ClamDScanner {
  return new ClamDScanner({ host: "127.0.0.1", port, timeoutMs: 1_000 });
}

async function fakeClamD(
  reply: string,
): Promise<{ readonly port: number; received(): Uint8Array | undefined; close(): Promise<void> }> {
  let received: Uint8Array | undefined;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let data = Buffer.alloc(0);
    let replied = false;
    socket.on("data", (chunk) => {
      if (replied) return;
      data = Buffer.concat([data, Buffer.from(chunk)]);
      const parsed = parseInstream(data);
      if (!parsed) return;
      replied = true;
      received = parsed;
      socket.end(Buffer.from(`${reply}\0`));
    });
  });
  const port = await listen(server);
  return { port, received: () => received, close: () => close(server, sockets) };
}

function parseInstream(data: Buffer): Uint8Array | undefined {
  const commandEnd = data.indexOf(0);
  if (commandEnd === -1) return undefined;
  if (data.subarray(0, commandEnd).toString("ascii") !== "zINSTREAM") {
    throw new Error("ClamD client did not use INSTREAM.");
  }
  let offset = commandEnd + 1;
  const chunks: Buffer[] = [];
  let total = 0;
  while (offset + 4 <= data.byteLength) {
    const length = data.readUInt32BE(offset);
    offset += 4;
    if (length === 0) {
      if (offset !== data.byteLength) throw new Error("ClamD client sent bytes after the stream terminator.");
      const output = Buffer.concat(chunks, total);
      return new Uint8Array(output.buffer, output.byteOffset, output.byteLength).slice();
    }
    if (offset + length > data.byteLength) return undefined;
    chunks.push(data.subarray(offset, offset + length));
    total += length;
    offset += length;
  }
  return undefined;
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Fake ClamD server did not receive a TCP address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: ReturnType<typeof createServer>, sockets = new Set<import("node:net").Socket>()): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
