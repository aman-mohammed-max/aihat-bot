import { describe, expect, test } from "bun:test";
import { FactoryAssistant } from "../../packages/core/src/factory-assistant.js";

const profile = {
  name: "Meal Guide",
  description: "A practical meal planning helper.",
  purpose: "Suggest meals that fit a user's preferences.",
  audience: "People who cook at home.",
  personality: "Be practical, kind, and concise.\nUse short examples when helpful.",
};

describe("factory AI drafting", () => {
  test("uses the configured OpenAI-compatible endpoint and validates the generated profile", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const assistant = new FactoryAssistant({
      endpoint: "https://llm.example.test/v1/",
      token: "factory-secret",
      model: "small-model",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({ choices: [{ message: { content: JSON.stringify(profile) } }] });
      },
    });

    const result = await assistant.generate("A meal planning bot.");

    expect(result).toEqual(profile);
    expect(capturedUrl).toBe("https://llm.example.test/v1/chat/completions");
    expect(capturedInit?.redirect).toBe("error");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer factory-secret");
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({ model: "small-model" });
  });

  test("rejects invalid endpoints and malformed model output", async () => {
    expect(
      () =>
        new FactoryAssistant({
          endpoint: "http://llm.example.test/v1",
          token: "factory-secret",
          model: "small-model",
        }),
    ).toThrow();

    const assistant = new FactoryAssistant({
      endpoint: "https://llm.example.test/v1",
      token: "factory-secret",
      model: "small-model",
      fetch: async () => Response.json({ choices: [{ message: { content: "{broken" } }] }),
    });
    await expect(assistant.generate("A bot")).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Factory LLM did not return a valid bot profile.",
    });
  });

  test("validates the idea before making an upstream request", async () => {
    let called = false;
    const assistant = new FactoryAssistant({
      endpoint: "https://llm.example.test/v1",
      token: "factory-secret",
      model: "small-model",
      fetch: async () => {
        called = true;
        return Response.json({ choices: [{ message: { content: JSON.stringify(profile) } }] });
      },
    });
    await expect(assistant.generate(" ")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(called).toBe(false);
  });
});
