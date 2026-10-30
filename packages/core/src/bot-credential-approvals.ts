import type { BotCredentialApprovalRepository } from "./ports.js";
import type { BotId, TenantId, UserId } from "./types.js";

const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** One-use approvals for replacing credentials on an existing owner bot. */
export class BotCredentialApprovalService {
  constructor(private readonly approvals: BotCredentialApprovalRepository) {}

  async issue(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly now?: Date;
  }): Promise<{ readonly approvalId: string; readonly expiresAt: string }> {
    const now = input.now ?? new Date();
    const approvalId = `credential_approval_${encodeRandom(crypto.getRandomValues(new Uint8Array(32)))}`;
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
    await this.approvals.create({
      approvalHash: await hashApprovalId(approvalId),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      botId: input.botId,
      createdAt: now.toISOString(),
      expiresAt,
    });
    return { approvalId, expiresAt };
  }

  async consume(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly approvalId: string;
    readonly now?: Date;
  }): Promise<boolean> {
    const wellFormed = /^credential_approval_[A-Za-z0-9_-]{43}$/.test(input.approvalId);
    return this.approvals.consume({
      approvalHash: await hashApprovalId(wellFormed ? input.approvalId : "invalid-credential-approval"),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      botId: input.botId,
      now: (input.now ?? new Date()).toISOString(),
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
