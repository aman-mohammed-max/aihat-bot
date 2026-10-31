import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createDefaultNativeSkillRegistry } from "../../packages/core/src/native-skills.js";
import type { SkillCatalogPublication } from "../../packages/core/src/types.js";

describe("reviewed native skill registry", () => {
  test("ships catalog metadata that exactly matches the SQLite seed migration", () => {
    const db = new Database(":memory:");
    try {
      db.exec(readFileSync(new URL("../../migrations/sqlite/0001_initial.sql", import.meta.url), "utf8"));
      db.exec(
        readFileSync(new URL("../../migrations/sqlite/0027_native_text_statistics.sql", import.meta.url), "utf8"),
      );
      const row = db
        .query<
          {
            id: string;
            name: string;
            version: string;
            author: string;
            category: string;
            description: string;
            execution_type: "native";
            input_schema_json: string;
            output_schema_json: string;
            permissions_json: string;
            definition_json: string;
          },
          []
        >(`
          SELECT id, name, version, author, category, description, execution_type,
                 input_schema_json, output_schema_json, permissions_json, definition_json
          FROM skills WHERE id = 'aihat.text.statistics.v1' AND tenant_id IS NULL
        `)
        .get();
      if (!row) throw new Error("The native skill seed migration did not insert its catalog row.");
      const storedOptions = JSON.parse(row.definition_json) as Pick<
        SkillCatalogPublication,
        "configuration" | "timeoutMs" | "rateLimit" | "retryPolicy"
      >;
      const storedDefinition: SkillCatalogPublication = {
        id: row.id,
        name: row.name,
        version: row.version,
        author: row.author,
        category: row.category,
        description: row.description,
        executionType: row.execution_type,
        inputSchema: JSON.parse(row.input_schema_json) as Record<string, unknown>,
        outputSchema: JSON.parse(row.output_schema_json) as Record<string, unknown>,
        requiredPermissions: JSON.parse(row.permissions_json) as string[],
        ...storedOptions,
      };

      expect(createDefaultNativeSkillRegistry().matchesDefinition(storedDefinition)).toBe(true);
    } finally {
      db.close();
    }
  });
});
