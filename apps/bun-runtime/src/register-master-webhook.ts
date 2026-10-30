import { telegramApi } from "@aihat/core";

const token = process.env.TELEGRAM_MASTER_BOT_TOKEN ?? process.env.TELEGRAME_BOT_TOKEN ?? "";
const webhookSecret = process.env.TELEGRAM_MASTER_WEBHOOK_SECRET ?? "";
const baseValue = process.env.TELEGRAM_WEBHOOK_BASE_URL ?? "";

if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) {
  throw new Error("Set TELEGRAM_MASTER_BOT_TOKEN and a 32-character TELEGRAM_MASTER_WEBHOOK_SECRET first.");
}

let base: URL;
try {
  base = new URL(baseValue);
} catch {
  throw new Error("Set TELEGRAM_WEBHOOK_BASE_URL to the public HTTPS runtime URL first.");
}
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
  throw new Error("TELEGRAM_WEBHOOK_BASE_URL must be a public HTTPS base URL without credentials, query, or fragment.");
}

const webhookUrl = new URL("/webhooks/telegram/master", base.origin).toString();
await telegramApi<boolean>(
  token,
  "setWebhook",
  {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message"],
    max_connections: 20,
    drop_pending_updates: false,
  },
  globalThis.fetch.bind(globalThis),
);
console.log("Registered the AI Hat master bot webhook.");
