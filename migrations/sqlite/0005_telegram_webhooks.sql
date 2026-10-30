CREATE TABLE telegram_updates (
  deployment_id TEXT NOT NULL,
  update_id INTEGER NOT NULL CHECK (update_id >= 0),
  state TEXT NOT NULL CHECK (state IN ('processing', 'ready', 'completed')),
  response_text TEXT,
  lease_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, update_id),
  FOREIGN KEY (deployment_id) REFERENCES bot_deployments(id) ON DELETE CASCADE
);

CREATE INDEX idx_telegram_updates_lease ON telegram_updates(state, lease_until);
