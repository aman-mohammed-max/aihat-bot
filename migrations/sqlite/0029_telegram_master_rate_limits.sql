CREATE TABLE telegram_master_request_usage (
  actor_id TEXT PRIMARY KEY CHECK (length(actor_id) BETWEEN 1 AND 128),
  minute_window INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 0 AND 1000),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_telegram_master_request_usage_updated
  ON telegram_master_request_usage(updated_at);
