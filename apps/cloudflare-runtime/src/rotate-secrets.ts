import { SECRET_ROTATION_ROUTE } from "@aihat/core";

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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authorizationToken}`,
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify({ mode: apply ? "apply" : "dry_run", limit: 100, ...(after ? { after } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Cloudflare secret rotation returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok || !isRecord(value)) {
    const message = isRecord(value) && typeof value.message === "string" ? value.message : "Request failed.";
    throw new Error(`Cloudflare secret rotation failed (HTTP ${response.status}): ${message}`);
  }
  const page = parsePage(value);
  if (page.mode !== (apply ? "apply" : "dry_run")) {
    throw new Error("Cloudflare secret rotation returned a mismatched mode.");
  }
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

function parsePage(value: Record<string, unknown>): {
  readonly mode: string;
  readonly activeKeyId: string;
  readonly scanned: number;
  readonly needingRotation: number;
  readonly rotated: number;
  readonly concurrentlyChanged: number;
  readonly nextCursor?: { tenantId: string; reference: string };
} {
  if (
    typeof value.mode !== "string" ||
    typeof value.activeKeyId !== "string" ||
    !Number.isSafeInteger(value.scanned) ||
    !Number.isSafeInteger(value.needingRotation) ||
    !Number.isSafeInteger(value.rotated) ||
    !Number.isSafeInteger(value.concurrentlyChanged)
  ) {
    throw new Error("Cloudflare secret rotation returned an invalid page.");
  }
  let nextCursor: { tenantId: string; reference: string } | undefined;
  if (value.nextCursor !== undefined) {
    if (
      !isRecord(value.nextCursor) ||
      typeof value.nextCursor.tenantId !== "string" ||
      typeof value.nextCursor.reference !== "string"
    ) {
      throw new Error("Cloudflare secret rotation returned an invalid cursor.");
    }
    nextCursor = { tenantId: value.nextCursor.tenantId, reference: value.nextCursor.reference };
  }
  return {
    mode: value.mode,
    activeKeyId: value.activeKeyId,
    scanned: value.scanned as number,
    needingRotation: value.needingRotation as number,
    rotated: value.rotated as number,
    concurrentlyChanged: value.concurrentlyChanged as number,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
