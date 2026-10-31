import { describe, expect, test } from "bun:test";
import {
  decodeGeneratedImageBase64,
  decodeGeneratedImageDataUrl,
  MAX_INLINE_IMAGE_BYTES,
} from "../../packages/core/src/image-data.js";

describe("generated inline image data", () => {
  test("accepts canonical PNG, JPEG, and WebP signatures", () => {
    expect(decodeGeneratedImageBase64("iVBORw0KGgo=")?.contentType).toBe("image/png");
    expect(decodeGeneratedImageBase64("/9j/")?.contentType).toBe("image/jpeg");
    expect(decodeGeneratedImageBase64("UklGRgAA//9XRUJQ")?.contentType).toBe("image/webp");
  });

  test("rejects malformed, mismatched, and oversized image data", () => {
    expect(decodeGeneratedImageBase64("not base64")).toBeUndefined();
    expect(decodeGeneratedImageBase64("aW1hZ2U=")).toBeUndefined();
    expect(decodeGeneratedImageDataUrl("data:image/jpeg;base64,iVBORw0KGgo=")).toBeUndefined();
    expect(
      decodeGeneratedImageBase64("iVBORw0KGgo=" + "A".repeat(Math.ceil((MAX_INLINE_IMAGE_BYTES + 2) / 3) * 4)),
    ).toBe(undefined);
  });
});
