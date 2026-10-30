UPDATE bot_versions
SET configuration_json = json_set(
  configuration_json,
  '$.name', (
    SELECT name FROM bots
    WHERE bots.id = bot_versions.bot_id AND bots.tenant_id = bot_versions.tenant_id
  ),
  '$.description', (
    SELECT description FROM bots
    WHERE bots.id = bot_versions.bot_id AND bots.tenant_id = bot_versions.tenant_id
  )
)
WHERE EXISTS (
  SELECT 1 FROM bots
  WHERE bots.id = bot_versions.bot_id
    AND bots.tenant_id = bot_versions.tenant_id
    AND bots.current_version = bot_versions.version
);
