import { AppError } from "./errors.js";
import type { NativeSkillHandler } from "./skill-engine.js";
import type { SkillCatalogPublication } from "./types.js";

interface NativeSkillRegistration {
  readonly definition: SkillCatalogPublication;
  readonly fingerprint: string;
  readonly handler: NativeSkillHandler;
}

/** Code-registered, reviewed TypeScript handlers. Catalog metadata never supplies executable code. */
export class NativeSkillRegistry {
  readonly #registrations = new Map<string, NativeSkillRegistration>();

  register(definition: SkillCatalogPublication, handler: NativeSkillHandler): void {
    if (
      definition.executionType !== "native" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(definition.id) ||
      typeof handler !== "function"
    ) {
      throw new AppError("VALIDATION_ERROR", "Native skills need a safe ID, native execution type, and handler.", 400);
    }
    if (this.#registrations.has(definition.id)) {
      throw new AppError("CONFLICT", "A native skill with this ID is already registered.", 409);
    }
    const snapshot = freezeJson(definition) as SkillCatalogPublication;
    const fingerprint = stableJson(snapshot);
    this.#registrations.set(definition.id, { definition: snapshot, fingerprint, handler });
  }

  get handlers(): ReadonlyMap<string, NativeSkillHandler> {
    return new Map([...this.#registrations].map(([id, registration]) => [id, registration.handler]));
  }

  listDefinitions(): readonly SkillCatalogPublication[] {
    return [...this.#registrations.values()].map((registration) => registration.definition);
  }

  matchesDefinition(definition: SkillCatalogPublication): boolean {
    const registration = this.#registrations.get(definition.id);
    return registration !== undefined && registration.fingerprint === stableJson(definition);
  }
}

/** Built-ins are ordinary reviewed TypeScript handlers and still require explicit per-bot permission grants. */
export function createDefaultNativeSkillRegistry(): NativeSkillRegistry {
  const registry = new NativeSkillRegistry();
  registry.register(
    {
      id: "aihat.text.statistics.v1",
      name: "Text statistics",
      version: "1.0.0",
      author: "AI Hat",
      category: "text",
      description: "Count words, lines, and characters in text supplied by the user.",
      executionType: "native",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: 50_000 } },
        required: ["text"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          characterCount: { type: "integer", minimum: 0 },
          lineCount: { type: "integer", minimum: 0 },
          wordCount: { type: "integer", minimum: 0 },
        },
        required: ["characterCount", "lineCount", "wordCount"],
        additionalProperties: false,
      },
      requiredPermissions: ["text:analyze"],
      configuration: {},
      timeoutMs: 3_000,
      rateLimit: { maxRequests: 60, windowSeconds: 60 },
      retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotent: true, retryableStatusCodes: [] },
    },
    async (_context, input) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new AppError("VALIDATION_ERROR", "Text statistics input is invalid.", 400);
      }
      const text = (input as Record<string, unknown>).text;
      if (typeof text !== "string") throw new AppError("VALIDATION_ERROR", "Text is required.", 400);
      const trimmed = text.trim();
      return {
        characterCount: text.length,
        lineCount: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length,
        wordCount: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length,
      };
    },
  );
  return registry;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeJson(child)])));
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new AppError("VALIDATION_ERROR", "Native skill definitions must contain only JSON values.", 400);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new AppError("VALIDATION_ERROR", "Native skill definitions must contain only JSON values.", 400);
  }
  return encoded;
}
