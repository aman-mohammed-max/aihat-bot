CREATE TABLE api_request_usage (
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  minute_window INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, owner_id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE
);

CREATE INDEX idx_api_request_usage_updated ON api_request_usage(updated_at);
