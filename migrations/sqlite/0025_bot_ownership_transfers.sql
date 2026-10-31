CREATE TABLE bot_ownership_transfers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  from_owner_id TEXT NOT NULL,
  to_owner_id TEXT NOT NULL,
  token_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, from_owner_id) REFERENCES tenant_memberships(tenant_id, user_id),
  FOREIGN KEY (tenant_id, to_owner_id) REFERENCES tenant_memberships(tenant_id, user_id),
  CHECK ((status = 'pending' AND token_hash IS NOT NULL) OR (status <> 'pending' AND token_hash IS NULL))
);

CREATE UNIQUE INDEX idx_bot_ownership_transfer_token
  ON bot_ownership_transfers(token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_bot_ownership_transfer_pending
  ON bot_ownership_transfers(tenant_id, bot_id) WHERE status = 'pending';
CREATE INDEX idx_bot_ownership_transfer_history
  ON bot_ownership_transfers(tenant_id, bot_id, created_at DESC);
