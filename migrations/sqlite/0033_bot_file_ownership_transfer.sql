UPDATE bot_files
SET owner_id = (
  SELECT bots.owner_id
  FROM bots
  WHERE bots.tenant_id = bot_files.tenant_id AND bots.id = bot_files.bot_id
)
WHERE EXISTS (
  SELECT 1
  FROM bots
  WHERE bots.tenant_id = bot_files.tenant_id
    AND bots.id = bot_files.bot_id
    AND bots.owner_id <> bot_files.owner_id
);
