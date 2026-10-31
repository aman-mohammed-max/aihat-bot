import { AppError } from "./errors.js";

export type ModelCatalogRole = "chat" | "image" | "search" | "audio";

export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: "chat" | "image" | "audio" | "other";
}

const MAX_CATALOG_BYTES = 1_048_576;
const MAX_MODELS = 500;

/** Fetches only an operator-approved OpenAI-compatible /models endpoint and never persists the supplied key. */
export async function fetchModelCatalog(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly role: ModelCatalogRole;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}): Promise<readonly ModelCatalogEntry[]> {
  const url = getModelsUrl(input.endpoint, input.allowedOrigins);
  if (!input.apiKey.trim() || new TextEncoder().encode(input.apiKey).byteLength > 65_536) {
    throw new AppError("VALIDATION_ERROR", "A provider API key is required to list models.", 400);
  }
  const timeoutMs = input.timeoutMs ?? 12_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new AppError("VALIDATION_ERROR", "Model-list timeout is invalid.", 500);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (input.fetch ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${input.apiKey}` },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", `Model provider returned HTTP ${response.status}.`, 502);
    }
    const payload = JSON.parse(await readBoundedText(response)) as unknown;
    return filterModelCatalog(parseModelCatalog(payload), input.role);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    if (controller.signal.aborted) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider did not return its model list in time.", 504, {
        cause,
      });
    }
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an invalid model list.", 502, { cause });
  } finally {
    clearTimeout(timeout);
  }
}

export function filterModelCatalog(
  models: readonly ModelCatalogEntry[],
  role: ModelCatalogRole,
): readonly ModelCatalogEntry[] {
  if (role === "image") return models.filter((model) => model.kind === "image");
  if (role === "audio") return models.filter((model) => model.kind === "audio");
  if (role === "chat") return models.filter((model) => model.kind !== "image" && model.kind !== "audio");
  return models;
}

function getModelsUrl(endpoint: string, allowedOrigins: ReadonlySet<string>): URL {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Model endpoint must be an absolute URL.", 400, { cause });
  }
  const allowed = new Set(
    [...allowedOrigins].map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return "";
      }
    }),
  );
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Model endpoint must use HTTPS and cannot contain credentials, query, or fragment.",
      400,
    );
  }
  if (!allowed.has(base.origin)) {
    throw new AppError("FORBIDDEN", "Model endpoint origin is not approved by the deployment network policy.", 403);
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/models`;
  return base;
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an oversized model list.", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an oversized model list.", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseModelCatalog(value: unknown): readonly ModelCatalogEntry[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Array.isArray(value.data)
        ? value.data
        : Array.isArray(value.models)
          ? value.models
          : undefined
      : undefined;
  if (!list) throw new AppError("DEPENDENCY_UNAVAILABLE", "Model provider returned an invalid model list.", 502);
  const result: ModelCatalogEntry[] = [];
  const ids = new Set<string>();
  for (const item of list.slice(0, MAX_MODELS)) {
    const raw = typeof item === "string" ? { id: item } : isRecord(item) ? item : undefined;
    if (!raw) continue;
    const id = typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : "";
    if (!id.trim() || id.length > 128 || hasControlCharacters(id) || ids.has(id)) continue;
    ids.add(id);
    const name = typeof raw.name === "string" && !hasControlCharacters(raw.name) ? raw.name.slice(0, 128) : id;
    result.push({ id, name, kind: classifyModel(raw, id) });
  }
  return result;
}

function classifyModel(raw: Record<string, unknown>, id: string): ModelCatalogEntry["kind"] {
  const architecture = isRecord(raw.architecture) ? raw.architecture : {};
  const values = [
    raw.type,
    raw.modality,
    raw.task,
    raw.pipeline_tag,
    raw.category,
    raw.mode,
    raw.output_modalities,
    raw.capabilities,
    architecture.modality,
    architecture.output_modalities,
  ];
  const metadata = values
    .flatMap((item) => (Array.isArray(item) ? item : [item]))
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();
  if (
    /image|text-to-image|image-generation/.test(metadata) ||
    /dall-?e|gpt-image|flux|stable-?diffusion|sdxl|(^|[-_/])sd-?3|imagen|ideogram|recraft|kandinsky|playground-v/.test(
      id.toLowerCase(),
    )
  ) {
    return "image";
  }
  if (
    /audio|transcri|speech|\basr\b|\bstt\b/.test(metadata) ||
    /whisper|transcri|speech-to-text|audio[-_/]?(in|transcri|speech)/.test(id.toLowerCase())
  ) {
    return "audio";
  }
  if (/chat|text|language|llm|completion/.test(metadata) || !metadata) return "chat";
  return "other";
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
