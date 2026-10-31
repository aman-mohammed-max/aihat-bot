CREATE TABLE model_retry_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 2),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 2 AND 3),
  delay_ms INTEGER NOT NULL CHECK (delay_ms BETWEEN 0 AND 3000),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  created_at TEXT NOT NULL,
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_model_retry_events_tenant_bot_created
  ON model_retry_events(tenant_id, bot_id, created_at);
