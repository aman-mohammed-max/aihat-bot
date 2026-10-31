INSERT INTO skills (
  id, tenant_id, name, version, author, category, description, execution_type,
  input_schema_json, output_schema_json, permissions_json, definition_json, enabled, created_at
) VALUES (
  'aihat.text.statistics.v1',
  NULL,
  'Text statistics',
  '1.0.0',
  'AI Hat',
  'text',
  'Count words, lines, and characters in text supplied by the user.',
  'native',
  '{"type":"object","properties":{"text":{"type":"string","maxLength":50000}},"required":["text"],"additionalProperties":false}',
  '{"type":"object","properties":{"characterCount":{"type":"integer","minimum":0},"lineCount":{"type":"integer","minimum":0},"wordCount":{"type":"integer","minimum":0}},"required":["characterCount","lineCount","wordCount"],"additionalProperties":false}',
  '["text:analyze"]',
  '{"configuration":{},"timeoutMs":3000,"rateLimit":{"maxRequests":60,"windowSeconds":60},"retryPolicy":{"maxAttempts":1,"backoffMs":0,"idempotent":true,"retryableStatusCodes":[]}}',
  1,
  '2026-10-31T00:00:00.000Z'
);
