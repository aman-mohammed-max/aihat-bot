ALTER TABLE tool_executions
ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;

CREATE INDEX idx_tool_executions_conversation
ON tool_executions(tenant_id, bot_id, conversation_id)
WHERE conversation_id IS NOT NULL;

CREATE TRIGGER delete_tool_execution_secret_after_delete
AFTER DELETE ON tool_executions
WHEN OLD.result_ref IS NOT NULL
BEGIN
  DELETE FROM encrypted_secrets
  WHERE tenant_id = OLD.tenant_id AND reference = OLD.result_ref;
END;
