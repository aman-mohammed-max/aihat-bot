import { describe, expect, test } from "bun:test";
import { createInitialState } from "../../apps/dashboard/src/state.js";
import type { Bot } from "../../apps/dashboard/src/types.js";
import { botManagementView } from "../../apps/dashboard/src/views/bot.js";

describe("bot audio transcription readiness", () => {
  test("explains when the runtime blocks audio and when a bot still needs a model", () => {
    const state = createInitialState();
    state.activeBot = createBot();
    state.botTab = "configuration";
    state.capabilities = {
      runtime: "cloudflare",
      features: { telegramAudioTranscription: false },
    };

    expect(botManagementView(state)).toContain(
      "Telegram audio transcription is disabled on this runtime until malware scanning and HTTPS provider access are configured.",
    );

    state.capabilities.features.telegramAudioTranscription = true;
    expect(botManagementView(state)).toContain(
      "This runtime supports Telegram audio transcription. Choose a transcription model to enable it for this bot.",
    );

    state.activeBot.model.audioModel = "whisper-1";
    expect(botManagementView(state)).toContain("Telegram audio transcription is available for this bot.");
  });
});

function createBot(): Bot {
  return {
    id: "bot_audio",
    name: "Audio assistant",
    description: "Transcribes voice messages.",
    systemPrompt: "You are an audio assistant.",
    memoryEnabled: false,
    model: {
      providerId: "openai-compatible",
      model: "chat-model",
      hasCredential: true,
    },
    visibility: "private",
    status: "published",
    version: 1,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
  };
}
