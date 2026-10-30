import { describe, expect, test } from "bun:test";
import { sanitizeLogFields, sanitizeLogText } from "../../packages/core/src/log-redaction.js";

describe("structured log secret redaction", () => {
  test("redacts credential fields recursively and handles cycles", () => {
    const fields: Record<string, unknown> = {
      apiKey: "secret-value",
      message: "Request carried Authorization: Bearer abcdefghijklmnop123456",
      nested: { token: "opaque-token", safe: "ordinary text" },
    };
    fields.circular = fields;

    const sanitized = sanitizeLogFields(fields);
    expect(sanitized).toMatchObject({
      apiKey: "[REDACTED]",
      message: "Request carried Authorization: [REDACTED]",
      nested: { token: "[REDACTED]", safe: "ordinary text" },
      circular: "[Circular]",
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-value");
    expect(JSON.stringify(sanitized)).not.toContain("abcdefghijklmnop123456");
  });

  test("redacts common bot, provider, GitHub, Google, URL, and query-string credentials", () => {
    const text = [
      "bot=123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk",
      "provider=sk-proj-abcdefghijklmnopqrstuv",
      "github=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "google=AIza123456789012345678901234567890123456",
      "url=https://user:password@example.test/path",
      "query=https://example.test/?access_token=private-token-value",
    ].join(" ");
    const sanitized = sanitizeLogText(text);
    expect(sanitized).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk");
    expect(sanitized).not.toContain("sk-proj-abcdefghijklmnopqrstuv");
    expect(sanitized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(sanitized).not.toContain("AIza123456789012345678901234567890123456");
    expect(sanitized).not.toContain("user:password");
    expect(sanitized).not.toContain("private-token-value");
  });
});
