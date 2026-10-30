import type { CreationApprovalAction, CreationApprovalRepository, CreationApprovalVerifier } from "./ports.js";
import type { TenantId, UserId } from "./types.js";

const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** Issues opaque, short-lived approvals and consumes them once for one exact factory action. */
export class CreationApprovalService implements CreationApprovalVerifier {
  constructor(private readonly approvals: CreationApprovalRepository) {}

  async issue(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly sessionId: string;
    readonly action: CreationApprovalAction;
    readonly now?: Date;
  }): Promise<{ readonly approvalId: string; readonly expiresAt: string }> {
    const now = input.now ?? new Date();
    const approvalId = `approval_${encodeRandom(crypto.getRandomValues(new Uint8Array(32)))}`;
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
    await this.approvals.create({
      approvalHash: await hashApprovalId(approvalId),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      action: input.action,
      createdAt: now.toISOString(),
      expiresAt,
    });
    return { approvalId, expiresAt };
  }

  async consume(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly sessionId: string;
    readonly action: CreationApprovalAction;
    readonly approvalId: string;
  }): Promise<boolean> {
    if (!/^approval_[A-Za-z0-9_-]{43}$/.test(input.approvalId)) return false;
    return this.approvals.consume({
      approvalHash: await hashApprovalId(input.approvalId),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      action: input.action,
      now: new Date().toISOString(),
    });
  }
}

async function hashApprovalId(approvalId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(approvalId)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeRandom(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
