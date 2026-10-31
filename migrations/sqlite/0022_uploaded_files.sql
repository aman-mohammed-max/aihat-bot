CREATE TABLE bot_files (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 128),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 26214400),
  etag TEXT NOT NULL CHECK (length(etag) BETWEEN 1 AND 128),
  scan_status TEXT NOT NULL CHECK (scan_status IN ('pending_scan', 'clean', 'rejected', 'scan_failed')),
  scanner TEXT,
  scanned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, bot_id, id),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_memberships(tenant_id, user_id)
);

CREATE INDEX idx_bot_files_owner ON bot_files(tenant_id, owner_id, bot_id, created_at DESC);
CREATE INDEX idx_bot_files_scan_queue ON bot_files(tenant_id, scan_status, created_at);
