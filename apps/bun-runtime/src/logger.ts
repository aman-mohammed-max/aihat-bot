import { sanitizeLogFields, sanitizeLogText } from "@aihat/core";
import type { Logger } from "@aihat/core";

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
    const safe = sanitizeLogFields(fields ?? {});
    console[level](
      JSON.stringify({ timestamp: new Date().toISOString(), level, ...safe, event: sanitizeLogText(event) }),
    );
  }
}
