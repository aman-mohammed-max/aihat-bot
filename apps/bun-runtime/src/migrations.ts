import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { AppError } from "@aihat/core";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: readFileSync(findMigration("0001_initial.sql"), "utf8"),
  },
  {
    version: 2,
    name: "creation_approvals",
    sql: readFileSync(findMigration("0002_creation_approvals.sql"), "utf8"),
  },
  {
    version: 3,
    name: "skill_rate_limits",
    sql: readFileSync(findMigration("0003_skill_rate_limits.sql"), "utf8"),
  },
  {
    version: 4,
    name: "mcp_discovered_tools",
    sql: readFileSync(findMigration("0004_mcp_discovered_tools.sql"), "utf8"),
  },
  {
    version: 5,
    name: "telegram_webhooks",
    sql: readFileSync(findMigration("0005_telegram_webhooks.sql"), "utf8"),
  },
  {
    version: 6,
    name: "telegram_bot_identity",
    sql: readFileSync(findMigration("0006_telegram_bot_identity.sql"), "utf8"),
  },
  {
    version: 7,
    name: "telegram_sender_access",
    sql: readFileSync(findMigration("0007_telegram_sender_access.sql"), "utf8"),
  },
  {
    version: 8,
    name: "telegram_tool_grants",
    sql: readFileSync(findMigration("0008_telegram_tool_grants.sql"), "utf8"),
  },
  {
    version: 9,
    name: "telegram_webapp_auth",
    sql: readFileSync(findMigration("0009_telegram_webapp_auth.sql"), "utf8"),
  },
  {
    version: 10,
    name: "usage_reporting",
    sql: readFileSync(findMigration("0010_usage_reporting.sql"), "utf8"),
  },
  {
    version: 11,
    name: "master_bot",
    sql: readFileSync(findMigration("0011_master_bot.sql"), "utf8"),
  },
  {
    version: 12,
    name: "encrypted_memory",
    sql: readFileSync(findMigration("0012_encrypted_memory.sql"), "utf8"),
  },
  {
    version: 13,
    name: "public_bot_access",
    sql: readFileSync(findMigration("0013_public_bot_access.sql"), "utf8"),
  },
  {
    version: 14,
    name: "api_rate_limits",
    sql: readFileSync(findMigration("0014_api_rate_limits.sql"), "utf8"),
  },
  {
    version: 15,
    name: "bot_version_labels",
    sql: readFileSync(findMigration("0015_bot_version_labels.sql"), "utf8"),
  },
  {
    version: 16,
    name: "bot_credential_approvals",
    sql: readFileSync(findMigration("0016_bot_credential_approvals.sql"), "utf8"),
  },
  {
    version: 17,
    name: "workflow_executions",
    sql: readFileSync(findMigration("0017_workflow_executions.sql"), "utf8"),
  },
  {
    version: 18,
    name: "telegram_response_attachments",
    sql: readFileSync(findMigration("0018_telegram_response_attachments.sql"), "utf8"),
  },
  {
    version: 19,
    name: "tool_executions",
    sql: readFileSync(findMigration("0019_tool_executions.sql"), "utf8"),
  },
  {
    version: 20,
    name: "tenant_membership_status",
    sql: readFileSync(findMigration("0020_tenant_membership_status.sql"), "utf8"),
  },
  {
    version: 21,
    name: "tenant_invitations",
    sql: readFileSync(findMigration("0021_tenant_invitations.sql"), "utf8"),
  },
  {
    version: 22,
    name: "uploaded_files",
    sql: readFileSync(findMigration("0022_uploaded_files.sql"), "utf8"),
  },
  {
    version: 23,
    name: "tool_execution_recovery",
    sql: readFileSync(findMigration("0023_tool_execution_recovery.sql"), "utf8"),
  },
  {
    version: 24,
    name: "model_retry_analytics",
    sql: readFileSync(findMigration("0024_model_retry_analytics.sql"), "utf8"),
  },
  {
    version: 25,
    name: "bot_ownership_transfers",
    sql: readFileSync(findMigration("0025_bot_ownership_transfers.sql"), "utf8"),
  },
];

export function configureSqlite(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}

export function applyMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const existing = db
    .query<{ version: number; checksum: string }, []>("SELECT version, checksum FROM schema_migrations")
    .all();
  const applied = new Map(existing.map(({ version, checksum }) => [version, checksum]));

  for (const migration of migrations) {
    const checksum = createHash("sha256").update(migration.sql).digest("hex");
    const priorChecksum = applied.get(migration.version);
    if (priorChecksum) {
      if (priorChecksum !== checksum) {
        throw new AppError("INTERNAL_ERROR", `Applied migration ${migration.version} was modified.`, 500);
      }
      continue;
    }

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
        migration.version,
        migration.name,
        checksum,
        new Date().toISOString(),
      );
    });
    apply.immediate();
  }
}

export function openSqliteDatabase(path: string): Database {
  if (!path.trim()) throw new AppError("VALIDATION_ERROR", "DATABASE_PATH must not be empty.", 400);
  if (path.startsWith("file:")) {
    throw new AppError("VALIDATION_ERROR", "DATABASE_PATH must be a filesystem path or :memory:.", 400);
  }
  if (path !== ":memory:") {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const descriptor = openSync(absolutePath, "a", 0o600);
    closeSync(descriptor);
    chmodSync(absolutePath, 0o600);
  }
  const db = new Database(path, { create: true, readwrite: true });
  try {
    configureSqlite(db);
    applyMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function findMigration(filename: string): string {
  const configured = process.env.MIGRATIONS_PATH;
  const candidates =
    configured && filename === "0001_initial.sql"
      ? [resolve(configured)]
      : [
          resolve(process.cwd(), "migrations/sqlite", filename),
          resolve(fileURLToPath(new URL(`../../../migrations/sqlite/${filename}`, import.meta.url))),
        ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new AppError("DEPENDENCY_UNAVAILABLE", `SQLite migration '${filename}' was not found.`, 500);
  return found;
}
