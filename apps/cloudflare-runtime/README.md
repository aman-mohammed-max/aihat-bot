# Cloudflare runtime

This Worker exposes `GET /health`, `GET /ready`, `GET /capabilities`, shared API-token routes, the authenticated bot-creation state machine, bot lifecycle routes, skill and MCP management routes, an owner-scoped agent message endpoint, Telegram text webhooks, and owner-scoped scheduled tasks. Prompt skills, allowlisted HTTPS skills, and allowlisted MCP Streamable HTTP tools can execute. MCP currently supports static bearer credentials, not OAuth. Streaming, native/workflow execution, and arbitrary code remain unavailable.

## Bindings and ownership

- **D1 (`DB`)** stores globally queryable relational records. `CloudflareD1Repositories` implements bot, draft/publish, factory-session, approval, API-token, conversation, Telegram deployment/update, encrypted-secret, skill catalog/install/rate-limit, MCP server/tool, and scheduled-task/job contracts. Every lookup and write carries tenant and bot scope. Whole conversation turns and MCP rediscovery writes use D1 batches.
- **Durable Objects (`BOT_COORDINATOR`)** use SQLite and one stable object identity per tenant and bot. The object persists one-shot task alarms and sends queue envelopes containing opaque job references. It does not store prompt text or credentials.
- **Queues (`JOBS`)** receives opaque scheduled-job references from Durable Object alarms. Its consumer claims durable D1 jobs, runs the shared agent engine, persists the response for delivery recovery, sends it to an owner-approved Telegram user, and applies bounded retry backoff. A per-environment one-minute cron reconciles due or expired jobs back into the Queue after dropped messages or worker restarts. The capability response reports `queueProcessing: true`.
- **R2 (`OBJECTS`)** stores binary objects under tenant-prefixed keys with content type and ownership metadata. Both object-store adapters enforce a 25 MiB limit and validate object references. The R2 adapter buffers objects in memory; streaming uploads are not implemented.

Cloudflare reads versioned 32-byte AES keys from Worker secrets `SECRET_ACTIVE_KEY_ID` and `SECRET_KEYRING_JSON`; `encryptedSecrets` is available when these are configured. Use the same key IDs and key material as any runtime that needs to decrypt the same D1 envelopes. `MODEL_ALLOWED_ORIGINS` is an operator-managed HTTPS origin list; it defaults to `https://api.openai.com`. `HTTP_SKILL_ALLOWED_ORIGINS` and `MCP_ALLOWED_ORIGINS` are separate comma-separated HTTPS origin allowlists and default to empty. Set `TELEGRAM_WEBHOOK_BASE_URL` to the public HTTPS Worker URL for each environment before connecting a Telegram bot; the capability route reports Telegram support only when this value is non-empty. API-token authentication covers token identity, management, factory, bot lifecycle, skill, MCP, Telegram-management, and agent-message APIs; end-user login, streaming, bot version history, and custom code execution are unavailable.

API tokens use 256 bits of random entropy and are stored as SHA-256 hashes. Authentication joins the token to a current tenant membership and checks revocation and expiration on every request. `POST /v1/tokens` and `DELETE /v1/tokens/{tokenId}` require the `tokens:manage` scope; newly minted token plaintext is returned once with `Cache-Control: no-store`. A token can grant only scopes it already holds. A first Cloudflare owner/token must be provisioned by an operator in D1 because there is intentionally no unauthenticated bootstrap endpoint. The Bun-only local bootstrap command is documented in the root README.

Factory requests use `POST /v1/factory-sessions`, `GET /v1/factory-sessions/{sessionId}`, and `POST` actions at `/{sessionId}/pause`, `/resume`, `/answer`, `/credentials`, `/draft`, `/publish`, and `/approvals`. API tokens need `factory:read` for session reads and `factory:write` for state changes. Approval IDs are short-lived and one-use; D1 stores only their hashes. The `/credentials` action encrypts a submitted model key and returns a reference, never the key.

Configure the keyring as Worker secrets before connecting credentials:

```sh
wrangler secret put SECRET_ACTIVE_KEY_ID
wrangler secret put SECRET_KEYRING_JSON
```

Set these separately for development, staging, and production (`wrangler secret put NAME --env staging` or `--env production`).

For Bun, set the same variables in the runtime environment. Generate a fresh key with `openssl rand -base64 32`; keep previous key IDs in `SECRET_KEYRING_JSON` during rotation until their ciphertext has been re-encrypted.

Send text requests to `POST /v1/bots/{botId}/messages` with `agent:run`. Each token can call only bots owned by its user. Add provider origins to `MODEL_ALLOWED_ORIGINS` only after reviewing the endpoint; unlisted origins are blocked before resolving the secret or making a request.

Use `GET /v1/skills` to inspect the tenant-visible catalog, then manage installations with `GET` or `POST /v1/bots/{botId}/skills`, `PATCH /v1/bots/{botId}/skills/{skillId}`, and `DELETE /v1/bots/{botId}/skills/{skillId}`. These routes require `bots:read` or `bots:write` and enforce bot ownership. Installation requires explicit grants for every declared permission. HTTP skill definitions are operator-seeded in D1; their exact HTTPS endpoint origins must appear in `HTTP_SKILL_ALLOWED_ORIGINS` before the model can discover them. HTTP credentials use encrypted references and declared bearer or API-key-header modes; credential-like static headers are rejected.

Manage MCP servers under `/v1/bots/{botId}/mcp-servers` with collection `GET`/`POST`, server `POST` actions `connect`, `test`, and `disconnect`, tool `GET`, tool-permission `PATCH`, and server `DELETE` routes. These routes enforce bot ownership and `bots:read` or `bots:write`. Add only HTTPS endpoints whose exact origins are configured in `MCP_ALLOWED_ORIGINS`; the allowlist is checked before resolving a secret reference. Credentials are encrypted references to static bearer tokens. MCP redirects fail closed. Discovery stores schemas and disables new tools; enabling a tool requires `mcp:invoke`. If a rediscovered input or output schema changes, the old grant is cleared. Set `MCP_ALLOWED_ORIGINS` in Wrangler vars for each environment after reviewing each server origin.

Manage owned bots through `GET /v1/bots`, `GET /v1/bots/{botId}`, `PATCH /v1/bots/{botId}`, `POST /v1/bots/{botId}/enable`, `POST /v1/bots/{botId}/disable`, and `DELETE /v1/bots/{botId}`. Edits require the current `expectedVersion` and persist a new version. Responses redact credential references. All management routes enforce token scopes and bot ownership.

Connect a published bot to Telegram using `PUT /v1/bots/{botId}/telegram` with `bots:write` and a JSON body containing the BotFather token. The token is sent over HTTPS, checked with Telegram, and encrypted at rest. `GET` returns connection status and allowed/pending sender IDs; `PATCH` with `{ "allowedUserIds": [123456789] }` replaces the sender allowlist. First-seen users remain pending and cannot reach the agent before owner approval. `DELETE` unregisters the webhook and removes the deployment credentials. Telegram webhooks use a random secret header and persisted update IDs to reject forged or duplicate deliveries. Text messages only are handled. A sender needs an owner-managed per-user grant to discover and execute an installed skill or enabled MCP tool; the existing bot-level grant is checked as well.

Manage a sender's tool grants with `GET` or `PUT /v1/bots/{botId}/telegram/users/{telegramUserId}/tool-grants` using `bots:read` or `bots:write`. A `PUT` body contains a `toolRefs` array such as `{ "toolRefs": ["skill:weather.lookup", "mcp:mcp_<server-id>:lookup"] }`. Only already-allowed sender IDs can receive grants, and removing a sender from the allowlist cascades away their grants.

Create a schedule with `POST /v1/bots/{botId}/scheduled-tasks` using `bots:write` and `agent:run`. The JSON body contains `schedule` (`once:<ISO timestamp>` or `daily:HH:mm`), an IANA `timezone`, `prompt`, and an approved `notifyTelegramUserId`. The bot must be published and Telegram-connected. Use collection `GET` to list tasks, task `PATCH` with `{ "status": "paused" }` or `{ "status": "active" }` to pause/resume, and task `DELETE` to pause. The Durable Object stores schedule metadata and a reference only; task prompts and model output stay in D1.

## Environments and local checks

`wrangler.jsonc` configures development at the top level and separate `staging` and `production` environments. Wrangler 4.156.0 is pinned in the root workspace. All three D1 IDs are placeholders. The bucket and queue names must also be created in the target account before deployment; no remote resources or secrets have been configured.

From the repository root:

```sh
bun run typecheck:cloudflare
bun run build:cloudflare
```

To start local development:

```sh
cd apps/cloudflare-runtime
bun run dev
```

Apply the local D1 migrations from `apps/cloudflare-runtime`:

```sh
bunx wrangler d1 migrations apply aihat-bot-development --local --config wrangler.jsonc
```

Before any remote deployment, create separate D1 databases, R2 buckets, and Queues for each environment; replace each placeholder D1 ID; then apply the matching remote D1 migrations. The `build:cloudflare` script runs only Wrangler `--dry-run`. The Worker has not been deployed.
