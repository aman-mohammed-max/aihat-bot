import { AppError } from "./errors.js";
import type { ModelRetryPolicy } from "./model.js";
import type { ScheduledTaskRetryPolicy } from "./scheduled-tasks.js";
import type { TelegramRetryPolicy } from "./telegram.js";

export const DEFAULT_TELEGRAM_MASTER_REQUESTS_PER_MINUTE = 30;
export const DEFAULT_TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE = 30;

export interface RuntimeConfig {
  readonly environment: "development" | "staging" | "production";
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly modelRetryPolicy: ModelRetryPolicy;
  readonly telegramRetryPolicy: TelegramRetryPolicy;
  readonly telegramMasterRequestsPerMinute: number;
  readonly telegramCustomerRequestsPerMinute: number;
  readonly scheduledTaskRetryPolicy: ScheduledTaskRetryPolicy;
}

/** Parse only non-secret common settings. Runtime adapters own their binding validation. */
export function parseRuntimeConfig(env: Readonly<Record<string, string | undefined>>): RuntimeConfig {
  const environment = env.APP_ENV ?? "development";
  if (environment !== "development" && environment !== "staging" && environment !== "production") {
    throw new AppError("VALIDATION_ERROR", "APP_ENV must be development, staging, or production.", 400);
  }

  const logLevel = env.LOG_LEVEL ?? "info";
  if (logLevel !== "debug" && logLevel !== "info" && logLevel !== "warn" && logLevel !== "error") {
    throw new AppError("VALIDATION_ERROR", "LOG_LEVEL must be debug, info, warn, or error.", 400);
  }

  const maxAttempts = parseIntegerSetting(env.MODEL_RETRY_MAX_ATTEMPTS, "MODEL_RETRY_MAX_ATTEMPTS", 2, 1, 3);
  const backoffMs = parseIntegerSetting(env.MODEL_RETRY_BACKOFF_MS, "MODEL_RETRY_BACKOFF_MS", 250, 0, 3_000);
  const telegramMaxAttempts = parseIntegerSetting(
    env.TELEGRAM_RETRY_MAX_ATTEMPTS,
    "TELEGRAM_RETRY_MAX_ATTEMPTS",
    2,
    1,
    3,
  );
  const telegramMaxRetryAfterSeconds = parseIntegerSetting(
    env.TELEGRAM_RETRY_MAX_AFTER_SECONDS,
    "TELEGRAM_RETRY_MAX_AFTER_SECONDS",
    3,
    0,
    3,
  );
  const telegramMasterRequestsPerMinute = parseIntegerSetting(
    env.TELEGRAM_MASTER_REQUESTS_PER_MINUTE,
    "TELEGRAM_MASTER_REQUESTS_PER_MINUTE",
    DEFAULT_TELEGRAM_MASTER_REQUESTS_PER_MINUTE,
    1,
    1000,
  );
  const telegramCustomerRequestsPerMinute = parseIntegerSetting(
    env.TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE,
    "TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE",
    DEFAULT_TELEGRAM_CUSTOMER_REQUESTS_PER_MINUTE,
    1,
    1000,
  );
  const scheduledTaskMaxAttempts = parseIntegerSetting(
    env.SCHEDULED_TASK_RETRY_MAX_ATTEMPTS,
    "SCHEDULED_TASK_RETRY_MAX_ATTEMPTS",
    5,
    1,
    10,
  );
  const scheduledTaskBackoffMs = parseIntegerSetting(
    env.SCHEDULED_TASK_RETRY_BACKOFF_MS,
    "SCHEDULED_TASK_RETRY_BACKOFF_MS",
    30_000,
    0,
    3_600_000,
  );
  const scheduledTaskMaxBackoffMs = parseIntegerSetting(
    env.SCHEDULED_TASK_RETRY_MAX_BACKOFF_MS,
    "SCHEDULED_TASK_RETRY_MAX_BACKOFF_MS",
    3_600_000,
    0,
    3_600_000,
  );

  return {
    environment,
    logLevel,
    modelRetryPolicy: {
      maxAttempts,
      backoffMs,
      maxRetryAfterMs: 3_000,
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
    },
    telegramRetryPolicy: {
      maxAttempts: telegramMaxAttempts,
      maxRetryAfterSeconds: telegramMaxRetryAfterSeconds,
    },
    telegramMasterRequestsPerMinute,
    telegramCustomerRequestsPerMinute,
    scheduledTaskRetryPolicy: {
      maxAttempts: scheduledTaskMaxAttempts,
      backoffMs: scheduledTaskBackoffMs,
      maxBackoffMs: scheduledTaskMaxBackoffMs,
    },
  };
}

function parseIntegerSetting(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", `${name} must be an integer between ${minimum} and ${maximum}.`, 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError("VALIDATION_ERROR", `${name} must be an integer between ${minimum} and ${maximum}.`, 400);
  }
  return parsed;
}
