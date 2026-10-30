const SENSITIVE_FIELD = /(?:secret|token|api.?key|authorization|password|credential)/i;
const SENSITIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi,
  /([?&](?:access_token|api_key|apikey|token|password)=)[^&#\s]+/gi,
];
const MAX_LOG_DEPTH = 6;

/** Redacts secret-bearing property names and widely used token forms before structured logs are serialized. */
export function sanitizeLogFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  return sanitizeObject(fields, seen, 0) as Record<string, unknown>;
}

export function sanitizeLogText(value: string): string {
  let output = value;
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: unknown) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return output;
}

function sanitizeObject(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return sanitizeLogText(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: sanitizeLogText(value.name) };
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "[Invalid Date]";
  if (Array.isArray(value)) {
    if (depth >= MAX_LOG_DEPTH) return "[Max Depth]";
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((entry) => sanitizeObject(entry, seen, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_LOG_DEPTH) return "[Max Depth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const result: Record<string, unknown> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    return "[Unserializable]";
  }
  for (const [key, entry] of entries) {
    result[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED]" : sanitizeObject(entry, seen, depth + 1);
  }
  return result;
}
