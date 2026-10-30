import type { Database, SQLQueryBindings } from "bun:sqlite";

/** Small D1-compatible adapter for exercising the Cloudflare repository against SQLite in tests. */
export class SqliteD1 {
  constructor(private readonly db: Database) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.db, query) as unknown as D1PreparedStatement;
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const runBatch = this.db.transaction(() =>
      statements.map((statement) => (statement as unknown as SqliteD1Statement).execute()),
    );
    return Promise.resolve(runBatch() as D1Result<T>[]);
  }
}

class SqliteD1Statement {
  #bindings: SQLQueryBindings[] = [];

  constructor(
    private readonly db: Database,
    private readonly query: string,
  ) {}

  bind(...bindings: SQLQueryBindings[]): this {
    this.#bindings = bindings;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.db.query<T, SQLQueryBindings[]>(this.query).get(...this.#bindings) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = this.db.query<T, SQLQueryBindings[]>(this.query).all(...this.#bindings);
    return { success: true, results, meta: { changes: 0 } } as unknown as D1Result<T>;
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.db.query(this.query).run(...this.#bindings);
    return { success: true, results: [], meta: { changes: result.changes } } as unknown as D1Result<T>;
  }

  execute<T>(): D1Result<T> {
    const result = this.db.query(this.query).run(...this.#bindings);
    return { success: true, results: [], meta: { changes: result.changes } } as unknown as D1Result<T>;
  }
}
