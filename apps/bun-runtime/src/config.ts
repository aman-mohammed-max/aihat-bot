import { AppError, parseRuntimeConfig } from "@aihat/core";
import type { RuntimeConfig } from "@aihat/core";

export interface BunRuntimeConfig extends RuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
}

export function parseBunRuntimeConfig(env: Readonly<Record<string, string | undefined>>): BunRuntimeConfig {
  const common = parseRuntimeConfig(env);
  const rawPort = env.PORT ?? "3000";
  if (!/^\d{1,5}$/.test(rawPort))
    throw new AppError("VALIDATION_ERROR", "PORT must be an integer from 1 to 65535.", 400);
  const port = Number(rawPort);
  if (port < 1 || port > 65_535)
    throw new AppError("VALIDATION_ERROR", "PORT must be an integer from 1 to 65535.", 400);

  const host = env.HOST ?? "127.0.0.1";
  if (!host.trim() || host.length > 255) throw new AppError("VALIDATION_ERROR", "HOST is invalid.", 400);

  const databasePath = env.DATABASE_PATH ?? "./data/aihat.sqlite";
  if (!databasePath.trim() || databasePath.length > 2048) {
    throw new AppError("VALIDATION_ERROR", "DATABASE_PATH is invalid.", 400);
  }
  if (common.environment === "production" && databasePath === ":memory:") {
    throw new AppError("VALIDATION_ERROR", "Production requires a persistent DATABASE_PATH.", 400);
  }
  return { ...common, host, port, databasePath };
}
