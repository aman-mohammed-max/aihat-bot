import { AppError } from "./errors.js";

/** Reads a request body incrementally and stops as soon as it exceeds its byte budget. */
export async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
  tooLargeMessage = "Request body is too large.",
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Request body limit must be a non-negative safe integer.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw new AppError("VALIDATION_ERROR", tooLargeMessage, 413);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size limit is still enforced when cancellation fails.
        }
        throw new AppError("VALIDATION_ERROR", tooLargeMessage, 413);
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body could not be read.", 400, { cause });
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid UTF-8.", 400, { cause });
  }
}
