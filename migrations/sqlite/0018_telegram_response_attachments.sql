ALTER TABLE telegram_updates
  ADD COLUMN response_attachments_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(response_attachments_json));
