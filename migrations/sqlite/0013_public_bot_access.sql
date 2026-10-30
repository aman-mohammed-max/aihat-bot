ALTER TABLE public_bot_listings
  ADD COLUMN daily_usage_limit INTEGER NOT NULL DEFAULT 100
    CHECK (daily_usage_limit BETWEEN 1 AND 10000);

ALTER TABLE public_bot_listings
  ADD COLUMN rate_limit_per_minute INTEGER NOT NULL DEFAULT 10
    CHECK (rate_limit_per_minute BETWEEN 1 AND 600);

CREATE UNIQUE INDEX idx_access_grants_bot_user_unique
  ON bot_access_grants(bot_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE bot_access_usage (
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  minute_window INTEGER NOT NULL,
  minute_count INTEGER NOT NULL CHECK (minute_count >= 0),
  day_window INTEGER NOT NULL,
  day_count INTEGER NOT NULL CHECK (day_count >= 0),
  rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute BETWEEN 1 AND 600),
  daily_usage_limit INTEGER NOT NULL CHECK (daily_usage_limit BETWEEN 1 AND 10000),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, bot_id, user_id),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_bot_access_usage_updated ON bot_access_usage(updated_at);
