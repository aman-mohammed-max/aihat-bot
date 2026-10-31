CREATE TABLE telegram_customer_request_usage (
  deployment_id TEXT NOT NULL REFERENCES bot_deployments(id) ON DELETE CASCADE,
  actor_hash TEXT NOT NULL CHECK (length(actor_hash) = 64 AND actor_hash NOT GLOB '*[^a-f0-9]*'),
  minute_window INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 0 AND 1000),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, actor_hash)
);

CREATE INDEX idx_telegram_customer_request_usage_window
  ON telegram_customer_request_usage(deployment_id, minute_window);
