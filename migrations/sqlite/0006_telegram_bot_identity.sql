CREATE UNIQUE INDEX idx_telegram_active_bot_identity
  ON bot_deployments(external_id)
  WHERE interface = 'telegram' AND status IN ('pending', 'active', 'failed');
