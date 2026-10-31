import { DurableObject } from "cloudflare:workers";

interface ConversationTurnLeaseRow {
  [key: string]: SqlStorageValue;
  lease_token: string;
  lease_until: number;
}

const TURN_LEASE_MS = 30 * 60 * 1_000;
const MAX_REQUEST_BYTES = 512;

/** Per-conversation SQLite coordinator; D1 remains the source of truth for message history. */
export class ConversationCoordinator extends DurableObject<Env> {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#state = state;
    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_turn (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        lease_token TEXT NOT NULL,
        lease_until INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", storage: "durable-object-sqlite" });
    }
    if (request.method !== "POST") return methodNotAllowed();
    if (url.pathname !== "/turn/acquire" && url.pathname !== "/turn/release") {
      return new Response("Not found.", { status: 404, headers: noStore });
    }
    const token = await readLeaseToken(request);
    if (token instanceof Response) return token;
    return url.pathname === "/turn/acquire" ? this.#acquire(token) : this.#release(token);
  }

  async alarm(): Promise<void> {
    const lease = this.#currentLease();
    if (!lease || lease.lease_until <= Date.now()) {
      this.#state.storage.sql.exec("DELETE FROM active_turn WHERE singleton = 1");
      await this.#state.storage.deleteAlarm();
      return;
    }
    await this.#state.storage.setAlarm(lease.lease_until);
  }

  async #acquire(token: string): Promise<Response> {
    const now = Date.now();
    const current = this.#currentLease();
    if (current && current.lease_until > now) {
      return json({ error: "conversation_busy", retryAfterMs: Math.max(1, current.lease_until - now) }, 409);
    }
    const leaseUntil = now + TURN_LEASE_MS;
    this.#state.storage.sql.exec(
      `INSERT INTO active_turn (singleton, lease_token, lease_until) VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET lease_token = excluded.lease_token, lease_until = excluded.lease_until`,
      token,
      leaseUntil,
    );
    await this.#state.storage.setAlarm(leaseUntil);
    return new Response(null, { status: 204, headers: noStore });
  }

  async #release(token: string): Promise<Response> {
    const current = this.#currentLease();
    if (!current) {
      await this.#state.storage.deleteAlarm();
      return new Response(null, { status: 204, headers: noStore });
    }
    if (current.lease_token !== token) return json({ error: "lease_mismatch" }, 409);
    this.#state.storage.sql.exec("DELETE FROM active_turn WHERE singleton = 1 AND lease_token = ?", token);
    await this.#state.storage.deleteAlarm();
    return new Response(null, { status: 204, headers: noStore });
  }

  #currentLease(): ConversationTurnLeaseRow | undefined {
    return this.#state.storage.sql
      .exec<ConversationTurnLeaseRow>("SELECT lease_token, lease_until FROM active_turn WHERE singleton = 1")
      .toArray()[0];
  }
}

async function readLeaseToken(request: Request): Promise<string | Response> {
  if (request.headers.get("content-type") !== "application/json" || !request.body) {
    return json({ error: "invalid_request" }, 400);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    return json({ error: "invalid_request" }, 400);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return json({ error: "invalid_request" }, 400);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let input: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1) {
    return json({ error: "invalid_request" }, 400);
  }
  const leaseToken = (input as Record<string, unknown>).leaseToken;
  if (typeof leaseToken !== "string" || !/^[a-f0-9-]{36}$/.test(leaseToken)) {
    return json({ error: "invalid_request" }, 400);
  }
  return leaseToken;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: noStore });
}

function methodNotAllowed(): Response {
  return new Response("Method not allowed.", {
    status: 405,
    headers: { ...noStore, allow: "GET, POST" },
  });
}

const noStore = { "cache-control": "no-store" } as const;
