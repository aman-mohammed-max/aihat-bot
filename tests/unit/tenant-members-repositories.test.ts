import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { ApiTokenRepository, TenantMembershipRepository } from "../../packages/core/src/ports.js";
import { createApiTokenMaterial } from "../../packages/core/src/api-auth.js";
import type { TenantId, UserId } from "../../packages/core/src/types.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import { CloudflareD1Repositories } from "../../apps/cloudflare-runtime/src/d1-repositories.js";
import { SqliteD1 } from "../helpers/sqlite-d1.js";

const tenantId = "tenant-members-test" as TenantId;
const ownerId = "user-members-owner" as UserId;
const memberId = "user-members-target" as UserId;
const secondOwnerId = "user-members-second-owner" as UserId;
const workspaceTenantId = "tenant-members-workspace" as TenantId;
const inactiveWorkspaceTenantId = "tenant-members-inactive-workspace" as TenantId;
const createdAt = "2026-10-30T00:00:00.000Z";

interface MemberRepositories {
  readonly tenantMembers: TenantMembershipRepository;
  readonly apiTokens: ApiTokenRepository;
}

const adapters: readonly { readonly name: string; readonly create: (db: Database) => MemberRepositories }[] = [
  { name: "Bun SQLite", create: (db) => new BunSqliteRepositories(db) },
  {
    name: "Cloudflare D1",
    create: (db) => new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database),
  },
];

describe("tenant membership repositories", () => {
  for (const adapter of adapters) {
    test(`${adapter.name} enforces owner controls, last-owner protection, audits, and token revocation`, async () => {
      const db = createDatabase();
      const repositories = adapter.create(db);
      seedTenant(db);
      try {
        const ownerMembers = await repositories.tenantMembers.listMembers({ tenantId, actorId: ownerId });
        expect(ownerMembers).toMatchObject([{ userId: ownerId, role: "owner", status: "active" }]);

        await expect(
          repositories.tenantMembers.addMember({
            tenantId,
            actorId: memberId,
            memberId: secondOwnerId,
            role: "member",
            now: createdAt,
          }),
        ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

        const added = await repositories.tenantMembers.addMember({
          tenantId,
          actorId: ownerId,
          memberId,
          role: "member",
          now: createdAt,
        });
        expect(added).toMatchObject({ userId: memberId, role: "member", status: "active", ownedBotCount: 0 });
        await expect(
          repositories.tenantMembers.addMember({
            tenantId,
            actorId: ownerId,
            memberId,
            role: "member",
            now: createdAt,
          }),
        ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

        db.query(`
          INSERT INTO bots (id, tenant_id, owner_id, name, description, status, visibility, current_version, created_at, updated_at)
          VALUES ('bot_member_test', ?, ?, 'Member bot', '', 'draft', 'private', 1, ?, ?)
        `).run(tenantId, memberId, createdAt, createdAt);
        db.query(`
          INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
          VALUES ('bot_member_test', ?, 1, '{}', ?, ?)
        `).run(tenantId, memberId, createdAt);

        const admin = await repositories.tenantMembers.changeMemberRole({
          tenantId,
          actorId: ownerId,
          memberId,
          role: "admin",
          now: "2026-10-30T00:01:00.000Z",
        });
        expect(admin).toMatchObject({ role: "admin", ownedBotCount: 1 });
        await repositories.tenantMembers.changeMemberRole({
          tenantId,
          actorId: ownerId,
          memberId,
          role: "member",
          now: "2026-10-30T00:02:00.000Z",
        });

        const token = await createApiTokenMaterial();
        await repositories.apiTokens.create({
          tokenId: "token-member-test",
          tenantId,
          ownerId: memberId,
          scopes: ["bots:read"],
          tokenHash: token.tokenHash,
          tokenPrefix: token.tokenPrefix,
          createdAt,
        });
        const inactive = await repositories.tenantMembers.deactivateMember({
          tenantId,
          actorId: ownerId,
          memberId,
          now: "2026-10-30T00:03:00.000Z",
        });
        expect(inactive).toMatchObject({ status: "inactive", role: "member", ownedBotCount: 1 });
        expect(await repositories.apiTokens.findActive(token.tokenHash, "2026-10-30T00:04:00.000Z")).toBeUndefined();
        expect(
          db
            .query<{ revoked_at: string | null }, [string]>("SELECT revoked_at FROM api_tokens WHERE id = ?")
            .get("token-member-test")?.revoked_at,
        ).toBe("2026-10-30T00:03:00.000Z");

        const reactivated = await repositories.tenantMembers.addMember({
          tenantId,
          actorId: ownerId,
          memberId,
          role: "member",
          now: "2026-10-30T00:05:00.000Z",
        });
        expect(reactivated.status).toBe("active");
        expect(await repositories.apiTokens.findActive(token.tokenHash, "2026-10-30T00:06:00.000Z")).toBeUndefined();

        await expect(
          repositories.tenantMembers.changeMemberRole({
            tenantId,
            actorId: ownerId,
            memberId: ownerId,
            role: "member",
            now: "2026-10-30T00:07:00.000Z",
          }),
        ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
        await expect(
          repositories.tenantMembers.deactivateMember({
            tenantId,
            actorId: ownerId,
            memberId: ownerId,
            now: "2026-10-30T00:08:00.000Z",
          }),
        ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

        expect(
          db
            .query<{ action: string }, []>(
              "SELECT action FROM audit_logs WHERE resource_type = 'tenant_member' ORDER BY created_at",
            )
            .all()
            .map(({ action }) => action),
        ).toEqual([
          "tenant.member.added",
          "tenant.member.role_changed",
          "tenant.member.role_changed",
          "tenant.member.deactivated",
          "tenant.member.reactivated",
        ]);
        const deactivationAudit = db
          .query<{ metadata_json: string }, []>(
            "SELECT metadata_json FROM audit_logs WHERE action = 'tenant.member.deactivated'",
          )
          .get();
        expect(deactivationAudit && JSON.parse(deactivationAudit.metadata_json)).toMatchObject({ revokedTokens: 1 });
      } finally {
        db.close();
      }
    });

    test(`${adapter.name} refuses ownerless activation and prevents cross-tenant lookup`, async () => {
      const db = createDatabase();
      const repositories = adapter.create(db);
      seedTenant(db);
      try {
        await expect(
          repositories.tenantMembers.listMembers({ tenantId: "tenant-not-this-one" as TenantId, actorId: ownerId }),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          repositories.tenantMembers.addMember({
            tenantId,
            actorId: ownerId,
            memberId: "user-does-not-exist" as UserId,
            role: "member",
            now: createdAt,
          }),
        ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      } finally {
        db.close();
      }
    });

    test(`${adapter.name} lists only active workspace memberships and returns active roles`, async () => {
      const db = createDatabase();
      const repositories = adapter.create(db);
      seedTenant(db);
      try {
        db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Team workspace', ?)").run(
          workspaceTenantId,
          createdAt,
        );
        db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Inactive workspace', ?)").run(
          inactiveWorkspaceTenantId,
          createdAt,
        );
        db.query(
          "INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
        ).run(tenantId, memberId, createdAt);
        db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)").run(
          workspaceTenantId,
          memberId,
          createdAt,
        );
        db.query(
          "INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at, status) VALUES (?, ?, 'owner', ?, 'inactive')",
        ).run(inactiveWorkspaceTenantId, memberId, createdAt);

        expect(await repositories.tenantMembers.listWorkspacesForUser(memberId)).toEqual([
          { tenantId, name: "Member test tenant", role: "member", createdAt },
          { tenantId: workspaceTenantId, name: "Team workspace", role: "admin", createdAt },
        ]);
        expect(await repositories.tenantMembers.getActiveRole({ tenantId: workspaceTenantId, userId: memberId })).toBe(
          "admin",
        );
        expect(
          await repositories.tenantMembers.getActiveRole({ tenantId: inactiveWorkspaceTenantId, userId: memberId }),
        ).toBeUndefined();
      } finally {
        db.close();
      }
    });

    test(`${adapter.name} creates, accepts, expires, and revokes tenant invitations consistently`, async () => {
      const db = createDatabase();
      const repositories = adapter.create(db);
      seedTenant(db);
      try {
        const invitation = await repositories.tenantMembers.createInvitation({
          tenantId,
          actorId: ownerId,
          invitationId: "invite_members_admin",
          tokenHash: "a".repeat(64),
          role: "admin",
          createdAt,
          expiresAt: "2026-11-06T00:00:00.000Z",
        });
        expect(invitation).toMatchObject({ id: "invite_members_admin", role: "admin", status: "pending" });
        const listed = await repositories.tenantMembers.listInvitations({ tenantId, actorId: ownerId, now: createdAt });
        expect(listed).toEqual([invitation]);

        const accepted = await repositories.tenantMembers.acceptInvitation({
          tokenHash: "a".repeat(64),
          userId: memberId,
          now: "2026-10-30T00:01:00.000Z",
        });
        expect(accepted).toEqual({ tenantId, role: "admin" });
        expect(await repositories.tenantMembers.getActiveRole({ tenantId, userId: memberId })).toBe("admin");
        await expect(
          repositories.tenantMembers.acceptInvitation({
            tokenHash: "a".repeat(64),
            userId: secondOwnerId,
            now: "2026-10-30T00:02:00.000Z",
          }),
        ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
        await expect(
          repositories.tenantMembers.acceptInvitation({
            tokenHash: "a".repeat(64),
            userId: memberId,
            now: "2026-10-30T00:02:00.000Z",
          }),
        ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

        await repositories.tenantMembers.deactivateMember({
          tenantId,
          actorId: ownerId,
          memberId,
          now: "2026-10-30T00:03:00.000Z",
        });
        await repositories.tenantMembers.createInvitation({
          tenantId,
          actorId: ownerId,
          invitationId: "invite_members_reactivation",
          tokenHash: "b".repeat(64),
          role: "member",
          createdAt: "2026-10-30T00:04:00.000Z",
          expiresAt: "2026-11-06T00:00:00.000Z",
        });
        await repositories.tenantMembers.acceptInvitation({
          tokenHash: "b".repeat(64),
          userId: memberId,
          now: "2026-10-30T00:05:00.000Z",
        });
        expect(await repositories.tenantMembers.getActiveRole({ tenantId, userId: memberId })).toBe("member");

        await repositories.tenantMembers.createInvitation({
          tenantId,
          actorId: ownerId,
          invitationId: "invite_members_revoked",
          tokenHash: "c".repeat(64),
          role: "member",
          createdAt: "2026-10-30T00:06:00.000Z",
          expiresAt: "2026-11-06T00:00:00.000Z",
        });
        expect(
          await repositories.tenantMembers.revokeInvitation({
            tenantId,
            actorId: ownerId,
            invitationId: "invite_members_revoked",
            now: "2026-10-30T00:07:00.000Z",
          }),
        ).toMatchObject({ status: "revoked" });
        await expect(
          repositories.tenantMembers.acceptInvitation({
            tokenHash: "c".repeat(64),
            userId: secondOwnerId,
            now: "2026-10-30T00:08:00.000Z",
          }),
        ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

        await repositories.tenantMembers.createInvitation({
          tenantId,
          actorId: ownerId,
          invitationId: "invite_members_expired",
          tokenHash: "d".repeat(64),
          role: "member",
          createdAt: "2026-10-30T00:09:00.000Z",
          expiresAt: "2026-10-30T00:10:00.000Z",
        });
        expect(
          (
            await repositories.tenantMembers.listInvitations({
              tenantId,
              actorId: ownerId,
              now: "2026-10-30T00:11:00.000Z",
            })
          ).find((item) => item.id === "invite_members_expired")?.status,
        ).toBe("expired");
        await expect(
          repositories.tenantMembers.acceptInvitation({
            tokenHash: "d".repeat(64),
            userId: secondOwnerId,
            now: "2026-10-30T00:11:00.000Z",
          }),
        ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

        expect(
          db
            .query<{ action: string }, []>(
              "SELECT action FROM audit_logs WHERE resource_type = 'tenant_invitation' ORDER BY created_at, action",
            )
            .all()
            .map(({ action }) => action),
        ).toEqual([
          "tenant.invitation.created",
          "tenant.invitation.accepted",
          "tenant.invitation.created",
          "tenant.invitation.accepted",
          "tenant.invitation.created",
          "tenant.invitation.revoked",
          "tenant.invitation.created",
        ]);
      } finally {
        db.close();
      }
    });
  }
});

function createDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = new URL("../../migrations/sqlite/", import.meta.url);
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    db.exec(readFileSync(new URL(migration, migrationsDirectory), "utf8"));
  }
  return db;
}

function seedTenant(db: Database): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Member test tenant', ?)").run(tenantId, createdAt);
  db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
    ownerId,
    ownerId,
    createdAt,
  );
  db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
    memberId,
    memberId,
    createdAt,
  );
  db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
    secondOwnerId,
    secondOwnerId,
    createdAt,
  );
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    tenantId,
    ownerId,
    createdAt,
  );
}
