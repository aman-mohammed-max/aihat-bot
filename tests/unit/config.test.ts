import { describe, expect, test } from "bun:test";
import { parseRuntimeConfig } from "../../packages/core/src/config.js";

describe("runtime configuration", () => {
  test("uses bounded model retry defaults and supports deployment overrides", () => {
    expect(parseRuntimeConfig({}).modelRetryPolicy).toEqual({
      maxAttempts: 2,
      backoffMs: 250,
      maxRetryAfterMs: 3_000,
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
    });
    expect(
      parseRuntimeConfig({ MODEL_RETRY_MAX_ATTEMPTS: "3", MODEL_RETRY_BACKOFF_MS: "0" }).modelRetryPolicy,
    ).toMatchObject({ maxAttempts: 3, backoffMs: 0 });
  });

  test("rejects malformed and out-of-range model retry settings", () => {
    for (const env of [
      { MODEL_RETRY_MAX_ATTEMPTS: "0" },
      { MODEL_RETRY_MAX_ATTEMPTS: "4" },
      { MODEL_RETRY_MAX_ATTEMPTS: "2.5" },
      { MODEL_RETRY_BACKOFF_MS: "-1" },
      { MODEL_RETRY_BACKOFF_MS: "3001" },
    ]) {
      expect(() => parseRuntimeConfig(env)).toThrow();
    }
  });
});
