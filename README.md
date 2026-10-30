# AI Hat Bot Factory

An extensible platform for creating and hosting AI bots across self-hosted Bun and Cloudflare Workers runtimes. The shared TypeScript core contains the agent loop, provider contract, tool permissions, bot creation state machine, encryption contract, and runtime ports.

## Current implementation

- `packages/core`: shared domain types, errors, provider/agent interfaces, agent orchestration, tool permissions, bot factory, encryption, scheduling, and object-storage ports.
- `apps/bun-runtime`: Bun HTTP API, SQLite repositories and migrations, AES keyring, and private file object storage.
- `apps/cloudflare-runtime`: Worker API, D1 repositories, SQLite-backed Durable Object alarms, Queue producer, and tenant-prefixed R2 object storage.
- `migrations/sqlite`: forward-only tenant-aware schema migrations for bots, sessions, approvals, credentials, Telegram deployments, conversations, skills/MCP, scheduled tasks, jobs, audit records, and access grants.

Both runtimes expose `GET /health`, `GET /ready`, and `GET /capabilities`, shared API-token identity and management endpoints, the authenticated 17-step bot-creation API, bot lifecycle routes, skill and MCP management routes, an owner-scoped agent message endpoint, Telegram text webhooks, and scheduled task management. Bots can be listed, edited with optimistic version checks, disabled/enabled, and deleted. The factory supports pause/resume, draft creation, publishing, encrypted model credential connection, and short-lived one-use approvals for credential connection, public visibility, and publication. Tokens and approvals are stored only as SHA-256 hashes; issued tokens and approvals are shown once. Prompt skills, HTTPS skills, and MCP Streamable HTTP tools are supported. HTTP and MCP calls require exact operator allowlisting through `HTTP_SKILL_ALLOWED_ORIGINS` and `MCP_ALLOWED_ORIGINS`; discovered MCP tools remain disabled until explicitly granted. Static bearer MCP credentials are supported; MCP OAuth is not. A multi-stage Bun Docker image and Compose setup are available for self-hosting. End-user login, streaming, Telegram attachments, and dashboard remain unfinished. Telegram users must be explicitly allowlisted and receive per-user grants for each installed skill or enabled MCP tool. Do not connect owner-sensitive tools or use this build with real customer data.

Factory routes include `POST /v1/factory-sessions`, `GET /v1/factory-sessions/{sessionId}`, and `POST` actions at `/{sessionId}/pause`, `/resume`, `/answer`, `/credentials`, `/draft`, `/publish`, and `/approvals`. Session reads require `factory:read`; changes require `factory:write`. Connect a model credential using an `approvalId` from `/approvals`; the encrypted credential response contains only its opaque reference.

Send messages to `POST /v1/bots/{botId}/messages` with the `agent:run` scope. Bot ownership and conversation history are scoped to the authenticated token owner. Model requests are allowed only to HTTPS origins listed in `MODEL_ALLOWED_ORIGINS`.

Manage owned bots with `GET /v1/bots` and `GET /v1/bots/{botId}` (`bots:read`), `PATCH /v1/bots/{botId}` (`bots:write`, including the current `expectedVersion`), `POST /v1/bots/{botId}/disable` or `/enable`, and `DELETE /v1/bots/{botId}`. Edits create a new version; list/detail responses indicate whether a credential is configured without returning its opaque reference.

List catalog entries with `GET /v1/skills` (`bots:read`). List, install, enable/disable, or uninstall a bot skill under `/v1/bots/{botId}/skills` (`bots:read` or `bots:write`). Installation requires explicit grants matching the skill's declared permissions. Store any skill credential through the encrypted secret flow and pass only its `credentialRef`; plaintext credential fields are rejected. HTTP skill definitions declare no auth, bearer auth, or an API-key header; credential-like static headers are rejected. HTTP endpoints and request policy come from the catalog definition, and endpoint origins must be listed in `HTTP_SKILL_ALLOWED_ORIGINS`.

Manage MCP servers under `/v1/bots/{botId}/mcp-servers`: `GET`/`POST` the collection; `POST` `/{serverId}/connect`, `/test`, or `/disconnect`; `GET` `/{serverId}/tools`; `PATCH` `/{serverId}/tools/{toolName}` with `{ "enabled": true, "grantedPermissions": ["mcp:invoke"] }`; and `DELETE` `/{serverId}`. Calls require bot ownership and `bots:read` or `bots:write`. Add only HTTPS endpoints whose exact origins are in `MCP_ALLOWED_ORIGINS`. Pass an encrypted `credentialRef` for a static bearer token. Discovery never enables tools automatically. Schema changes disable a previously approved tool and clear its grant.

Connect a published bot to Telegram with `PUT /v1/bots/{botId}/telegram` (`bots:write`) and a JSON body containing its BotFather token. Send the token over HTTPS; it is validated with Telegram and encrypted before storage. `GET` returns connection status plus allowed and pending Telegram user IDs; `PATCH` with `{ "allowedUserIds": [123456789] }` replaces the allowlist, and `DELETE` removes the webhook and encrypted credentials. New sender IDs appear as pending and cannot reach the agent until an owner approves them. Set `TELEGRAM_WEBHOOK_BASE_URL` to the public HTTPS base URL that routes to this runtime. Webhook updates are verified using Telegram's secret-token header and deduplicated in storage. Only text messages are handled currently. A sender also needs an owner-managed per-user tool grant before the agent can discover or execute an installed skill or enabled MCP tool.

Manage an approved Telegram user's tool grants with `GET` or `PUT /v1/bots/{botId}/telegram/users/{telegramUserId}/tool-grants` (`bots:read` or `bots:write`). `PUT` replaces the list, for example `{ "toolRefs": ["skill:weather.lookup", "mcp:mcp_<server-id>:lookup"] }`. Removing a sender from the allowlist also removes their tool grants. Both the bot-wide skill/MCP permission and the per-sender grant must be present at discovery and again at execution.

Create and manage durable schedules at `/v1/bots/{botId}/scheduled-tasks`. `POST` requires `bots:write` and `agent:run` and accepts `schedule` (`once:<ISO timestamp>` or `daily:HH:mm`), an IANA `timezone`, a `prompt`, and an approved `notifyTelegramUserId`. The bot must be published and connected to Telegram. `GET` lists owned tasks; `PATCH /{taskId}` with `{ "status": "paused" }` pauses one and `{ "status": "active" }` resumes it; `DELETE /{taskId}` pauses it. Bun polls its persistent SQLite job table. Cloudflare uses per-bot Durable Object alarms and a Queue consumer. Failed delivery retries with backoff, and the model result is persisted so delivery retries do not regenerate it.

See [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) for verified scope and [docs/architecture.md](docs/architecture.md) for the audit and design. Cloudflare bindings and the required provisioning steps are described in [apps/cloudflare-runtime/README.md](apps/cloudflare-runtime/README.md).

## Development

Bun 1.4.4 and Wrangler 4.156.0 are pinned for this worktree. Use:

```sh
bun install
bun run check
bun test
bun run build
```

`bun run check` generates Wrangler binding types, then checks both TypeScript configurations and lints the workspace. `bun run build` bundles Bun and runs Wrangler's Cloudflare dry-run. It does not deploy. To bootstrap a self-hosted tenant and mint its first API token, run `bun run bootstrap:bun -- "My workspace" owner-subject factory:read,factory:write,bots:read,bots:write,agent:run,tokens:manage`; the token appears once in the command output. To run the local Bun server, copy `.env.example`, generate a fresh 32-byte base64 encryption key, and run `bun run dev:bun`. Cloudflare local development uses `bun run dev:cloudflare`.

The Wrangler D1, R2, and Queue names are examples, and D1 IDs are placeholders. Replace them with provisioned development, staging, and production resources before any real deploy. No Cloudflare deployment has been made.

## Self-hosted Docker

Create a private `.env` from `.env.example`, replace the example keyring with a freshly generated 32-byte base64 key, and set the MCP and HTTP origin allowlists only for services you trust. Then run:

```sh
docker compose up --build -d
docker compose logs -f aihat-bot-factory
```

The image builds the Bun runtime in a multi-stage build and runs it as an unprivileged user. Compose keeps SQLite data in the `aihat_data` volume, exposes port 3000 by default, and applies a read-only root filesystem with a writable data volume. The container does not require Cloudflare services. API access still requires bootstrapping an owner token with `docker compose exec aihat-bot-factory bun dist/apps/bun-runtime/src/bootstrap.js "My workspace" owner-subject factory:read,factory:write,bots:read,bots:write,agent:run,tokens:manage`.
