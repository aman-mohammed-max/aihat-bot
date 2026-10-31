import { AppError } from "@aihat/core";
import type { AgentEngine, Logger } from "@aihat/core";
import type { AgentRequest, AgentResponse, ModelRetryObservation } from "@aihat/core";
import type { ConversationCoordinator } from "./conversation-coordinator.js";

/** Serializes turns per conversation through a DO while keeping queryable message history in D1. */
export class CloudflareConversationAgentEngine implements AgentEngine {
  readonly #engine: AgentEngine;
  readonly #namespace: DurableObjectNamespace<ConversationCoordinator>;
  readonly #logger: Pick<Logger, "warn">;

  constructor(
    engine: AgentEngine,
    namespace: DurableObjectNamespace<ConversationCoordinator>,
    logger: Pick<Logger, "warn">,
  ) {
    this.#engine = engine;
    this.#namespace = namespace;
    this.#logger = logger;
  }

  async respond(
    request: AgentRequest,
    options?: {
      readonly onTextDelta?: (delta: string) => void;
      readonly onModelRetry?: (event: ModelRetryObservation) => void | Promise<void>;
    },
  ): Promise<AgentResponse> {
    const identity = [request.bot.tenantId, request.bot.id, request.conversationId];
    if (identity.some((value) => !/^[A-Za-z0-9_-]{1,128}$/.test(value))) {
      throw new AppError("VALIDATION_ERROR", "Conversation identity is invalid.", 400);
    }
    const id = this.#namespace.idFromName(`conversation:${identity.join(":")}`);
    const stub = this.#namespace.get(id);
    const leaseToken = crypto.randomUUID();
    let acquired: Response;
    try {
      acquired = await stub.fetch("https://conversation-coordinator/turn/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (cause) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Conversation coordination is unavailable.", 503, { cause });
    }
    if (acquired.status === 409) {
      throw new AppError("CONFLICT", "Another turn is already processing this conversation. Retry shortly.", 409);
    }
    if (!acquired.ok) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Conversation coordination could not acquire the turn.", 503);
    }

    try {
      return await this.#engine.respond(request, options);
    } finally {
      await this.#release(stub, leaseToken, request);
    }
  }

  async #release(
    stub: DurableObjectStub<ConversationCoordinator>,
    leaseToken: string,
    request: AgentRequest,
  ): Promise<void> {
    try {
      const response = await stub.fetch("https://conversation-coordinator/turn/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken }),
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return;
      this.#logger.warn("conversation_turn_release_failed", {
        botId: request.bot.id,
        conversationId: request.conversationId,
        status: response.status,
      });
    } catch {
      this.#logger.warn("conversation_turn_release_failed", {
        botId: request.bot.id,
        conversationId: request.conversationId,
      });
    }
  }
}
