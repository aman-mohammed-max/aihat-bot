import { describe, expect, test } from "bun:test";
import { createInitialState } from "../../apps/dashboard/src/state.js";
import type { Bot } from "../../apps/dashboard/src/types.js";
import { pageTitle } from "../../apps/dashboard/src/views/shell.js";
import { modelProvidersView } from "../../apps/dashboard/src/views/workspace.js";

function makeBot(id: string, name: string, model: Bot["model"], collaboratorRole?: Bot["collaboratorRole"]): Bot {
  return {
    id,
    name,
    description: "Test assistant",
    systemPrompt: "Be useful",
    memoryEnabled: false,
    model,
    visibility: "private",
    status: "draft",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(collaboratorRole ? { collaboratorRole } : {}),
  };
}

describe("dashboard model providers", () => {
  test("summarizes owner bot providers, endpoints, model roles, and credential presence", () => {
    const state = createInitialState();
    const alpha = makeBot("bot_alpha", "Alpha", {
      providerId: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      model: "chat-model",
      imageModel: "image-model",
      searchModel: "search-model",
      audioModel: "audio-model",
      hasCredential: true,
    });
    Object.assign(alpha.model, { apiKey: "raw-provider-key-must-not-render" });
    state.bots = [
      alpha,
      makeBot("bot_beta", "Beta", {
        providerId: "openai-compatible",
        endpoint: "https://api.example.test/v1",
        model: "second-chat-model",
        hasCredential: false,
      }),
      makeBot("bot_default", "Default endpoint", {
        providerId: "openai-compatible",
        model: "default-chat-model",
        hasCredential: false,
      }),
      makeBot(
        "bot_shared",
        "Shared bot that must stay out",
        {
          providerId: "private-collaborator-provider",
          endpoint: "https://private.example.test/v1",
          model: "private-collaborator-model",
          hasCredential: true,
        },
        "viewer",
      ),
    ];

    const view = modelProvidersView(state);

    expect(pageTitle("models").title).toBe("Model providers");
    expect(view).toContain("Provider configurations");
    expect(view).toContain("https://api.example.test/v1");
    expect(view).toContain("Provider default");
    expect(view).toContain("chat-model");
    expect(view).toContain("image-model");
    expect(view).toContain("search-model");
    expect(view).toContain("audio-model");
    expect(view).toContain("Credential encrypted");
    expect(view).not.toContain("raw-provider-key-must-not-render");
    expect(view).toContain('data-route="bot/bot_alpha/configuration"');
    expect(view).not.toContain("Shared bot that must stay out");
    expect(view).not.toContain("private-collaborator-provider");
    expect(view).not.toContain("private.example.test");
    expect(view).not.toContain("private-collaborator-model");
  });

  test("shows a create-bot action when the account owns no bots", () => {
    const view = modelProvidersView(createInitialState());

    expect(view).toContain("No model providers configured");
    expect(view).toContain('data-action="navigate-create"');
  });
});
