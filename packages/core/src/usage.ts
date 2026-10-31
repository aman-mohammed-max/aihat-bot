import type { AgentEngine, Logger, UsageRepository } from "./ports.js";
import type { UsageRecord } from "./types.js";

/** Records successful agent requests without allowing analytics storage failures to break replies. */
export function createUsageTrackingAgentEngine(
  engine: AgentEngine,
  usage: UsageRepository,
  logger: Logger,
): AgentEngine {
  return {
    async respond(request, options) {
      const response = await engine.respond(request, {
        ...options,
        onModelRetry: async (event) => {
          try {
            await usage.recordModelRetry({
              ...event,
              id: `retry_${crypto.randomUUID().replaceAll("-", "")}`,
              tenantId: request.bot.tenantId,
              botId: request.bot.id,
              createdAt: new Date().toISOString(),
            });
          } catch {
            logger.warn("model_retry_analytics_failed", {
              botId: request.bot.id,
              providerId: request.bot.model.providerId,
            });
          }
          await options?.onModelRetry?.(event);
        },
      });
      const sample: UsageRecord = {
        id: `usage_${crypto.randomUUID().replaceAll("-", "")}`,
        tenantId: request.bot.tenantId,
        botId: request.bot.id,
        ...(request.actorContext?.platform === "api" || request.actorContext?.platform === "scheduled"
          ? { actorId: request.actorId }
          : {}),
        providerId: request.bot.model.providerId,
        model: request.bot.model.model,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        usageReported: response.usage !== undefined,
        createdAt: new Date().toISOString(),
      };
      try {
        await usage.recordUsage(sample);
      } catch {
        logger.warn("usage_record_failed", { botId: request.bot.id, providerId: request.bot.model.providerId });
      }
      return response;
    },
  };
}
