ALTER TABLE tool_executions
ADD COLUMN recovery_status TEXT NOT NULL DEFAULT 'none'
CHECK (recovery_status IN ('none', 'ambiguous', 'retry_approved', 'closed'));

ALTER TABLE tool_executions ADD COLUMN ambiguous_at TEXT;

CREATE INDEX idx_tool_executions_recovery
ON tool_executions(tenant_id, bot_id, recovery_status, ambiguous_at DESC)
WHERE recovery_status IN ('ambiguous', 'retry_approved');
