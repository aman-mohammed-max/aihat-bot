ALTER TABLE memory_records
  ADD COLUMN encrypted_value INTEGER NOT NULL DEFAULT 0 CHECK (encrypted_value IN (0, 1));

CREATE INDEX idx_memory_encryption_migration ON memory_records(tenant_id, bot_id, encrypted_value);
