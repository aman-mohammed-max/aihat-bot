import { describe, expect, test } from "bun:test";
import { requestSecretRotationPage } from "../../apps/cloudflare-runtime/src/secret-rotation-client.js";

describe("Cloudflare secret rotation client", () => {
  test("rejects redirects on credentialed requests and validates the page", async () => {
    let capturedInit: RequestInit | undefined;
    const page = await requestSecretRotationPage({
      endpoint: new URL("https://worker.example.test/v1/secret-rotation"),
      authorizationToken: "rotation-token-value",
      mode: "dry_run",
      fetch: async (_input, init) => {
        capturedInit = init;
        return Response.json({
          mode: "dry_run",
          activeKeyId: "key-2026",
          scanned: 4,
          needingRotation: 2,
          rotated: 0,
          concurrentlyChanged: 0,
        });
      },
    });

    expect(capturedInit?.redirect).toBe("error");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer rotation-token-value");
    expect(page).toMatchObject({ mode: "dry_run", activeKeyId: "key-2026", scanned: 4 });
  });

  test("does not echo upstream response text that could contain the bearer token", async () => {
    const secret = "rotation-token-value";
    await expect(
      requestSecretRotationPage({
        endpoint: new URL("https://worker.example.test/v1/secret-rotation"),
        authorizationToken: secret,
        mode: "apply",
        fetch: async () => Response.json({ message: `Invalid authorization: ${secret}` }, { status: 401 }),
      }),
    ).rejects.toThrow(/^Cloudflare secret rotation failed \(HTTP 401\)\.$/);
  });
});
