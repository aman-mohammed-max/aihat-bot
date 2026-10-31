CREATE TABLE tenant_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_by TEXT,
  accepted_at TEXT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (accepted_by) REFERENCES users(id),
  CHECK ((status = 'accepted' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL) OR
         (status != 'accepted' AND accepted_by IS NULL AND accepted_at IS NULL))
);

CREATE INDEX idx_tenant_invitations_tenant_status
  ON tenant_invitations(tenant_id, status, expires_at, created_at DESC);
