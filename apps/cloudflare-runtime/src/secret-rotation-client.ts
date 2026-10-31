export interface SecretRotationCursor {
  readonly tenantId: string;
  readonly reference: string;
}

export interface SecretRotationPage {
  readonly mode: string;
  readonly activeKeyId: string;
  readonly scanned: number;
  readonly needingRotation: number;
  readonly rotated: number;
  readonly concurrentlyChanged: number;
  readonly nextCursor?: SecretRotationCursor;
}

export async function requestSecretRotationPage(input: {
  readonly endpoint: URL;
  readonly authorizationToken: string;
  readonly mode: "dry_run" | "apply";
  readonly after?: SecretRotationCursor;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<SecretRotationPage> {
  const response = await (input.fetch ?? fetch)(input.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.authorizationToken}`,
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify({ mode: input.mode, limit: 100, ...(input.after ? { after: input.after } : {}) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });

  let value: unknown;
  try {
    value = JSON.parse(await readBoundedText(response)) as unknown;
  } catch {
    throw new Error(`Cloudflare secret rotation returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`Cloudflare secret rotation failed (HTTP ${response.status}).`);
  }
  if (!isRecord(value)) throw new Error("Cloudflare secret rotation returned an invalid page.");

  const page = parsePage(value);
  if (page.mode !== input.mode) throw new Error("Cloudflare secret rotation returned a mismatched mode.");
  return page;
}

async function readBoundedText(response: Response): Promise<string> {
  const maxBytes = 256 * 1024;
  const contentLength = response.headers.get("content-length");
  const advertisedLength = contentLength === null ? undefined : Number(contentLength);
  if (
    advertisedLength !== undefined &&
    (!Number.isSafeInteger(advertisedLength) || advertisedLength < 0 || advertisedLength > maxBytes)
  ) {
    await response.body?.cancel();
    throw new Error("Response exceeded the supported size.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Response exceeded the supported size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parsePage(value: Record<string, unknown>): SecretRotationPage {
  if (
    typeof value.mode !== "string" ||
    typeof value.activeKeyId !== "string" ||
    !Number.isSafeInteger(value.scanned) ||
    !Number.isSafeInteger(value.needingRotation) ||
    !Number.isSafeInteger(value.rotated) ||
    !Number.isSafeInteger(value.concurrentlyChanged)
  ) {
    throw new Error("Cloudflare secret rotation returned an invalid page.");
  }
  let nextCursor: SecretRotationCursor | undefined;
  if (value.nextCursor !== undefined) {
    if (
      !isRecord(value.nextCursor) ||
      typeof value.nextCursor.tenantId !== "string" ||
      typeof value.nextCursor.reference !== "string"
    ) {
      throw new Error("Cloudflare secret rotation returned an invalid cursor.");
    }
    nextCursor = { tenantId: value.nextCursor.tenantId, reference: value.nextCursor.reference };
  }
  return {
    mode: value.mode,
    activeKeyId: value.activeKeyId,
    scanned: value.scanned as number,
    needingRotation: value.needingRotation as number,
    rotated: value.rotated as number,
    concurrentlyChanged: value.concurrentlyChanged as number,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
