import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { AppError, EncryptedSecretStore, EnvironmentSecretKeyring } from "@aihat/core";
import type { SecretRotationCursor } from "@aihat/core";
import { BunSqliteRepositories } from "./sqlite-store.js";
import { openSqliteDatabase } from "./migrations.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply") || args.length > 1) {
  throw new Error("Usage: bun run rotate-secrets:bun [--apply]");
}
const apply = args.includes("--apply");
const configuredPath = process.env.DATABASE_PATH;
if (!configuredPath || configuredPath === ":memory:" || configuredPath.startsWith("file:")) {
  throw new AppError(
    "VALIDATION_ERROR",
    "Set DATABASE_PATH to an existing SQLite database before rotating secrets.",
    400,
  );
}
if (!existsSync(resolve(configuredPath))) {
  throw new AppError("NOT_FOUND", "DATABASE_PATH does not point to an existing database file.", 404);
}

const db = openSqliteDatabase(configuredPath);
try {
  const repositories = new BunSqliteRepositories(db);
  const secrets = new EncryptedSecretStore(repositories.secretRecords, new EnvironmentSecretKeyring(process.env));
  let after: SecretRotationCursor | undefined;
  let scanned = 0;
  let needingRotation = 0;
  let rotated = 0;
  let concurrentlyChanged = 0;
  for (;;) {
    const page = await secrets.rotatePage({ after, limit: 100, dryRun: !apply });
    scanned += page.scanned;
    needingRotation += page.needingRotation;
    rotated += page.rotated;
    concurrentlyChanged += page.concurrentlyChanged;
    after = page.nextCursor;
    if (!after) break;
  }
  process.stdout.write(
    `${JSON.stringify({ mode: apply ? "apply" : "dry_run", scanned, needingRotation, rotated, concurrentlyChanged })}\n`,
  );
} finally {
  db.close();
}
