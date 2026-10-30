CREATE TABLE telegram_tool_grants (
  deployment_id TEXT NOT NULL,
  telegram_user_id INTEGER NOT NULL CHECK (telegram_user_id BETWEEN 1 AND 9007199254740991),
  tool_ref TEXT NOT NULL CHECK (length(tool_ref) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, telegram_user_id, tool_ref),
  FOREIGN KEY (deployment_id, telegram_user_id)
    REFERENCES telegram_allowed_users(deployment_id, telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX idx_telegram_tool_grants_user ON telegram_tool_grants(deployment_id, telegram_user_id);
