# Development status

## Current phase

Core platform foundation with Telegram text webhook support; broader product features remain incomplete

## Completed work

- Read the complete product requirements in the supplied prompt.
- Completed the Phase 1 repository inventory and documented the findings, risks, proposed architecture, and prioritized plan in [docs/architecture.md](docs/architecture.md).
- Replaced the placeholder README with project scope and current validation caveats.
- Added a Bun workspace manifest, strict TypeScript configuration, and the first shared core contracts for tenant-scoped bots, conversations, secret references, logging, agent execution, and explicit runtime capabilities.
- Added common runtime configuration parsing and structured application errors, including an explicit unsupported-capability error.
- Added a provider registry, capability profile, and OpenAI-compatible chat-completions adapter with HTTPS origin allowlists, redirect denial, request timeout, secret references, constrained generation parameters, tool-call parsing, and token usage capture.
- Added the shared agent tool loop with tenant-scoped conversation history, per-tool permission checks at discovery and execution, schema-parser hooks, execution timeouts, bounded tool rounds, and bounded serialized tool results.
- Added focused Bun tests for tool authorization, conversation turn persistence, provider credential routing, endpoint allowlisting, and upstream error redaction.
- Added the 17-step bot creation state machine with tenant/owner-scoped persistence contracts, optimistic revisions, pause/resume, field validation, and raw-credential rejection.
- Added one-use approval gates for credential connection, non-private visibility, and publishing, plus idempotency keys for draft creation and publication.
- Added tests covering pause/resume, step ordering, approval gates, credential-reference-only storage, draft creation, and publishing.
- Added a WebCrypto AES-GCM secret store with tenant/reference authenticated data, keyring-based key management, authenticated decryption, and ciphertext-only repository records.
- Moved environment-backed keyring parsing to the shared core so Bun and Workers can use the same AES-GCM secret store implementation.
- Added the first SQLite/D1-compatible migration for tenants, memberships, bots/versions, encrypted secrets, creation sessions, skills, MCP, conversations, memory, schedules/jobs, usage, audit logs, API tokens, access grants, and public listings.
- Added a forward-only migration for short-lived, one-use creation approvals. Only approval hashes are stored; database constraints bind approvals to a tenant member and a session owned by that member.
- Added Bun SQLite repositories for bots, drafts/publication, tenant-scoped creation sessions, atomic conversation turns, and encrypted secret records.
- Added a checksum-verified SQLite migration runner, WAL/busy-timeout configuration, private database file permissions, and directory creation.
- Added Bun runtime config parsing, an environment-backed 32-byte encryption keyring, structured secret-key-redacting logs, health/readiness endpoints, and graceful shutdown.
- Added a tenant-scoped Bun file object store with atomic writes, 0700 directory and 0600 file permissions, content-type and 25 MiB validation, and SHA-256 integrity checks.
- Added `.env.example` and Bun runtime workspace scripts.
- Smoke-tested the live Bun health/readiness endpoints and confirmed SIGINT graceful shutdown.
- Added Biome formatter/linter configuration and workspace scripts.
- Added Wrangler 4.156.0 and generated Worker binding types for the current compatibility date.
- Added a Cloudflare Worker with health, readiness, and capability routes. Readiness checks both D1 and the SQLite-backed Durable Object.
- Added tenant-scoped D1 repositories for bots, idempotent draft creation, publication, factory sessions with optimistic revisions, atomic conversation turns, and encrypted secret records.
- Added a stable per-tenant/bot SQLite-backed Durable Object scheduler. Its one-shot alarms enqueue opaque task references; no prompt text or credentials enter the object or Queue message.
- Added Cloudflare R2 and Bun file object-store adapters behind the same shared `ObjectStore` interface, each enforcing tenant-scoped identifiers, content types, and a 25 MiB limit.
- Added runtime capability responses to make missing features explicit. Telegram is available when `TELEGRAM_WEBHOOK_BASE_URL` is configured. Both runtimes support API-token authentication, prompt skills, allowlisted HTTP skills, and allowlisted MCP Streamable HTTP; end-user login, MCP OAuth, and native/custom-code execution remain unavailable. Cloudflare also reports Queue processing as unavailable.
- Added shared opaque API-token authentication: 256-bit random tokens, SHA-256-only persistence, active membership checks, scoped authorization helpers, expiry, and revocation in Bun SQLite and D1.
- Added shared `GET /v1/whoami`, `POST /v1/tokens`, and `DELETE /v1/tokens/{tokenId}` routes. Token creation requires `tokens:manage`, validates scopes and expiry, and returns plaintext only once with `Cache-Control: no-store`.
- Added shared authenticated factory-session APIs for start/read/pause/resume/answer/draft/publish and approval issuance. Sensitive approvals are opaque, short-lived, one-use, and bound to one tenant, owner, session, and action.
- Added an approved credential-connection endpoint that consumes its one-use approval before encrypting and storing the model key; responses contain only the generated reference.
- Composed the shared agent engine into both runtimes and added owner-scoped `POST /v1/bots/{botId}/messages`. Model egress is restricted to operator-configured HTTPS origins; prompt and HTTPS skills are discovered only when installed, authorized, and allowed by deployment policy. Streaming remains disabled.
- Added tenant-scoped skill catalog and installation repositories in SQLite and D1, including fixed-window rate-limit buckets and migration `0003_skill_rate_limits.sql`.
- Added a shared engine for prompt additions and allowlisted HTTPS skills, with permission checks at discovery and execution, JSON schema validation, response-size limits, redirect denial, timeouts, bounded retries, and encrypted credential references with declared bearer or API-key-header authentication.
- Added owner-scoped `GET /v1/skills` and per-bot list/install/enable/uninstall routes. Installation requires explicit grants matching declared permissions and rejects plaintext credential fields.
- Added owner-scoped bot collection/detail, versioned edit, disable/enable, and delete routes. Edits use `expectedVersion`; response models redact opaque credential references.
- Enabled provider tool calling in both runtime compositions. HTTP skills require an operator-configured `HTTP_SKILL_ALLOWED_ORIGINS` allowlist; the shipped catalog is empty and no skill is enabled by default.
- Added the official Model Context Protocol TypeScript client and shared Streamable HTTP MCP manager. MCP server endpoints require exact operator allowlisting through `MCP_ALLOWED_ORIGINS`; redirects are blocked, bearer credentials resolve only after endpoint validation, and each connection has a bounded timeout.
- Added owner-scoped MCP server add/list/connect/test/disconnect/delete APIs and tool discovery/permission routes. Remote tools start disabled, require an explicit `mcp:invoke` grant, receive generated namespaced model tool names, and have inputs and structured outputs checked against stored schemas.
- Added tenant- and bot-scoped discovered tool schema persistence in Bun SQLite and D1 through migration `0004_mcp_discovered_tools.sql`. Rediscovery preserves authorization only when the schemas are unchanged; changed schemas clear the grant and disable the tool.
- Combined MCP tools with installed skills in both runtimes. Static bearer credentials are supported; OAuth, process-based transports, and automatic reconnect are unavailable.
- Added Telegram Bot API setup through owner-scoped `GET`, `PUT`, and `DELETE /v1/bots/{botId}/telegram` routes. Bot tokens are validated with `getMe`, encrypted at rest, and never returned. The runtime registers HTTPS webhooks with random secret headers and routes only authenticated Telegram updates.
- Added text-message delivery through the shared agent engine, pseudonymous sender IDs, conversation reuse by chat/thread/sender, outbound message chunking, and persisted duplicate-update reservations in Bun SQLite and D1 through migration `0005_telegram_webhooks.sql`.
- Added a cross-deployment unique Telegram bot identity constraint in migration `0006_telegram_bot_identity.sql`, preventing one Telegram bot token from silently replacing another deployment's webhook.
- Added default-closed Telegram sender authorization in migration `0007_telegram_sender_access.sql`. First-seen sender IDs are recorded as pending; bot owners inspect and approve up to 100 numeric Telegram user IDs through the management API before those users can reach the agent.
- Added Telegram integration tests for token handling, webhook registration, invalid-secret rejection before token resolution, message delivery, duplicate updates, and storage isolation/recovery.
- Added tenant-scoped durable scheduled-task APIs for one-time and timezone-aware daily schedules, with recipient validation against the Telegram owner allowlist.
- Added persisted schedule/job adapters in Bun SQLite and D1, stable job IDs, job claims with expiring leases, persisted model results, bounded retry backoff, pause/resume, and task completion/failure state.
- Added shared scheduled-task execution through the existing agent engine, Telegram delivery, Bun's persistent job poller, and Cloudflare Durable Object alarm plus Queue consumer processing.
- Added schedule creation/list/run recovery tests, including retrying a failed Telegram delivery from the saved model result without calling the model again.
- Added MCP protocol tests for allowlist-before-secret behavior, discovery defaults, grants, schema checks, bearer routing, redirect rejection, unhealthy states, and D1 schema-change invalidation.
- Added a shared agent instruction that treats tool names, descriptions, schemas, and outputs as untrusted data, plus strict Worker-compatible JSON Schema validation that rejects external schema references.
- Added a multi-stage Bun Docker image and Compose service with non-root execution, a persistent SQLite volume, health checks, read-only root filesystem, dropped capabilities, restart policy, and no Cloudflare dependency.
- Added tests for permission filtering, origin enforcement, HTTP execution, timeouts, input validation, rate limiting, bot lifecycle/versioning, management grants, and SQLite/D1 persistence.
- Added a Cloudflare environment keyring using Worker secrets and deployment-configured model-provider origin allowlists.
- Added a Bun local bootstrap command to create an initial tenant owner and first API token without storing plaintext.
- Added Cloudflare runtime setup/deployment caveats in [apps/cloudflare-runtime/README.md](apps/cloudflare-runtime/README.md).
- Validated the D1 migration with local Wrangler and dry-ran development, staging, and production Worker configurations. No remote deployment was made.

## Remaining work

- Add R2 streaming support and secret rotation tooling.
- Add native/workflow skill adapters, a curated skill catalog workflow, and catalog publishing validation.
- Add streaming and structured-output support only for providers that implement and verify those capabilities; they currently report unsupported.
- Implement retry policy, durable/idempotent tool execution, concrete secret redaction, and runtime persistence adapters.
- Add end-user login, broader permission evaluation, approval audit records, tenant membership management, API rate limiting, and webhook security boundaries in both runtimes.
- Expose bot version history and add explicit authorization/approval audit adapters.
- Add Telegram media handling, per-sender tool grants, and delivery guarantees beyond at-least-once Telegram sends.
- Implement the dashboard and complete deployment/troubleshooting documentation.

## Known issues and constraints

- The initial repository had no application code, tests, dependencies, schemas, or deployment configuration.
- Bun 1.4.4, `@types/bun` 1.4.4, Biome 2.6.4, and Wrangler 4.156.0 are installed.
- Both HTTP runtimes expose health/readiness/capabilities, API-token identity/management routes, the authenticated bot-creation state machine, bot lifecycle routes, skill and MCP management routes, and an owner-scoped agent endpoint. Prompt, HTTP, and MCP tools require explicit grants and deployment allowlists.
- The first Cloudflare tenant/token still requires operator provisioning in D1; no remote bootstrap operation exists.
- Cloudflare D1 IDs are placeholders. R2 buckets, Queues, and deployment credentials have not been provisioned; no remote deployment was attempted.
- Cloudflare alarms and Queue consumers execute scheduled tasks through D1-backed jobs. Telegram's send API cannot deduplicate outbound notifications, so a crash after Telegram accepts a message but before D1 records completion can produce a duplicate; retries are at-least-once.
- Encrypted-secret operations require deployment-injected keyrings. R2 and Bun object storage currently buffer files up to 25 MiB.
- MCP currently supports static bearer credentials over Streamable HTTP. OAuth, SSE-only transports, reconnect scheduling, and permissions beyond the explicit `mcp:invoke` grant are unavailable.
- Telegram currently processes text updates only. Only owner-approved sender IDs can invoke the agent, but installed skill/MCP grants remain bot-wide among those approved users. Do not connect owner-sensitive tools until per-sender tool grants are implemented.
- Telegram bot tokens are submitted over HTTPS through the owner-scoped management API and encrypted at rest; `TELEGRAME_BOT_TOKEN` and `TELEGRAM_BOT_TOKEN` environment variables are not consumed by the runtime.
- Security controls required for public use are not yet implemented; this repository is not production-ready.

## Validation

- Unit tests executed: `bun test`.
- Tests passed: 33.
- Assertions: 308.
- Tests failed: none.
- `git diff --check`: passed.
- Full `bun run check`: passed, including Wrangler type generation, both TypeScript configurations, and Biome lint.
- Formatting: `bun run format` and `bun run format:check` passed.
- Bun and Cloudflare build checks: `bun run build` passed; Wrangler reported development D1, R2, Queue, and Durable Object bindings.
- Migration smoke check: applied the file-backed SQLite migration twice; verified database mode 0600 and parent directory mode 0700.
- Wrangler 4.156.0: local D1 migrations through `0007_telegram_sender_access.sql` applied successfully.
- Wrangler 4.156.0: development, staging, and production `deploy --dry-run` checks passed.
- Docker Compose configuration and the multi-stage image build passed. The container ran as the non-root user with a temporary UID-owned SQLite mount; `/health` and `/ready` returned HTTP 200.
- Local Cloudflare Worker smoke check: `/health` and `/ready` both returned HTTP 200; readiness instantiated the Durable Object and queried D1.
- Bun file object store: tenant separation, permissions, size/type validation, and corruption detection covered by tests.
- Deployment status: not deployed.
