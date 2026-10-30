CREATE TABLE bot_credential_approvals (
  approval_hash TEXT PRIMARY KEY CHECK (length(approval_hash) = 64),
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_bot_credential_approvals_expiry
  ON bot_credential_approvals(expires_at) WHERE consumed_at IS NULL;

CREATE TRIGGER bot_credential_approvals_owner_insert
BEFORE INSERT ON bot_credential_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM bots
  WHERE id = NEW.bot_id AND tenant_id = NEW.tenant_id AND owner_id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'credential approval bot ownership mismatch');
END;
