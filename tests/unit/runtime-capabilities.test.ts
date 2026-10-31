import { describe, expect, test } from "bun:test";
import { runtimeCapabilities as bunCapabilities } from "../../apps/bun-runtime/src/capabilities.js";
import { runtimeCapabilities as cloudflareCapabilities } from "../../apps/cloudflare-runtime/src/capabilities.js";
import { createInitialState } from "../../apps/dashboard/src/state.js";
import { capabilityLabel, securityView } from "../../apps/dashboard/src/views/workspace.js";

describe("unsupported attachment capabilities", () => {
  test("Bun and Cloudflare both report video parsing and scanned PDF OCR as unavailable", () => {
    for (const capabilities of [bunCapabilities, cloudflareCapabilities]) {
      expect(capabilities.features.telegramVideoParsing).toBe(false);
      expect(capabilities.features.scannedPdfOcr).toBe(false);
    }
  });

  test("the security dashboard names the unavailable features and explains them", () => {
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin: "https://factory.example.test" },
    });
    try {
      const state = createInitialState();
      state.capabilities = {
        runtime: "cloudflare",
        features: { telegramVideoParsing: false, scannedPdfOcr: false },
      };
      const view = securityView(state);
      expect(capabilityLabel("telegramVideoParsing")).toBe("Telegram video parsing");
      expect(capabilityLabel("scannedPdfOcr")).toBe("Scanned PDF OCR");
      expect(view).toContain("Telegram video parsing is not available.");
      expect(view).toContain("Scanned PDFs require OCR, which is not available.");
      expect(view).toContain('aria-label="Unavailable"');
    } finally {
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
      else Reflect.deleteProperty(globalThis, "location");
    }
  });
});
