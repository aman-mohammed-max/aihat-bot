PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  auth_issuer TEXT NOT NULL,
  auth_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (auth_issuer, auth_subject)
);

CREATE TABLE tenant_memberships (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'disabled')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared', 'public', 'invitation')),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  creation_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, owner_id, creation_key),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_memberships(tenant_id, user_id)
);

CREATE TABLE bot_versions (
  bot_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, version),
  UNIQUE (bot_id, tenant_id, version),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_memberships(tenant_id, user_id)
);

CREATE TABLE bot_deployments (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  interface TEXT NOT NULL CHECK (interface IN ('telegram', 'web_chat', 'api')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled', 'failed')),
  external_id TEXT,
  credential_ref TEXT,
  webhook_secret_ref TEXT,
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, interface, external_id),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, credential_ref) REFERENCES encrypted_secrets(tenant_id, reference),
  FOREIGN KEY (tenant_id, webhook_secret_ref) REFERENCES encrypted_secrets(tenant_id, reference)
);

CREATE TABLE encrypted_secrets (
  tenant_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, reference),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE factory_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'paused', 'ready', 'draft', 'published')),
  current_step TEXT,
  answers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(answers_json)),
  bot_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_memberships(tenant_id, user_id),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id)
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  author TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  execution_type TEXT NOT NULL CHECK (execution_type IN ('prompt', 'http', 'mcp', 'native', 'workflow', 'sandbox')),
  input_schema_json TEXT NOT NULL CHECK (json_valid(input_schema_json)),
  output_schema_json TEXT NOT NULL CHECK (json_valid(output_schema_json)),
  permissions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions_json)),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, name, version),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE skill_installations (
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  installed_by TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, skill_id),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id),
  FOREIGN KEY (tenant_id, installed_by) REFERENCES tenant_memberships(tenant_id, user_id)
);

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  credential_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('disconnected', 'connected', 'unhealthy', 'disabled')),
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, bot_id, tenant_id),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, credential_ref) REFERENCES encrypted_secrets(tenant_id, reference)
);

CREATE TABLE mcp_tool_permissions (
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  permissions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, tool_name),
  FOREIGN KEY (server_id, bot_id, tenant_id) REFERENCES mcp_servers(id, bot_id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  actor_id TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('internal', 'telegram', 'web_chat', 'api')),
  platform_conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, bot_id, platform, platform_conversation_id),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  actor_id TEXT,
  memory_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, bot_id, actor_id, memory_key),
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'failed')),
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_memberships(tenant_id, user_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'retrying', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, kind, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  actor_id TEXT,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_micros INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE public_bot_listings (
  bot_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  listed_at TEXT NOT NULL,
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE bot_access_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  user_id TEXT,
  invitation_token_hash TEXT,
  access_level TEXT NOT NULL CHECK (access_level IN ('use', 'manage')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit >= 0),
  rate_limit_per_minute INTEGER CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (bot_id, tenant_id) REFERENCES bots(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  CHECK (user_id IS NOT NULL OR invitation_token_hash IS NOT NULL)
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_memberships(tenant_id, user_id)
);

CREATE INDEX idx_memberships_user ON tenant_memberships(user_id, tenant_id);
CREATE INDEX idx_bots_tenant_updated ON bots(tenant_id, updated_at DESC);
CREATE INDEX idx_bots_public ON bots(status, visibility, updated_at DESC);
CREATE INDEX idx_bot_versions_tenant ON bot_versions(tenant_id, bot_id, version DESC);
CREATE INDEX idx_deployments_tenant_bot ON bot_deployments(tenant_id, bot_id, status);
CREATE INDEX idx_access_grants_bot_user ON bot_access_grants(tenant_id, bot_id, user_id, status);
CREATE UNIQUE INDEX idx_access_invitation_token ON bot_access_grants(invitation_token_hash) WHERE invitation_token_hash IS NOT NULL;
CREATE INDEX idx_api_tokens_owner ON api_tokens(tenant_id, owner_id, revoked_at);
CREATE INDEX idx_factory_owner_updated ON factory_sessions(tenant_id, owner_id, updated_at DESC);
CREATE INDEX idx_skills_tenant_enabled ON skills(tenant_id, enabled, category);
CREATE INDEX idx_mcp_tenant_bot ON mcp_servers(tenant_id, bot_id, status);
CREATE INDEX idx_conversations_tenant_bot_updated ON conversations(tenant_id, bot_id, updated_at DESC);
CREATE INDEX idx_messages_conversation_sequence ON messages(conversation_id, sequence DESC);
CREATE INDEX idx_memory_tenant_actor ON memory_records(tenant_id, bot_id, actor_id, updated_at DESC);
CREATE UNIQUE INDEX idx_memory_actor_key ON memory_records(tenant_id, bot_id, actor_id, memory_key) WHERE actor_id IS NOT NULL;
CREATE UNIQUE INDEX idx_memory_bot_key ON memory_records(tenant_id, bot_id, memory_key) WHERE actor_id IS NULL;
CREATE INDEX idx_scheduled_due ON scheduled_tasks(status, next_run_at);
CREATE INDEX idx_jobs_ready ON jobs(status, available_at);
CREATE INDEX idx_usage_tenant_created ON usage_records(tenant_id, created_at DESC);
CREATE INDEX idx_audit_tenant_created ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_public_listings_search ON public_bot_listings(listed_at DESC, title);
