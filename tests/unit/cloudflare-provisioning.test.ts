import { describe, expect, test } from "bun:test";
import {
  buildProvisionPlan,
  parseD1Inventory,
  parseProvisionArgs,
  parseQueueInventory,
  parseR2Inventory,
} from "../../scripts/provision-cloudflare-environment.js";

const stagingDatabaseId = "41b78acb-ad21-47f0-8b54-2e3642427c1a";
const productionDatabaseId = "7169d344-376e-4383-9a80-d9945b76f242";

describe("Cloudflare environment provisioning plan", () => {
  test("requires an explicit non-development target and supports dry-run or apply mode", () => {
    expect(parseProvisionArgs(["--env", "staging"])).toEqual({ environment: "staging", apply: false });
    expect(parseProvisionArgs(["--env", "production", "--apply"])).toEqual({
      environment: "production",
      apply: true,
    });
    expect(() => parseProvisionArgs(["--env", "development"])).toThrow("either staging or production");
    expect(() => parseProvisionArgs(["--apply"])).toThrow("Choose an environment");
  });

  test("plans only the missing named resources and preserves unrelated account resources", () => {
    const plan = buildProvisionPlan("staging", makeConfig("staging"), {
      d1Databases: [{ name: "resumpilot", uuid: productionDatabaseId }],
      r2Buckets: new Set(["unrelated-bucket"]),
      queues: new Set(["unrelated-queue"]),
    });

    expect(plan).toEqual({
      environment: "staging",
      databaseName: "aihat-bot-staging",
      bucketName: "aihat-bot-staging",
      queueName: "aihat-bot-staging",
      createDatabase: true,
      createBucket: true,
      createQueue: true,
    });
  });

  test("recognizes fully provisioned resources without planning duplicates", () => {
    const plan = buildProvisionPlan("production", makeConfig("production", productionDatabaseId), {
      d1Databases: [{ name: "aihat-bot-production", uuid: productionDatabaseId }],
      r2Buckets: new Set(["aihat-bot-production"]),
      queues: new Set(["aihat-bot-production"]),
    });

    expect(plan.createDatabase).toBe(false);
    expect(plan.createBucket).toBe(false);
    expect(plan.createQueue).toBe(false);
  });

  test("fails closed on a D1 ID mismatch or incomplete Queue bindings", () => {
    expect(() =>
      buildProvisionPlan("staging", makeConfig("staging", stagingDatabaseId), {
        d1Databases: [{ name: "aihat-bot-staging", uuid: productionDatabaseId }],
        r2Buckets: new Set(),
        queues: new Set(),
      }),
    ).toThrow("does not match");

    const config = makeConfig("staging");
    const environment = config.env?.staging;
    if (!environment?.queues) throw new Error("Test config is invalid.");
    const incomplete = {
      env: {
        staging: {
          ...environment,
          queues: { producers: environment.queues.producers, consumers: [] },
        },
      },
    };
    expect(() =>
      buildProvisionPlan("staging", incomplete, { d1Databases: [], r2Buckets: new Set(), queues: new Set() }),
    ).toThrow("producer and consumer");
  });

  test("parses Wrangler inventory output and rejects unknown formats", () => {
    expect(parseD1Inventory(JSON.stringify([{ name: "aihat-bot-staging", uuid: stagingDatabaseId }]))).toEqual([
      { name: "aihat-bot-staging", uuid: stagingDatabaseId },
    ]);
    expect(parseR2Inventory("Listing buckets...\nname: aihat-bot-staging\ncreation_date: now")).toEqual(
      new Set(["aihat-bot-staging"]),
    );
    expect(parseR2Inventory("Listing buckets...")).toEqual(new Set());
    expect(
      parseQueueInventory(
        [
          "┌──────┬──────────────────┐",
          "│ id   │ name             │",
          "├──────┼──────────────────┤",
          "│ id-1 │ aihat-bot-staging│",
          "└──────┴──────────────────┘",
        ].join("\n"),
      ),
    ).toEqual(new Set(["aihat-bot-staging"]));
    expect(parseQueueInventory("No queues found.")).toEqual(new Set());
    expect(parseQueueInventory("⛅️ wrangler 4.156.0\n────────────────────")).toEqual(new Set());
    expect(() => parseD1Inventory("not json")).toThrow("invalid JSON");
    expect(() => parseR2Inventory("unexpected R2 output")).toThrow("unrecognized");
    expect(() => parseQueueInventory("unexpected Queue output")).toThrow("unrecognized");
  });
});

function makeConfig(
  environment: "staging" | "production",
  databaseId = "00000000-0000-0000-0000-00000000000" + (environment === "staging" ? "2" : "3"),
) {
  const databaseName = `aihat-bot-${environment}`;
  return {
    env: {
      [environment]: {
        d1_databases: [{ binding: "DB", database_name: databaseName, database_id: databaseId }],
        r2_buckets: [{ binding: "OBJECTS", bucket_name: databaseName }],
        queues: {
          producers: [{ binding: "JOBS", queue: databaseName }],
          consumers: [{ queue: databaseName }],
        },
      },
    },
  };
}
