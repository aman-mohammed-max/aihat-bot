import { AppError } from "./errors.js";

export interface RuntimeConfig {
  readonly environment: "development" | "staging" | "production";
  readonly logLevel: "debug" | "info" | "warn" | "error";
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

  return { environment, logLevel };
}
