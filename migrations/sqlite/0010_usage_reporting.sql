ALTER TABLE usage_records
  ADD COLUMN usage_reported INTEGER NOT NULL DEFAULT 1 CHECK (usage_reported IN (0, 1));
