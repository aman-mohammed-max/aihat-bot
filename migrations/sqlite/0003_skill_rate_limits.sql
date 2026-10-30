CREATE TABLE skill_rate_limit_buckets (
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  PRIMARY KEY (tenant_id, bot_id, skill_id, window_start),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_skill_rate_limit_expiry ON skill_rate_limit_buckets(window_start);
