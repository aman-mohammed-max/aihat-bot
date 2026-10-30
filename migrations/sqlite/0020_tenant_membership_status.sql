ALTER TABLE tenant_memberships
ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'));

CREATE INDEX idx_memberships_tenant_status_role ON tenant_memberships(tenant_id, status, role, user_id);
