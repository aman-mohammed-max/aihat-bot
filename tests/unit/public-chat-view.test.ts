import { describe, expect, test } from "bun:test";
import { publicChatLoginView, publicChatView } from "../../apps/dashboard/src/views/public-chat.js";
import type { PublicChatBot } from "../../apps/dashboard/src/types.js";

const bot: PublicChatBot = {
  id: "bot_123e4567-e89b-12d3-a456-426614174000",
  slug: "safe-helper",
  name: "Helper <script>alert(1)</script>",
  description: "Answers questions & keeps private configuration hidden.",
  visibility: "public",
};

describe("public web chat views", () => {
  test("renders the sign-in page with escaped public metadata and token fallback", () => {
    const html = publicChatLoginView(bot, "", "123456789");

    expect(html).toContain("Continue with Telegram");
    expect(html).toContain("API token");
    expect(html).toContain("Helper &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("renders signed-in chat messages and safe generated image markup", () => {
    const html = publicChatView({
      bot,
      busy: false,
      lines: [
        { role: "user", content: "Hello <img src=x>" },
        {
          role: "assistant",
          content: "Here is the result.",
          attachments: [
            { kind: "image", url: "https://images.example.test/generated.png", alt: "A picture" },
            { kind: "image", url: "javascript:alert(1)", alt: "Unsafe" },
          ],
        },
      ],
    });

    expect(html).toContain("Hello &lt;img src=x&gt;");
    expect(html).toContain('src="https://images.example.test/generated.png"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain('id="public-chat-form"');
    expect(html).not.toContain("<img src=x>");
  });
});
