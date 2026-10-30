import { API_TOKEN_SCOPES, createApiTokenMaterial } from "@aihat/core";
import { AppError } from "@aihat/core";
import { openSqliteDatabase } from "./migrations.js";

const [rawTenantName, rawOwnerSubject, rawScopes, rawExpiration, ...extra] = process.argv.slice(2);
if (!rawTenantName || !rawOwnerSubject || !rawScopes || extra.length > 0) {
  throw new Error("Usage: bun run bootstrap:bun -- <tenant-name> <owner-subject> <scope,scope> [expires-at-ISO]");
}

const tenantName = rawTenantName.trim();
const ownerSubject = rawOwnerSubject.trim();
const scopes = rawScopes.split(",").map((scope) => scope.trim());
if (!tenantName || tenantName.length > 160 || !ownerSubject || ownerSubject.length > 255) {
  throw new AppError("VALIDATION_ERROR", "Tenant name or owner subject is invalid.", 400);
}
if (
  scopes.length === 0 ||
  scopes.length !== new Set(scopes).size ||
  scopes.some((scope) => !API_TOKEN_SCOPES.includes(scope as (typeof API_TOKEN_SCOPES)[number]))
) {
  throw new AppError("VALIDATION_ERROR", "One or more API token scopes are invalid.", 400);
}

const now = new Date();
const expiration = rawExpiration ? Date.parse(rawExpiration) : now.getTime() + 30 * 24 * 60 * 60 * 1000;
if (
  !Number.isFinite(expiration) ||
  expiration <= now.getTime() ||
  expiration > now.getTime() + 366 * 24 * 60 * 60 * 1000
) {
  throw new AppError("VALIDATION_ERROR", "Token expiration must be within the next 366 days.", 400);
}

const databasePath = process.env.DATABASE_PATH ?? "./data/aihat.sqlite";
const db = openSqliteDatabase(databasePath);
try {
  const existingUser = db
    .query<{ id: string }, [string]>("SELECT id FROM users WHERE auth_issuer = 'local-bootstrap' AND auth_subject = ?")
    .get(ownerSubject);
  const ownerId = existingUser?.id ?? `user_${crypto.randomUUID()}`;
  const tenantId = `tenant_${crypto.randomUUID()}`;
  const tokenId = `token_${crypto.randomUUID()}`;
  const material = await createApiTokenMaterial();
  const createdAt = now.toISOString();
  const expiresAt = new Date(expiration).toISOString();

  const bootstrap = db.transaction(() => {
    db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)").run(tenantId, tenantName, createdAt);
    if (!existingUser) {
      db.query(`
        INSERT INTO users (id, auth_issuer, auth_subject, created_at)
        VALUES (?, 'local-bootstrap', ?, ?)
      `).run(ownerId, ownerSubject, createdAt);
    }
    db.query(`
      INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at)
      VALUES (?, ?, 'owner', ?)
    `).run(tenantId, ownerId, createdAt);
    db.query(`
      INSERT INTO api_tokens (
        id, tenant_id, owner_id, token_hash, token_prefix, scopes_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tokenId,
      tenantId,
      ownerId,
      material.tokenHash,
      material.tokenPrefix,
      JSON.stringify(scopes),
      createdAt,
      expiresAt,
    );
  });
  bootstrap.immediate();
  process.stdout.write(
    `${JSON.stringify(
      {
        tenantId,
        ownerId,
        tokenId,
        apiToken: material.token,
        scopes,
        expiresAt,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  db.close();
}
