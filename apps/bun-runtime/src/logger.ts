import type { Logger } from "@aihat/core";

const SECRET_FIELD = /secret|token|authorization|credential|api.?key|password/i;

export class JsonLogger implements Logger {
  constructor(private readonly level: "debug" | "info" | "warn" | "error" = "info") {}

  info(event: string, fields?: Readonly<Record<string, unknown>>): void {
    if (this.#enabled("info")) this.#write("info", event, fields);
  }

  warn(event: string, fields?: Readonly<Record<string, unknown>>): void {
    if (this.#enabled("warn")) this.#write("warn", event, fields);
  }

  error(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#write("error", event, fields);
  }

  #enabled(level: "info" | "warn"): boolean {
    const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
    return order[level] >= order[this.level];
  }

  #write(level: "info" | "warn" | "error", event: string, fields?: Readonly<Record<string, unknown>>): void {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      safe[key] = SECRET_FIELD.test(key) ? "[REDACTED]" : sanitizeValue(value);
    }
    console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safe }));
  }
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name };
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SECRET_FIELD.test(key) ? "[REDACTED]" : sanitizeValue(entry);
    }
    return result;
  }
  return value;
}
