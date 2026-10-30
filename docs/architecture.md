# Repository audit and architecture

## Audit scope and evidence

The working tree was inspected before implementation. At audit time it contained only `README.md`; Git history contained only the initial commit. No source files, manifests, dependency lockfiles, tests, database schema or migrations, Docker files, or Wrangler configuration existed. `README.md` contained only the repository title.

Environment checks found Node.js v24.22.2 and Docker 29.9.2. `bun` and `wrangler` were not installed. There is consequently no existing build or test command to inspect or run, and no application behavior that can be claimed as working.

## Existing architecture and inventory

There is no application architecture yet. The repository has no dependencies, TypeScript compiler configuration, runtime entrypoints, persistence layer, authentication, integrations, or dashboard. No third-party dependencies or dependency vulnerabilities can be assessed because there is no dependency manifest or lockfile.

## Problems and risks

1. The requested product is wholly unimplemented; every expected deliverable remains outstanding.
2. There is no runtime or shared core, so Bun/Workers parity and runtime compatibility cannot be evaluated.
3. There is no identity, tenant authorization, secret storage, encryption, SSRF policy, rate limiting, audit log, or webhook verification. The product must not accept real credentials or expose a public endpoint until those controls exist.
4. There is no data model or migration strategy for tenant-owned bots, versions, credentials, conversations, jobs, skills, MCP, or usage.
5. There is no test, lint, format, typecheck, build, or deployment validation setup.
6. Bun and Wrangler are unavailable in the audit environment. Cloudflare deployment credentials and resource identifiers are also not established in the repository.

## Proposed architecture

Keep business rules in a dependency-light TypeScript core. Define explicit ports for persistence, secret operations, queues, scheduling, object storage, HTTP, and logging. Bun and Cloudflare entrypoints should compose runtime-specific adapters around the same application services; they must report unsupported capabilities explicitly. Provider, skill, MCP, Telegram, and dashboard features should be added behind small interfaces when their authorization and tenant boundaries are defined.

Use D1 for Cloudflare relational records and SQLite-backed Durable Objects only for state that needs single-key coordination. Use a self-hosted relational adapter for Bun. Keep dialect-specific migrations explicit rather than pretending SQL dialects are interchangeable. Treat credentials as secret references and never include them in API response types or logs. Gate high-impact actions such as publishing and personal-data integrations on explicit owner approval.

## Prioritized implementation plan

1. Foundation: workspace, shared domain contracts, runtime capability reporting, environment validation, error handling, and logging.
2. Core agent path: bot lifecycle, provider interface and capability negotiation, prompt assembly, tool registry and authorization, conversation persistence.
3. Security and persistence: tenant/auth model, secret abstraction, migrations, audit records, network policy and rate limits.
4. Bot factory and skills: resumable drafts, approval-gated publication, validated HTTP/native/workflow skills, and MCP trust/permission boundaries.
5. Runtime adapters: Bun hosting and Cloudflare Worker, D1, Durable Objects, R2, Queue, and alarm adapters with explicit unsupported capabilities.
6. Telegram and dashboard: independently routed bot integrations and tenant-scoped management UI.
7. Automation and production readiness: persistent schedules, recovery, parity/security tests, Docker/Wrangler validation, deployment and troubleshooting docs.

This plan is intentionally a sequence, not a claim that any item is complete. Do not launch public bots until authentication, tenant isolation, credential handling, permission enforcement, and abuse controls are implemented and verified.

## Initial agent engine decisions

The shared core now has an OpenAI-compatible chat-completions adapter and a provider-neutral orchestration loop. Provider feature flags default to false; tool calling must be explicitly enabled for a configured provider profile. Streaming and structured output are currently reported as unsupported because no implementation exists. The adapter accepts only HTTPS URLs whose exact origins are approved by deployment configuration, rejects redirects, applies a timeout, and resolves credentials through a tenant-scoped secret reference. A tenant-supplied URL is never sufficient authorization to make a request.

Tool definitions are application-registered. The model receives only tools for which the actor currently has all required permissions, and permissions are checked again immediately before execution. Tool input is passed through an application-owned parser, calls are bounded by a round limit and timeout, and error details are not sent back to the model. Conversation turns are appended only after a successful agent response; persistence adapters must make each append atomic. Durable idempotency and secret redaction remain required before external side effects or sensitive tool results are production-ready.

The bot factory now defines the full 17-step creation sequence as a persisted state machine. Session reads are tenant and owner scoped; updates use optimistic revisions so concurrent submissions cannot silently overwrite each other. Paused sessions resume at their current step. The session accepts only an opaque secret reference, never a raw credential. A one-use approval verifier is required before connecting credentials, enabling non-private visibility, or publishing. Draft and publish calls carry idempotency keys. Owner-scoped bot management supports listing, versioned edits, enable/disable, and cascade deletion. A bot version-history API and approval audit records remain outstanding.

The relational migrations target SQLite syntax shared by Bun SQLite and Cloudflare D1. They include tenant-aware foreign keys for bot-owned records and conversation messages, encrypted secret envelopes, factory sessions, skills/MCP, Telegram deployments and update reservations, usage, jobs, audit data, API token hashes, bot access grants, public listings, and fixed-window skill rate-limit buckets. A partial unique index prevents one Telegram bot identity from replacing a different active deployment's webhook. The WebCrypto secret store encrypts each credential with AES-GCM; tenant ID and secret reference are authenticated as additional data, and the encryption key comes only from an injected keyring. D1 repositories implement the same bot, draft/publish, factory-session, approval, API-conversation, Telegram, conversation, encrypted-secret, skill, and rate-limit contracts as Bun. Both runtimes use the shared environment keyring parser; Cloudflare key material is supplied through Worker secrets. Queries still include tenant scope even when foreign keys enforce ownership.

The Bun adapter implements the core SQLite repositories and runs checksum-verified migrations at startup. It stores schema migration checksums, enables foreign keys/WAL/busy timeout, and uses 0700 parent directories and 0600 database files. Its environment keyring reads versioned AES keys from deployment-managed variables. A tenant-scoped file object store uses atomic writes, private file permissions, and a SHA-256 integrity check.

The Cloudflare runtime uses Wrangler 4.156.0 and has development, staging, and production binding configurations for D1, SQLite-backed Durable Objects, R2, Queue producers/consumers, and a one-minute recovery cron. `CloudflareAlarmScheduler` routes one-shot bot schedules to a stable per-bot Durable Object; its alarms enqueue opaque job references. The Queue consumer claims durable D1 jobs, runs the shared agent engine, persists results for delivery recovery, sends Telegram notifications, and schedules bounded retries. The cron re-enqueues due or expired jobs after worker restarts or exhausted Queue deliveries. R2 and Bun file storage implement the same core `ObjectStore` port. Wrangler's local D1 migration and environment dry-runs have been validated, but the D1 identifiers are placeholders and there is no remote deployment.

Both HTTP entrypoints expose health, readiness, and capability routes, shared API-token identity and management endpoints, the bot-creation state machine, owner-scoped bot, skill, MCP, and schedule management, an owner-scoped agent endpoint, and Telegram text webhooks when a public HTTPS base URL is configured. Scheduled tasks support one-time and daily timezone-aware schedules; job state and model output are persisted, retries resume from saved output, and delivery targets must be owner-approved Telegram users. Telegram tokens and webhook secrets are encrypted; webhook headers are checked before bot credentials are resolved, and update IDs are persisted for duplicate suppression. Telegram users receive pseudonymous actor IDs and conversations are grouped by chat, topic, and sender. First-seen Telegram users are pending until the owner adds their numeric IDs to a default-closed allowlist. Current skill/MCP grants remain bot-wide among approved senders. Native/workflow execution, end-user login, Telegram media, per-sender tool grants, and broader abuse controls remain outstanding, so this runtime foundation is not production-ready.
