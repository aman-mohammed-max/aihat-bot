import { AppError } from "./errors.js";
import type {
  BotDraftPublisher,
  CreationApprovalAction,
  CreationApprovalVerifier,
  CreationSessionRepository,
  SecretWriter,
} from "./ports.js";
import type { CreationAnswers, CreationSession, CreationStep, TenantId, UserId } from "./types.js";

export const CREATION_STEPS = [
  "name",
  "description",
  "purpose",
  "audience",
  "personality",
  "providerId",
  "endpoint",
  "model",
  "credentialRef",
  "imageModel",
  "searchModel",
  "skills",
  "mcpConnections",
  "integrations",
  "memoryEnabled",
  "scheduledTasks",
  "privacySettings",
  "visibility",
  "interfaces",
] as const satisfies readonly CreationStep[];

export interface BotFactoryOptions {
  readonly sessions: CreationSessionRepository;
  readonly approvals: CreationApprovalVerifier;
  readonly drafts: BotDraftPublisher;
}

/** Persistent, owner-scoped bot creation state machine. Secrets never enter its answer state. */
export class BotFactory {
  readonly #sessions: CreationSessionRepository;
  readonly #approvals: CreationApprovalVerifier;
  readonly #drafts: BotDraftPublisher;

  constructor(options: BotFactoryOptions) {
    this.#sessions = options.sessions;
    this.#approvals = options.approvals;
    this.#drafts = options.drafts;
  }

  async start(tenantId: TenantId, ownerId: UserId): Promise<CreationSession> {
    const now = new Date().toISOString();
    const session: CreationSession = {
      id: `factory_${crypto.randomUUID()}`,
      tenantId,
      ownerId,
      status: "in_progress",
      currentStep: CREATION_STEPS[0],
      answers: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.#sessions.create(session);
    return session;
  }

  async get(tenantId: TenantId, ownerId: UserId, sessionId: string): Promise<CreationSession> {
    return this.#load(tenantId, ownerId, sessionId);
  }

  async pause(tenantId: TenantId, ownerId: UserId, sessionId: string): Promise<CreationSession> {
    const session = await this.#load(tenantId, ownerId, sessionId);
    if (session.status !== "in_progress") {
      throw new AppError("CONFLICT", "Only an in-progress bot creation session can be paused.", 409);
    }
    return this.#save({ ...session, status: "paused" });
  }

  async resume(tenantId: TenantId, ownerId: UserId, sessionId: string): Promise<CreationSession> {
    const session = await this.#load(tenantId, ownerId, sessionId);
    if (session.status !== "paused") {
      throw new AppError("CONFLICT", "Only a paused bot creation session can be resumed.", 409);
    }
    return this.#save({ ...session, status: "in_progress" });
  }

  async answer(
    tenantId: TenantId,
    ownerId: UserId,
    sessionId: string,
    step: CreationStep,
    value: unknown,
    approvalId?: string,
  ): Promise<CreationSession> {
    const session = await this.#load(tenantId, ownerId, sessionId);
    if (session.status !== "in_progress" || session.currentStep !== step) {
      throw new AppError("CONFLICT", "Answer the current active creation step before moving ahead.", 409);
    }

    const parsed = validateAnswer(step, value);
    const action = approvalRequired(step, parsed);
    if (action) {
      await this.#consumeApproval(session, action, approvalId);
    }

    const answers = { ...session.answers, [step]: parsed } as Partial<CreationAnswers>;
    const nextIndex = CREATION_STEPS.indexOf(step) + 1;
    const nextStep = CREATION_STEPS[nextIndex] ?? null;
    return this.#save({
      ...session,
      answers,
      currentStep: nextStep,
      status: nextStep ? "in_progress" : "ready",
    });
  }

  async connectCredential(
    tenantId: TenantId,
    ownerId: UserId,
    sessionId: string,
    plaintext: string,
    approvalId: string,
    secrets: SecretWriter,
  ): Promise<CreationSession> {
    const session = await this.#load(tenantId, ownerId, sessionId);
    if (session.status !== "in_progress" || session.currentStep !== "credentialRef") {
      throw new AppError("CONFLICT", "Credentials can only be connected at the active credential step.", 409);
    }
    await this.#consumeApproval(session, "connect_credentials", approvalId);
    const reference = await secrets.put(tenantId, plaintext);
    try {
      const answers = { ...session.answers, credentialRef: validateAnswer("credentialRef", reference) };
      const nextStep = CREATION_STEPS[CREATION_STEPS.indexOf("credentialRef") + 1] ?? null;
      return await this.#save({
        ...session,
        answers,
        currentStep: nextStep,
        status: nextStep ? "in_progress" : "ready",
      });
    } catch (cause) {
      try {
        await secrets.delete(tenantId, reference);
      } catch {
        // The orphan is encrypted and tenant-bound; keep the original revision error.
      }
      throw cause;
    }
  }

  async createDraft(tenantId: TenantId, ownerId: UserId, sessionId: string): Promise<CreationSession> {
    const session = await this.#load(tenantId, ownerId, sessionId);
    if (session.status !== "ready") {
      throw new AppError("CONFLICT", "Complete all bot creation steps before saving a draft.", 409);
    }
    const answers = requireCompleteAnswers(session.answers);
    const botId = await this.#drafts.createDraft({
      tenantId,
      ownerId,
      idempotencyKey: `draft:${session.id}`,
      answers,
    });
    return this.#save({ ...session, status: "draft", botId });
  }

  async publish(tenantId: TenantId, ownerId: UserId, sessionId: string, approvalId?: string): Promise<CreationSession> {
    const session = await this.#load(tenantId, ownerId, sessionId);
    if (session.status !== "draft" || !session.botId) {
      throw new AppError("CONFLICT", "Only a saved bot draft can be published.", 409);
    }
    await this.#consumeApproval(session, "publish_bot", approvalId);
    await this.#drafts.publish({
      tenantId,
      ownerId,
      botId: session.botId,
      idempotencyKey: `publish:${session.id}`,
    });
    return this.#save({ ...session, status: "published" });
  }

  async #load(tenantId: TenantId, ownerId: UserId, sessionId: string): Promise<CreationSession> {
    const session = await this.#sessions.get(tenantId, ownerId, sessionId);
    if (!session) throw new AppError("NOT_FOUND", "Bot creation session was not found.", 404);
    return session;
  }

  async #save(session: CreationSession): Promise<CreationSession> {
    const updated: CreationSession = {
      ...session,
      revision: session.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.#sessions.save(updated, session.revision);
    return updated;
  }

  async #consumeApproval(session: CreationSession, action: CreationApprovalAction, approvalId?: string): Promise<void> {
    if (!approvalId) {
      throw new AppError("FORBIDDEN", `Explicit '${action}' approval is required.`, 403);
    }
    const consumed = await this.#approvals.consume({
      tenantId: session.tenantId,
      ownerId: session.ownerId,
      sessionId: session.id,
      action,
      approvalId,
    });
    if (!consumed) throw new AppError("FORBIDDEN", `The '${action}' approval is invalid or expired.`, 403);
  }
}

function approvalRequired(
  step: CreationStep,
  value: CreationAnswers[CreationStep],
): CreationApprovalAction | undefined {
  if (step === "credentialRef") return "connect_credentials";
  if (step === "visibility" && value !== "private") return "public_access";
  return undefined;
}

function validateAnswer<K extends CreationStep>(step: K, value: unknown): CreationAnswers[K] {
  switch (step) {
    case "name":
      return text(value, step, 2, 64) as CreationAnswers[K];
    case "description":
      return text(value, step, 1, 2000) as CreationAnswers[K];
    case "purpose":
      return text(value, step, 1, 2000) as CreationAnswers[K];
    case "audience":
      return text(value, step, 1, 1000) as CreationAnswers[K];
    case "personality":
      return text(value, step, 1, 8000) as CreationAnswers[K];
    case "providerId":
      return identifier(value, step) as CreationAnswers[K];
    case "endpoint":
      return httpsEndpoint(value) as CreationAnswers[K];
    case "model":
      return modelIdentifier(value, step) as CreationAnswers[K];
    case "imageModel":
    case "searchModel":
      return typeof value === "string" && ["", "skip", "none"].includes(value.trim().toLowerCase())
        ? ("" as CreationAnswers[K])
        : (modelIdentifier(value, step) as CreationAnswers[K]);
    case "credentialRef": {
      if (typeof value !== "string" || !/^secret_[a-f0-9]{32}$/.test(value)) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Use an opaque secret reference; raw credentials cannot be stored in a creation session.",
          400,
        );
      }
      return value as CreationAnswers[K];
    }
    case "skills":
    case "mcpConnections":
    case "integrations":
    case "scheduledTasks":
    case "privacySettings":
      return stringList(value, step) as CreationAnswers[K];
    case "memoryEnabled": {
      if (typeof value !== "boolean") throw invalid(step);
      return value as CreationAnswers[K];
    }
    case "visibility": {
      if (value !== "private" && value !== "shared" && value !== "public" && value !== "invitation")
        throw invalid(step);
      return value as CreationAnswers[K];
    }
    case "interfaces": {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((item) => item !== "telegram" && item !== "web_chat" && item !== "api")
      ) {
        throw invalid(step);
      }
      return [...new Set(value)] as unknown as CreationAnswers[K];
    }
  }
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw invalid(field);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw invalid(field);
  return trimmed;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw invalid(field);
  return result;
}

function httpsEndpoint(value: unknown): string {
  const endpoint = text(value, "endpoint", 1, 2048);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid("endpoint");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw invalid("endpoint");
  return url.toString().replace(/\/$/, "");
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== "string"))
    throw invalid(field);
  const parsed = value.map((item) => (item as string).trim());
  if (parsed.some((item) => item.length === 0 || item.length > 200)) throw invalid(field);
  return [...new Set(parsed)];
}

function modelIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalid(field);
  const model = value.trim();
  if (
    model.length < 1 ||
    model.length > 128 ||
    [...model].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw invalid(field);
  }
  return model;
}

function requireCompleteAnswers(answers: Partial<CreationAnswers>): CreationAnswers {
  if (CREATION_STEPS.some((step) => step !== "imageModel" && step !== "searchModel" && answers[step] === undefined)) {
    throw new AppError("VALIDATION_ERROR", "Creation session is missing required answers.", 400);
  }
  return {
    ...answers,
    imageModel: answers.imageModel ?? "",
    searchModel: answers.searchModel ?? "",
  } as CreationAnswers;
}

function invalid(field: string): AppError {
  return new AppError("VALIDATION_ERROR", `Invalid value for bot creation field '${field}'.`, 400);
}
