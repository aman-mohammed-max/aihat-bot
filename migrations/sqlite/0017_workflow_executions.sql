CREATE TABLE workflow_executions (
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  execution_key TEXT NOT NULL CHECK (length(execution_key) = 64),
  state_ref TEXT NOT NULL,
  next_step INTEGER NOT NULL CHECK (next_step >= 0),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded')),
  lease_token TEXT,
  lease_until TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, bot_id, skill_id, execution_key),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, state_ref) REFERENCES encrypted_secrets(tenant_id, reference) ON DELETE CASCADE,
  CHECK ((status = 'running' AND lease_token IS NOT NULL) OR (status = 'succeeded' AND lease_token IS NULL))
);

CREATE INDEX idx_workflow_executions_expiry ON workflow_executions(tenant_id, expires_at);
CREATE INDEX idx_workflow_executions_lease ON workflow_executions(lease_until) WHERE status = 'running';
