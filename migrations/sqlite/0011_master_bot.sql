CREATE TABLE master_bot_sessions (
  telegram_user_id INTEGER PRIMARY KEY CHECK (telegram_user_id > 0),
  chat_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_master_bot_sessions_owner ON master_bot_sessions(tenant_id, owner_id, updated_at);

CREATE TABLE master_bot_updates (
  update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
  state TEXT NOT NULL CHECK (state IN ('processing', 'ready', 'completed')),
  response_json TEXT,
  lease_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_master_bot_updates_lease ON master_bot_updates(state, lease_until);
