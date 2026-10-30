export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = "API_ERROR") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let readToken = (): string => "";

export function configureTokenReader(reader: () => string): void {
  readToken = reader;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = readToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");

  const response = await fetch(path, { ...init, headers, cache: "no-store", credentials: "same-origin" });
  if (response.status === 204) return undefined as T;

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const error = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const message = typeof error.message === "string" ? error.message : `Request failed (${response.status}).`;
    const code = typeof error.error === "string" ? error.error : "API_ERROR";
    throw new ApiError(message, response.status, code);
  }
  return data as T;
}

export async function apiStream<T>(path: string, body: unknown, onDelta: (delta: string) => void): Promise<T> {
  const headers = new Headers({
    accept: "text/event-stream",
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  const token = readToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    let error: unknown;
    try {
      error = await response.json();
    } catch {
      error = undefined;
    }
    const fields = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    throw new ApiError(
      typeof fields.message === "string" ? fields.message : `Request failed (${response.status}).`,
      response.status,
      typeof fields.error === "string" ? fields.error : "API_ERROR",
    );
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
    throw new ApiError("The server did not return a streaming response.", 502, "INVALID_STREAM");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  const dataLines: string[] = [];
  let completed: T | undefined;
  const processEvent = (): void => {
    if (dataLines.length === 0) {
      currentEvent = "message";
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      throw new ApiError("The server returned an invalid stream event.", 502, "INVALID_STREAM");
    }
    dataLines.length = 0;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ApiError("The server returned an invalid stream event.", 502, "INVALID_STREAM");
    }
    const fields = payload as Record<string, unknown>;
    if (currentEvent === "delta") {
      if (typeof fields.delta !== "string") throw new ApiError("The server returned an invalid text delta.", 502);
      onDelta(fields.delta);
    } else if (currentEvent === "done") {
      completed = payload as T;
    } else if (currentEvent === "error") {
      throw new ApiError(
        typeof fields.message === "string" ? fields.message : "The agent stream failed.",
        502,
        typeof fields.error === "string" ? fields.error : "STREAM_FAILED",
      );
    }
    currentEvent = "message";
  };
  const processLine = (line: string): void => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized === "") {
      processEvent();
    } else if (normalized.startsWith("event:")) {
      currentEvent = normalized.slice(6).trim() || "message";
    } else if (normalized.startsWith("data:")) {
      dataLines.push(normalized.slice(5).replace(/^ /, ""));
    }
  };

  try {
    while (completed === undefined) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && completed === undefined) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (done) {
        if (buffer.length > 0) processLine(buffer);
        processEvent();
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (completed === undefined)
    throw new ApiError("The agent stream ended before completion.", 502, "INCOMPLETE_STREAM");
  return completed;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
