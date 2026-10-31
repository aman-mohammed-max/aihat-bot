import { AppError } from "./errors.js";
import type { ModelRetryPolicy } from "./model.js";

export interface RuntimeConfig {
  readonly environment: "development" | "staging" | "production";
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly modelRetryPolicy: ModelRetryPolicy;
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

  return {
    environment,
    logLevel,
    modelRetryPolicy: {
      maxAttempts,
      backoffMs,
      maxRetryAfterMs: 3_000,
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
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
