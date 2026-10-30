CREATE TABLE telegram_allowed_users (
  deployment_id TEXT NOT NULL,
  telegram_user_id INTEGER NOT NULL CHECK (telegram_user_id BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, telegram_user_id),
  FOREIGN KEY (deployment_id) REFERENCES bot_deployments(id) ON DELETE CASCADE
);

CREATE TABLE telegram_access_requests (
  deployment_id TEXT NOT NULL,
  telegram_user_id INTEGER NOT NULL CHECK (telegram_user_id BETWEEN 1 AND 9007199254740991),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count > 0),
  PRIMARY KEY (deployment_id, telegram_user_id),
  FOREIGN KEY (deployment_id) REFERENCES bot_deployments(id) ON DELETE CASCADE
);

CREATE INDEX idx_telegram_access_requests_last_seen ON telegram_access_requests(deployment_id, last_seen_at DESC);
