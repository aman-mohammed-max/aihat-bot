import { AppError } from "./errors.js";
import type { JsonSchema } from "./types.js";

const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
]);
const ALLOWED_TYPES = new Set(["object", "array", "string", "boolean", "integer", "number", "null"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_SCHEMA_BYTES = 12_000;
const MAX_SCHEMA_NODES = 500;
const MAX_SCHEMA_DEPTH = 12;

/** Validate the bounded strict-schema subset sent to verified JSON-schema providers. */
export function validateStructuredOutputSchema(value: unknown): JsonSchema {
  const root = asRecord(value);
  if (root?.type !== "object") {
    throw schemaError("The response schema must describe a JSON object.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(root);
  } catch (cause) {
    throw schemaError("The response schema is not valid JSON.", cause);
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_SCHEMA_BYTES) {
    throw schemaError("The response schema is too large.");
  }

  let visited = 0;
  const visit = (raw: unknown, depth: number): void => {
    visited += 1;
    const shape = asRecord(raw);
    if (
      !shape ||
      visited > MAX_SCHEMA_NODES ||
      depth > MAX_SCHEMA_DEPTH ||
      Object.keys(shape).some((key) => !ALLOWED_SCHEMA_KEYS.has(key)) ||
      typeof shape.type !== "string" ||
      !ALLOWED_TYPES.has(shape.type)
    ) {
      throw schemaError("The response schema uses an invalid or unsupported field.");
    }
    if (shape.description !== undefined && (typeof shape.description !== "string" || shape.description.length > 1000)) {
      throw schemaError("Response schema descriptions must be at most 1,000 characters.");
    }
    if (shape.enum !== undefined) {
      if (
        !Array.isArray(shape.enum) ||
        shape.enum.length === 0 ||
        shape.enum.length > 100 ||
        shape.enum.some((item) => !isEnumValue(item, shape.type as string))
      ) {
        throw schemaError("Response schema enums must contain up to 100 values matching their type.");
      }
    }

    if (shape.type === "object") {
      const properties = asRecord(shape.properties);
      if (
        !properties ||
        Object.keys(properties).length > 128 ||
        Object.keys(properties).some((key) => UNSAFE_KEYS.has(key)) ||
        shape.additionalProperties !== false ||
        !Array.isArray(shape.required) ||
        shape.required.length !== Object.keys(properties).length ||
        shape.required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)) ||
        new Set(shape.required).size !== shape.required.length ||
        shape.items !== undefined
      ) {
        throw schemaError(
          "Response objects must declare every property as required and set additionalProperties to false.",
        );
      }
      for (const child of Object.values(properties)) visit(child, depth + 1);
      return;
    }

    if (shape.type === "array") {
      if (shape.items === undefined || shape.properties !== undefined || shape.required !== undefined) {
        throw schemaError("Response arrays must declare an item schema.");
      }
      visit(shape.items, depth + 1);
      return;
    }

    if (
      shape.properties !== undefined ||
      shape.required !== undefined ||
      shape.items !== undefined ||
      shape.additionalProperties !== undefined
    ) {
      throw schemaError("Response primitive schemas cannot declare object or array fields.");
    }
  };
  visit(root, 0);
  return root;
}

/** Reject malformed provider JSON even when a verified endpoint claims schema enforcement. */
export function validateStructuredOutputValue(value: unknown, schema: JsonSchema): void {
  let visited = 0;
  const visit = (current: unknown, shape: Record<string, unknown>, path: string, depth: number): void => {
    visited += 1;
    if (visited > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH || !matchesType(current, shape.type)) {
      throw schemaValueError(path);
    }
    if (Array.isArray(shape.enum) && !shape.enum.some((item) => Object.is(item, current))) {
      throw schemaValueError(path);
    }
    if (Array.isArray(current)) {
      if (!shape.items || typeof shape.items !== "object" || Array.isArray(shape.items)) throw schemaValueError(path);
      for (const [index, item] of current.entries()) {
        visit(item, shape.items as Record<string, unknown>, `${path}[${index}]`, depth + 1);
      }
      return;
    }
    if (isRecord(current)) {
      const properties = shape.properties as Record<string, unknown>;
      const required = shape.required as string[];
      if (Object.keys(current).some((key) => !Object.hasOwn(properties, key))) throw schemaValueError(path);
      for (const key of required) {
        if (!Object.hasOwn(current, key)) throw schemaValueError(`${path}.${key}`);
      }
      for (const [key, propertyValue] of Object.entries(current)) {
        const propertySchema = asRecord(properties[key]);
        if (!propertySchema) throw schemaValueError(`${path}.${key}`);
        visit(propertyValue, propertySchema, `${path}.${key}`, depth + 1);
      }
    }
  };
  visit(value, schema as Record<string, unknown>, "$", 0);
}

function isEnumValue(value: unknown, type: string): boolean {
  if (type === "object" || type === "array") return false;
  return matchesType(value, type);
}

function matchesType(value: unknown, type: unknown): boolean {
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined;
}

function schemaError(message: string, cause?: unknown): AppError {
  return new AppError("VALIDATION_ERROR", message, 400, cause === undefined ? {} : { cause });
}

function schemaValueError(path: string): AppError {
  return new AppError(
    "DEPENDENCY_UNAVAILABLE",
    `Model provider output did not match the response schema at ${path}.`,
    502,
  );
}
