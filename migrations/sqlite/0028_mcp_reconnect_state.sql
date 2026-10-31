ALTER TABLE mcp_servers
  ADD COLUMN reconnect_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconnect_attempts BETWEEN 0 AND 8);

ALTER TABLE mcp_servers ADD COLUMN reconnect_after TEXT;
ALTER TABLE mcp_servers ADD COLUMN reconnect_lease_until TEXT;
ALTER TABLE mcp_servers ADD COLUMN reconnect_lease_token TEXT;
