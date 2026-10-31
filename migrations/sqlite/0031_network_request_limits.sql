CREATE TABLE network_request_usage (
  client_hash TEXT PRIMARY KEY CHECK (length(client_hash) = 64 AND client_hash NOT GLOB '*[^a-f0-9]*'),
  minute_window INTEGER NOT NULL CHECK (minute_window >= 0),
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_network_request_usage_window ON network_request_usage(minute_window);
