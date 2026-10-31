import { describe, expect, test } from "bun:test";
import { withDashboardSecurityHeaders } from "../../packages/core/src/dashboard-security.js";

describe("dashboard response security headers", () => {
  test("restricts page resources and keeps Telegram popup login compatible", async () => {
    const secured = withDashboardSecurityHeaders(
      new Response("<html>dashboard</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    expect(secured.headers.get("cache-control")).toBe("no-store");
    expect(secured.headers.get("referrer-policy")).toBe("no-referrer");
    expect(secured.headers.get("x-content-type-options")).toBe("nosniff");
    expect(secured.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
    const policy = secured.headers.get("content-security-policy");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' https://telegram.org https://oauth.telegram.org");
    expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(policy).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect(policy).toContain("img-src 'self' https: data:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-eval");
    expect(await secured.text()).toBe("<html>dashboard</html>");
  });
});
