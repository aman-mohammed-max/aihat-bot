CREATE TABLE tool_executions (
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  execution_key TEXT NOT NULL CHECK (length(execution_key) = 64),
  tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 64),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded')),
  result_ref TEXT,
  lease_token TEXT,
  lease_until TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, bot_id, execution_key),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, result_ref) REFERENCES encrypted_secrets(tenant_id, reference) ON DELETE CASCADE,
  CHECK ((status = 'running' AND result_ref IS NULL AND lease_token IS NOT NULL) OR
         (status = 'succeeded' AND result_ref IS NOT NULL AND lease_token IS NULL))
);

CREATE INDEX idx_tool_executions_expiry ON tool_executions(tenant_id, expires_at);
CREATE INDEX idx_tool_executions_lease ON tool_executions(lease_until) WHERE status = 'running';
