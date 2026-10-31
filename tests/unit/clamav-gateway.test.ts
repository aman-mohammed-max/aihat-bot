import { describe, expect, test } from "bun:test";
import { AppError } from "../../packages/core/src/errors.js";
import type { MalwareScanner } from "../../packages/core/src/ports.js";
import { createOptionalClamDGateway } from "../../apps/bun-runtime/src/clamav-gateway.js";

const endpoint = "https://scanner.example.test/internal/file-scan";
const token = "gateway-token-that-is-at-least-thirty-two-characters";
const bytes = new TextEncoder().encode("safe file contents");

describe("Bun ClamAV HTTPS gateway", () => {
  test("matches the Cloudflare scanner contract and returns a clean verdict", async () => {
    let received: Parameters<MalwareScanner["scan"]>[0] | undefined;
    const handler = createOptionalClamDGateway({
      token,
      scanner: {
        scan: async (input) => {
          received = input;
          return { verdict: "clean", scanner: "ClamAV" };
        },
      },
    });
    if (!handler) throw new Error("Gateway was not configured.");

    const response = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/plain",
          "x-file-name-encoded": encodeURIComponent("notes & plans.txt"),
        },
        body: bytes,
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ verdict: "clean", scanner: "ClamAV" });
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(received).toMatchObject({ fileName: "notes & plans.txt", contentType: "text/plain" });
    expect(received?.bytes).toEqual(bytes);
  });

  test("returns infected verdicts without exposing scanner details", async () => {
    const handler = createOptionalClamDGateway({
      token,
      scanner: { scan: async () => ({ verdict: "infected", scanner: "ClamAV\r\nX-Leak" }) },
    });
    if (!handler) throw new Error("Gateway was not configured.");
    const response = await handler(makeRequest());

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ verdict: "infected", scanner: "ClamAV__X-Leak" });
  });

  test("rejects unauthenticated requests before reading or scanning the file", async () => {
    let scans = 0;
    const handler = createOptionalClamDGateway({
      token,
      scanner: {
        scan: async () => {
          scans += 1;
          return { verdict: "clean", scanner: "ClamAV" };
        },
      },
    });
    if (!handler) throw new Error("Gateway was not configured.");
    const response = await handler(makeRequest("Bearer wrong-token"));

    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "UNAUTHORIZED" });
    expect(response?.headers.get("www-authenticate")).toBe("Bearer");
    expect(scans).toBe(0);
  });

  test("validates route, method, metadata, and declared upload size", async () => {
    const handler = createOptionalClamDGateway({
      token,
      scanner: { scan: async () => ({ verdict: "clean", scanner: "ClamAV" }) },
    });
    if (!handler) throw new Error("Gateway was not configured.");

    expect(await handler(new Request("https://scanner.example.test/health"))).toBeUndefined();
    expect((await handler(new Request(endpoint, { method: "GET" })))?.status).toBe(405);
    expect((await handler(makeRequest(`Bearer ${token}`, { "x-file-name-encoded": "%ZZ" })))?.status).toBe(400);
    expect(
      (
        await handler(
          new Request(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "text/plain",
              "x-file-name-encoded": "large.txt",
              "content-length": String(25 * 1024 * 1024 + 1),
            },
            body: bytes,
          }),
        )
      )?.status,
    ).toBe(413);
  });

  test("enforces the limit while streaming and caps concurrent scans", async () => {
    let scans = 0;
    const handler = createOptionalClamDGateway({
      token,
      scanner: {
        scan: async () => {
          scans += 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          return { verdict: "clean", scanner: "ClamAV" };
        },
      },
    });
    if (!handler) throw new Error("Gateway was not configured.");

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(25 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const oversizedResponse = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/plain",
          "x-file-name-encoded": "large.txt",
        },
        body: oversizedBody,
      }),
    );
    expect(oversizedResponse?.status).toBe(413);
    expect(scans).toBe(0);

    const responses = await Promise.all(Array.from({ length: 5 }, () => handler(makeRequest())));
    expect(responses.filter((response) => response?.status === 200)).toHaveLength(4);
    expect(responses.filter((response) => response?.status === 503)).toHaveLength(1);
    expect(scans).toBe(4);
  });

  test("fails closed on scanner errors and requires a strong token when enabled", async () => {
    const handler = createOptionalClamDGateway({
      token,
      scanner: {
        scan: async () => {
          throw new Error("private daemon detail");
        },
      },
    });
    if (!handler) throw new Error("Gateway was not configured.");
    const response = await handler(makeRequest());

    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain("private daemon detail");
    expect(() =>
      createOptionalClamDGateway({
        token: "short",
        scanner: { scan: async () => ({ verdict: "clean", scanner: "ClamAV" }) },
      }),
    ).toThrow(AppError);
    expect(() => createOptionalClamDGateway({ token })).toThrow(AppError);
    expect(createOptionalClamDGateway({})).toBeUndefined();
  });
});

function makeRequest(authorization = `Bearer ${token}`, headers: Record<string, string> = {}): Request {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "text/plain",
      "x-file-name-encoded": "notes.txt",
      ...headers,
    },
    body: bytes,
  });
}
