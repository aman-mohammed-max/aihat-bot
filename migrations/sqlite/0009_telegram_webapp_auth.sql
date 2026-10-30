CREATE TABLE telegram_auth_nonces (
  data_hash TEXT PRIMARY KEY CHECK (length(data_hash) = 64),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_telegram_auth_nonces_expiry ON telegram_auth_nonces(expires_at);
