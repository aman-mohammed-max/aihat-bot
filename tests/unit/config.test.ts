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
    expect(parseRuntimeConfig({}).telegramRetryPolicy).toEqual({ maxAttempts: 2, maxRetryAfterSeconds: 3 });
    expect(parseRuntimeConfig({}).telegramMasterRequestsPerMinute).toBe(30);
    expect(parseRuntimeConfig({}).telegramCustomerRequestsPerMinute).toBe(30);
    expect(parseRuntimeConfig({}).scheduledTaskRetryPolicy).toEqual({
      maxAttempts: 5,
      backoffMs: 30_000,
      maxBackoffMs: 3_600_000,
    });
    expect(
      parseRuntimeConfig({
        MODEL_RETRY_MAX_ATTEMPTS: "3",
        MODEL_RETRY_BACKOFF_MS: "0",
        TELEGRAM_RETRY_MAX_ATTEMPTS: "1",
        TELEGRAM_RETRY_MAX_AFTER_SECONDS: "0",
        TELEGRAM_MASTER_REQUESTS_PER_MINUTE: "42",
        TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE: "54",
        SCHEDULED_TASK_RETRY_MAX_ATTEMPTS: "8",
        SCHEDULED_TASK_RETRY_BACKOFF_MS: "1000",
        SCHEDULED_TASK_RETRY_MAX_BACKOFF_MS: "60000",
      }),
    ).toMatchObject({
      modelRetryPolicy: { maxAttempts: 3, backoffMs: 0 },
      telegramRetryPolicy: { maxAttempts: 1, maxRetryAfterSeconds: 0 },
      telegramMasterRequestsPerMinute: 42,
      telegramCustomerRequestsPerMinute: 54,
      scheduledTaskRetryPolicy: { maxAttempts: 8, backoffMs: 1000, maxBackoffMs: 60_000 },
    });
  });

  test("rejects malformed and out-of-range model retry settings", () => {
    for (const env of [
      { MODEL_RETRY_MAX_ATTEMPTS: "0" },
      { MODEL_RETRY_MAX_ATTEMPTS: "4" },
      { MODEL_RETRY_MAX_ATTEMPTS: "2.5" },
      { MODEL_RETRY_BACKOFF_MS: "-1" },
      { MODEL_RETRY_BACKOFF_MS: "3001" },
      { TELEGRAM_RETRY_MAX_ATTEMPTS: "4" },
      { TELEGRAM_RETRY_MAX_AFTER_SECONDS: "4" },
      { TELEGRAM_MASTER_REQUESTS_PER_MINUTE: "0" },
      { TELEGRAM_MASTER_REQUESTS_PER_MINUTE: "1001" },
      { TELEGRAM_MASTER_REQUESTS_PER_MINUTE: "1.5" },
      { TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE: "0" },
      { TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE: "1001" },
      { TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE: "1.5" },
      { SCHEDULED_TASK_RETRY_MAX_ATTEMPTS: "11" },
      { SCHEDULED_TASK_RETRY_BACKOFF_MS: "3600001" },
      { SCHEDULED_TASK_RETRY_MAX_BACKOFF_MS: "-1" },
    ]) {
      expect(() => parseRuntimeConfig(env)).toThrow();
    }
  });
});
