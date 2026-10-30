CREATE TABLE creation_approvals (
  approval_hash TEXT PRIMARY KEY CHECK (length(approval_hash) = 64),
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('connect_credentials', 'public_access', 'publish_bot')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES factory_sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_creation_approvals_expiry ON creation_approvals(expires_at) WHERE consumed_at IS NULL;

CREATE TRIGGER creation_approvals_session_owner_insert
BEFORE INSERT ON creation_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM factory_sessions
  WHERE id = NEW.session_id AND tenant_id = NEW.tenant_id AND owner_id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'creation approval session ownership mismatch');
END;
