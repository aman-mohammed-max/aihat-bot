# Troubleshooting

This guide covers the Bun runtime and the Cloudflare development Worker. The current development Mini App is at `https://aihat-bot-factory.work-fdc.workers.dev/miniapp/`. Staging and production still need their own resources, secrets, migrations, and deployments.

## Check service health

For Cloudflare, request `/health`, `/ready`, and `/capabilities` on the Worker origin. `/ready` checks D1 and the Durable Object. The capabilities response names features that are actually configured; `telegramMiniAppAuth` should be `true` for the deployed development Worker. `telegramMasterBot` remains `false` until the master webhook secret and public webhook URL are configured.

When testing a `workers.dev` URL from a script, send a descriptive application `User-Agent` header. Cloudflare's Browser Integrity Check can reject library defaults such as Python `urllib` with HTTP 403 / error 1010 before the request reaches the Worker; those blocked requests do not appear in Worker logs. For example: `curl -A 'my-service-health-check/1.0' https://<worker>.workers.dev/health`. This does not require changing Worker routes or application code. See [Cloudflare's error 1010 guidance](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/).

For local Bun, start the server with `bun run dev:bun`, then request `http://127.0.0.1:3000/health`, `/ready`, and `/capabilities`. If the dashboard reports missing files, run `bun run build:dashboard`; `bun run dev:bun` normally builds it first.

Inspect Cloudflare request errors with `wrangler tail --env=""` from `apps/cloudflare-runtime`. Logs redact credential fields. Do not add tokens or request bodies to logs while debugging.

## Telegram Mini App sign-in

- Set the Mini App URL in BotFather to `https://aihat-bot-factory.work-fdc.workers.dev/miniapp/` and add `aihat-bot-factory.work-fdc.workers.dev` as the app domain.
- Open the app through that bot in Telegram. A normal browser does not supply Telegram `initData`; use an owner API token there instead.
- Confirm the Worker has `TELEGRAM_MASTER_BOT_TOKEN` set to the token for the same bot configured in BotFather. The legacy `TELEGRAME_BOT_TOKEN` spelling is accepted by Bun, but use the correctly spelled Worker secret.
- Telegram launch data is time limited and one use. Close and reopen the Mini App to get fresh launch data if authentication reports stale or replayed data.
- A signed first launch creates the Telegram user's personal workspace. If `/ready` is healthy but sign-in fails, check the Worker logs for a sanitized auth failure and verify the bot token; do not copy `initData` into support logs.

## Master bot commands

The Mini App sign-in does not require the master bot webhook. To use `/create`, `/continue`, and other text commands, configure `TELEGRAM_MASTER_WEBHOOK_SECRET` and `TELEGRAM_WEBHOOK_BASE_URL`, then run `bun run telegram:register-master` with those values and the master bot token in the Bun environment. The registration command calls Telegram `setWebhook`; a Telegram bot can have only one webhook, so inspect its existing integration before registering this app.

## Customer Telegram bots

- `GET /capabilities` must report `telegram: true`; the runtime needs a public HTTPS `TELEGRAM_WEBHOOK_BASE_URL`.
- Customer bot tokens are validated with Telegram when connected. A failed validation usually means the token was copied incorrectly or belongs to a different bot.
- Webhook requests require Telegram's secret-token header. Reconnect through the dashboard if an owner deleted or disabled the deployment.
- New sender IDs are pending until the owner approves them. A sender needs both bot-level skill/MCP grants and per-sender grants.
- The development Worker base URL is already set. For staging or production, set its public HTTPS origin separately before connecting bots.

## Model requests and tools

- Model endpoint errors with `403` mean the HTTPS origin is missing from `MODEL_ALLOWED_ORIGINS`. Add only reviewed exact origins; credentials are resolved only after the egress check.
- Streaming is enabled only when the endpoint origin appears in both `MODEL_ALLOWED_ORIGINS` and `MODEL_STREAMING_ORIGINS`.
- Strict structured output additionally requires the origin in `MODEL_STRUCTURED_OUTPUT_ORIGINS`. It is disabled by default; streaming and structured output cannot be combined.
- HTTP skills require their endpoint origin in `HTTP_SKILL_ALLOWED_ORIGINS`. MCP endpoints and OAuth issuer/token origins must be listed in `MCP_ALLOWED_ORIGINS`. MCP supports encrypted bearer credentials, server-to-server OAuth client credentials, and user-consent OAuth authorization code with PKCE. Register the exact dashboard Mini App callback URL (`https://<your-app-host>/miniapp/`) with the OAuth provider. The client stores PKCE flow state and tokens in encrypted secrets and rejects mismatched, expired, or reused callbacks.
- If an HTTP skill is not discoverable, check its installation, enabled state, declared permissions, actor grants, and origin allowlist. MCP tools start disabled and need explicit grants.
- Model HTTP errors 408, 429, 500, 502, 503, and 504 may retry for non-streaming requests. Set `MODEL_RETRY_MAX_ATTEMPTS` to 1–3 and `MODEL_RETRY_BACKOFF_MS` to 0–3000; network failures and streaming requests fail without replay to avoid duplicate cost or repeated text deltas.

## Encryption and database setup

- `encryptedSecrets` must be `true` in `/capabilities` before connecting model, Telegram, or skill credentials. Configure `SECRET_ACTIVE_KEY_ID` and `SECRET_KEYRING_JSON` as Worker secrets or Bun environment values.
- Keep every key ID needed to decrypt existing records. Do not replace the keyring with a new single key unless existing encrypted records have been rotated. Use the secret-rotation workflow documented in the root README and Cloudflare runtime guide.
- Cloudflare development has D1 migrations `0001` through `0023`. For a new environment, create its D1 database, set the returned ID in `wrangler.jsonc`, then apply migrations from `apps/cloudflare-runtime` with `wrangler d1 migrations apply <database-name> --remote`.
- Staging and production also need distinct R2 buckets and Queues. The committed placeholder D1 IDs are not valid deployment IDs.
- Local Bun migrations run at startup. For migration errors, inspect the stored migration checksum and database path; do not edit an already-applied migration. Add a forward-only migration instead.

## Build and deploy checks

From the repository root:

```sh
bun run check
bun test
bun run format:check
bun run build
```

`bun run build` bundles Bun and performs a Wrangler dry run; it does not deploy. Cloudflare staging and production deployments require their own configured bindings and secrets. Never use the development database or encryption key for production data.
