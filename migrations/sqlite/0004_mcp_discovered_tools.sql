ALTER TABLE mcp_tool_permissions
  ADD COLUMN description TEXT NOT NULL DEFAULT '';

ALTER TABLE mcp_tool_permissions
  ADD COLUMN input_schema_json TEXT NOT NULL DEFAULT '{"type":"object","properties":{}}'
    CHECK (json_valid(input_schema_json));

ALTER TABLE mcp_tool_permissions
  ADD COLUMN output_schema_json TEXT
    CHECK (output_schema_json IS NULL OR json_valid(output_schema_json));

ALTER TABLE mcp_tool_permissions
  ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_mcp_tools_enabled
  ON mcp_tool_permissions(tenant_id, bot_id, server_id, enabled, tool_name);
