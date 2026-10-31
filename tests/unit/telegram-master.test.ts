import { describe, expect, test } from "bun:test";
import {
  BotFactory,
  CreationApprovalService,
  FactoryAssistant,
  TelegramMasterBot,
} from "../../packages/core/src/index.js";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import type { TenantId, UserId } from "../../packages/core/src/types.js";

const webhookSecret = "a".repeat(64);

describe("Telegram master bot onboarding", () => {
  test("persists conversational factory progress and hands sensitive work to the Mini App", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    const factory = new BotFactory({
      sessions: repositories.sessions,
      approvals: new CreationApprovalService(repositories.creationApprovals),
      drafts: repositories,
    });
    const sent: Record<string, unknown>[] = [];
    const bot = new TelegramMasterBot({
      token: "123456789:master-bot-test-token",
      webhookSecret,
      webhookBaseUrl: "https://factory.example.test",
      accounts: repositories.telegramAuth,
      sessions: repositories.masterBot,
      factory,
      bots: repositories,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        return Response.json({ ok: true, result: true });
      },
    });

    try {
      const first = await sendUpdate(bot, 100, "/create");
      expect(first.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toContain("What should your bot be called?");

      const duplicate = await sendUpdate(bot, 100, "/create");
      expect(duplicate.status).toBe(200);
      expect(sent).toHaveLength(1);

      const answers = [
        "My Helper Bot",
        "A concise assistant for everyday questions.",
        "Answer everyday questions.",
        "Independent makers.",
        "Clear, careful, and friendly.",
        "openai",
        "https://api.openai.com/v1",
        "gpt-4o-mini",
      ];
      for (let index = 0; index < answers.length; index += 1) {
        const response = await sendUpdate(bot, 101 + index, answers[index] ?? "");
        expect(response.status).toBe(200);
      }

      const credentialsReply = sent.at(-1);
      expect(credentialsReply?.text).toContain("add it in the Mini App");
      const replyMarkup = credentialsReply?.reply_markup as {
        inline_keyboard: Array<Array<{ web_app: { url: string } }>>;
      };
      const appUrl = new URL(replyMarkup.inline_keyboard[0]?.[0]?.web_app.url ?? "https://invalid.test");
      expect(appUrl.pathname).toBe("/miniapp/");
      expect(appUrl.searchParams.get("factorySession")).toMatch(/^factory_/);
      expect(appUrl.hash).toBe("#/create");

      const secret = "sk-test-do-not-accept-in-chat";
      await sendUpdate(bot, 110, secret);
      expect(sent.at(-1)?.text).toContain("don’t send model keys in chat");
      expect(JSON.stringify(sent)).not.toContain(secret);

      const mapping = await repositories.masterBot.getSession(456789123);
      if (!mapping) throw new Error("Master bot session mapping was not saved.");
      expect(mapping.telegramUserId).toBe(456789123);
      expect(mapping.tenantId.startsWith("ten_")).toBe(true);
      expect(mapping.ownerId.startsWith("usr_")).toBe(true);
      expect(mapping.sessionId.startsWith("factory_")).toBe(true);
      const accountOwner = mapping.ownerId as UserId;
      const accountTenant = mapping.tenantId as TenantId;
      const session = await factory.get(accountTenant, accountOwner, mapping.sessionId);
      expect(session.currentStep).toBe("credentialRef");
    } finally {
      db.close();
    }
  });

  test("uses the factory AI to prefill creative fields from a Telegram bot idea", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    const sent: Record<string, unknown>[] = [];
    const idea = "A nutrition helper for busy students that suggests affordable meals.";
    const profile = {
      name: "Student Meal Guide",
      description: "An assistant for practical, affordable meal ideas.",
      purpose: "Suggest meals that fit a student's budget and schedule.",
      audience: "Students looking for quick and affordable food.",
      personality: "Friendly, practical, and careful about nutrition advice.",
    };
    const assistant = new FactoryAssistant({
      endpoint: "https://factory.example.test/v1",
      token: "factory-test-token",
      model: "factory-model",
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer factory-test-token");
        const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
        expect(body.model).toBe("factory-model");
        expect(body.messages.at(-1)?.content).toBe(idea);
        return Response.json({ choices: [{ message: { content: JSON.stringify(profile) } }] });
      },
    });
    const bot = new TelegramMasterBot({
      token: "123456789:master-bot-test-token",
      webhookSecret,
      webhookBaseUrl: "https://factory.example.test",
      accounts: repositories.telegramAuth,
      sessions: repositories.masterBot,
      factory: new BotFactory({
        sessions: repositories.sessions,
        approvals: new CreationApprovalService(repositories.creationApprovals),
        drafts: repositories,
      }),
      bots: repositories,
      assistant,
      fetch: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      },
    });

    try {
      const response = await sendUpdate(bot, 150, `/create ${idea}`);
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toContain("AI draft ready for “Student Meal Guide”");
      expect(sent[0]?.text).toContain("Which model provider should it use?");
      expect(sent[0]?.text).toContain("nothing has been published");

      const mapping = await repositories.masterBot.getSession(456789123);
      if (!mapping) throw new Error("AI-drafted master bot session mapping was not saved.");
      const session = await new BotFactory({
        sessions: repositories.sessions,
        approvals: new CreationApprovalService(repositories.creationApprovals),
        drafts: repositories,
      }).get(mapping.tenantId, mapping.ownerId, mapping.sessionId);
      expect(session.status).toBe("in_progress");
      expect(session.currentStep).toBe("providerId");
      expect(session.answers).toMatchObject(profile);
      expect(session.botId).toBeUndefined();
      expect(await repositories.listOwned(mapping.tenantId, mapping.ownerId)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("rejects forged webhook secrets before creating a workspace", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    const bot = new TelegramMasterBot({
      token: "123456789:master-bot-test-token",
      webhookSecret,
      webhookBaseUrl: "https://factory.example.test",
      accounts: repositories.telegramAuth,
      sessions: repositories.masterBot,
      factory: new BotFactory({
        sessions: repositories.sessions,
        approvals: new CreationApprovalService(repositories.creationApprovals),
        drafts: repositories,
      }),
      bots: repositories,
      fetch: async () => Response.json({ ok: true, result: true }),
    });
    try {
      const response = await bot.handleWebhook(
        new Request("https://factory.example.test/webhooks/telegram/master", {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
          body: JSON.stringify({ update_id: 1, message: { text: "/create" } }),
        }),
      );
      expect(response.status).toBe(401);
      expect(db.query("SELECT count(*) AS count FROM users").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test("rate limits authenticated private-chat messages per user and resets each minute", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    const sent: Record<string, unknown>[] = [];
    let currentTime = Date.parse("2026-10-30T12:00:00.000Z");
    const bot = new TelegramMasterBot({
      token: "123456789:master-bot-test-token",
      webhookSecret,
      webhookBaseUrl: "https://factory.example.test",
      accounts: repositories.telegramAuth,
      sessions: repositories.masterBot,
      factory: new BotFactory({
        sessions: repositories.sessions,
        approvals: new CreationApprovalService(repositories.creationApprovals),
        drafts: repositories,
      }),
      bots: repositories,
      requestsPerMinute: 2,
      now: () => new Date(currentTime),
      fetch: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      },
    });
    try {
      expect((await sendUpdate(bot, 200, "/help")).status).toBe(200);
      expect((await sendUpdate(bot, 201, "/help")).status).toBe(200);
      expect(sent).toHaveLength(2);

      expect((await sendUpdate(bot, 202, "/help")).status).toBe(200);
      expect(sent).toHaveLength(2);
      expect(db.query("SELECT actor_id, request_count FROM telegram_master_request_usage").get()).toMatchObject({
        actor_id: expect.stringMatching(/^usr_[a-f0-9]{32}$/),
        request_count: 2,
      });

      currentTime += 60_000;
      expect((await sendUpdate(bot, 203, "/help")).status).toBe(200);
      expect(sent).toHaveLength(3);
      expect(db.query("SELECT request_count FROM telegram_master_request_usage").get()).toEqual({ request_count: 1 });
    } finally {
      db.close();
    }
  });
});

async function sendUpdate(bot: TelegramMasterBot, updateId: number, text: string): Promise<Response> {
  return bot.handleWebhook(
    new Request("https://factory.example.test/webhooks/telegram/master", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": webhookSecret },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          text,
          chat: { id: 456789123, type: "private" },
          from: { id: 456789123, is_bot: false, first_name: "Morgan" },
        },
      }),
    }),
  );
}
