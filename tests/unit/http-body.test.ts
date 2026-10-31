import { describe, expect, test } from "bun:test";
import { readBoundedRequestText } from "../../packages/core/src/http-body.js";

describe("bounded HTTP request body reader", () => {
  test("reads bodies within the byte limit", async () => {
    const request = new Request("https://factory.example.test/v1", {
      method: "POST",
      body: JSON.stringify({ value: "hello" }),
    });

    await expect(readBoundedRequestText(request, 64)).resolves.toBe('{"value":"hello"}');
  });

  test("cancels an unbounded stream at the first chunk over its byte limit", async () => {
    let pullCount = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://factory.example.test/v1", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedRequestText(request, 4)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 413,
    });
    expect(pullCount).toBe(1);
    expect(cancelled).toBe(true);
  });

  test("rejects an oversized declared body before reading it", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(1));
      },
    });
    const request = new Request("https://factory.example.test/v1", {
      method: "POST",
      headers: { "content-length": "5" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedRequestText(request, 4)).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBe(false);
  });

  test("rejects invalid UTF-8 instead of replacing bytes before JSON parsing", async () => {
    const request = new Request("https://factory.example.test/v1", {
      method: "POST",
      body: Uint8Array.of(0xff),
    });

    await expect(readBoundedRequestText(request, 4)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
      message: "Request body must be valid UTF-8.",
    });
  });
});
