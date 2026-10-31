/** Keep inline image output below the model response and encrypted D1 row limits. */
export const MAX_INLINE_IMAGE_BYTES = 720 * 1024;
export const MAX_INLINE_IMAGE_DATA_URL_CHARS = 1_000_000;

export type GeneratedImageContentType = "image/jpeg" | "image/png" | "image/webp";

export interface DecodedInlineImage {
  readonly bytes: Uint8Array;
  readonly contentType: GeneratedImageContentType;
  readonly dataUrl: string;
  readonly extension: "jpg" | "png" | "webp";
}

/** Decode only bounded canonical base64 whose bytes identify as a supported raster image. */
export function decodeGeneratedImageBase64(value: string): DecodedInlineImage | undefined {
  if (
    !value ||
    value.length > Math.ceil((MAX_INLINE_IMAGE_BYTES + 2) / 3) * 4 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return undefined;
  }
  try {
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    if (!binary.length || binary.length > MAX_INLINE_IMAGE_BYTES) return undefined;
    const canonical = btoa(binary);
    if (canonical.replace(/=+$/, "") !== value.replace(/=+$/, "")) return undefined;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const contentType = detectGeneratedImageContentType(bytes);
    if (!contentType) return undefined;
    const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp";
    const dataUrl = `data:${contentType};base64,${canonical}`;
    if (dataUrl.length > MAX_INLINE_IMAGE_DATA_URL_CHARS) return undefined;
    return { bytes, contentType, dataUrl, extension };
  } catch {
    return undefined;
  }
}

/** Validate an inline image data URL and its bytes before delivery or durable storage. */
export function decodeGeneratedImageDataUrl(value: string): DecodedInlineImage | undefined {
  if (value.length > MAX_INLINE_IMAGE_DATA_URL_CHARS) return undefined;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  const decoded = decodeGeneratedImageBase64(match[2]);
  if (!decoded || decoded.contentType !== match[1] || decoded.dataUrl !== value) return undefined;
  return decoded;
}

/** Lightweight source check for rendering a data URL already validated by the server. */
export function isGeneratedImageDataUrl(value: string): boolean {
  return (
    value.length <= MAX_INLINE_IMAGE_DATA_URL_CHARS &&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function detectGeneratedImageContentType(bytes: Uint8Array): GeneratedImageContentType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}
