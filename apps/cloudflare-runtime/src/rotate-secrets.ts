import { SECRET_ROTATION_ROUTE } from "@aihat/core";
import { requestSecretRotationPage } from "./secret-rotation-client.js";

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--apply") || args.length > 1) {
  throw new Error("Usage: bun run rotate-secrets:cloudflare [--apply]");
}

const apply = args.includes("--apply");
const workerUrlValue = process.env.CLOUDFLARE_WORKER_URL;
const authorizationToken = process.env.CLOUDFLARE_SECRET_ROTATION_TOKEN;
if (!workerUrlValue || !authorizationToken) {
  throw new Error("Set CLOUDFLARE_WORKER_URL and CLOUDFLARE_SECRET_ROTATION_TOKEN in the shell.");
}

const workerUrl = new URL(workerUrlValue);
if (
  workerUrl.protocol !== "https:" ||
  workerUrl.username ||
  workerUrl.password ||
  workerUrl.pathname !== "/" ||
  workerUrl.search ||
  workerUrl.hash
) {
  throw new Error("CLOUDFLARE_WORKER_URL must be an HTTPS Worker origin without a path or credentials.");
}
if (authorizationToken.length < 32 || authorizationToken.length > 512 || /\s/.test(authorizationToken)) {
  throw new Error("CLOUDFLARE_SECRET_ROTATION_TOKEN must be a 32–512 character bearer token.");
}

const endpoint = new URL(SECRET_ROTATION_ROUTE, workerUrl);
let after: { tenantId: string; reference: string } | undefined;
let scanned = 0;
let needingRotation = 0;
let rotated = 0;
let concurrentlyChanged = 0;
let activeKeyId: string | undefined;
const seenCursors = new Set<string>();

for (;;) {
  const page = await requestSecretRotationPage({
    endpoint,
    authorizationToken,
    mode: apply ? "apply" : "dry_run",
    ...(after ? { after } : {}),
  });
  if (activeKeyId !== undefined && activeKeyId !== page.activeKeyId) {
    throw new Error(
      "The active secret key changed during rotation; rerun the command after reviewing key configuration.",
    );
  }
  activeKeyId = page.activeKeyId;
  scanned += page.scanned;
  needingRotation += page.needingRotation;
  rotated += page.rotated;
  concurrentlyChanged += page.concurrentlyChanged;
  after = page.nextCursor;
  if (!after) break;
  const cursorKey = `${after.tenantId}\u0000${after.reference}`;
  if (seenCursors.has(cursorKey)) throw new Error("Cloudflare secret rotation repeated a cursor; stopping safely.");
  seenCursors.add(cursorKey);
}

process.stdout.write(
  `${JSON.stringify({ mode: apply ? "apply" : "dry_run", activeKeyId, scanned, needingRotation, rotated, concurrentlyChanged })}\n`,
);
