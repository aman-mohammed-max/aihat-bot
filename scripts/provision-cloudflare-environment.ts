type EnvironmentName = "staging" | "production";

interface D1DatabaseRecord {
  readonly name: string;
  readonly uuid: string;
}

interface D1Binding {
  readonly binding?: string;
  readonly database_name?: string;
  readonly database_id?: string;
}

interface R2Binding {
  readonly binding?: string;
  readonly bucket_name?: string;
}

interface QueueBinding {
  readonly binding?: string;
  readonly queue?: string;
}

interface WranglerConfig {
  readonly env?: Record<
    string,
    {
      readonly d1_databases?: readonly D1Binding[];
      readonly r2_buckets?: readonly R2Binding[];
      readonly queues?: {
        readonly producers?: readonly QueueBinding[];
        readonly consumers?: readonly { readonly queue?: string }[];
      };
    }
  >;
}

interface ResourceInventory {
  readonly d1Databases: readonly D1DatabaseRecord[];
  readonly r2Buckets: ReadonlySet<string>;
  readonly queues: ReadonlySet<string>;
}

export interface ProvisionPlan {
  readonly environment: EnvironmentName;
  readonly databaseName: string;
  readonly bucketName: string;
  readonly queueName: string;
  readonly createDatabase: boolean;
  readonly createBucket: boolean;
  readonly createQueue: boolean;
}

type CommandRunner = (args: readonly string[]) => Promise<string>;

export function parseProvisionArgs(args: readonly string[]): { environment: EnvironmentName; apply: boolean } {
  let environment: EnvironmentName | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      throw new ProvisionHelpRequested();
    }
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--env") {
      const value = args[index + 1];
      if (value !== "staging" && value !== "production") {
        throw new Error("--env must be either staging or production.");
      }
      environment = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ""}`);
  }
  if (!environment) throw new Error("Choose an environment with --env staging or --env production.");
  return { environment, apply };
}

export function parseD1Inventory(output: string): D1DatabaseRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (cause) {
    throw new Error("Wrangler returned invalid JSON for the D1 database inventory.", { cause });
  }
  if (!Array.isArray(value)) throw new Error("Wrangler returned an unexpected D1 database inventory.");
  return value.map((record) => {
    if (
      !record ||
      typeof record !== "object" ||
      typeof (record as Record<string, unknown>).name !== "string" ||
      typeof (record as Record<string, unknown>).uuid !== "string"
    ) {
      throw new Error("Wrangler returned a malformed D1 database record.");
    }
    const item = record as Record<string, unknown>;
    return { name: item.name as string, uuid: item.uuid as string };
  });
}

export function parseR2Inventory(output: string): Set<string> {
  const names = new Set<string>();
  for (const match of output.matchAll(/^name:\s+(.+?)\s*$/gm)) {
    const name = match[1]?.trim();
    if (name) names.add(name);
  }
  if (
    !names.size &&
    output.trim() &&
    !/^listing buckets\.\.\.$/im.test(output.trim()) &&
    !/no buckets? (?:found|available)/i.test(output)
  ) {
    throw new Error("Wrangler returned an unrecognized R2 bucket inventory.");
  }
  return names;
}

export function parseQueueInventory(output: string): Set<string> {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex(
    (line) => line.includes("│") && line.split("│").some((cell) => cell.trim() === "name"),
  );
  if (headerIndex < 0) {
    const nonBannerLines = lines
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isWranglerBannerLine(line));
    if (!nonBannerLines.length || /no queues? (?:found|available)/i.test(output)) return new Set();
    throw new Error("Wrangler returned an unrecognized Queue inventory.");
  }
  const headerCells = lines[headerIndex]?.split("│").map((cell) => cell.trim()) ?? [];
  const nameIndex = headerCells.indexOf("name");
  const names = new Set<string>();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.includes("│")) continue;
    const cells = line.split("│").map((cell) => cell.trim());
    const name = cells[nameIndex];
    if (name && name !== "name" && !/^[-─]+$/.test(name)) names.add(name);
  }
  return names;
}

export function buildProvisionPlan(
  environment: EnvironmentName,
  config: WranglerConfig,
  inventory: ResourceInventory,
): ProvisionPlan {
  const environmentConfig = config.env?.[environment];
  if (!environmentConfig) throw new Error(`Wrangler config has no ${environment} environment.`);

  const databaseName = `aihat-bot-${environment}`;
  const bucketName = databaseName;
  const queueName = databaseName;
  const d1Bindings = environmentConfig.d1_databases ?? [];
  const d1Binding = d1Bindings.find((binding) => binding.binding === "DB");
  if (!d1Binding || d1Binding.database_name !== databaseName) {
    throw new Error(`${environment} must bind DB to ${databaseName}.`);
  }

  const remoteDatabase = inventory.d1Databases.find((database) => database.name === databaseName);
  const configuredId = d1Binding.database_id ?? "";
  const hasConfiguredId = isUuid(configuredId) && !isPlaceholderUuid(configuredId);
  if (remoteDatabase && hasConfiguredId && remoteDatabase.uuid !== configuredId) {
    throw new Error(`The configured ${environment} D1 ID does not match the account database named ${databaseName}.`);
  }
  if (remoteDatabase && !hasConfiguredId) {
    throw new Error(
      `${databaseName} already exists but its ID is unresolved in wrangler.jsonc; reconcile the DB binding manually before provisioning.`,
    );
  }
  if (!remoteDatabase && hasConfiguredId) {
    throw new Error(`wrangler.jsonc points ${environment} at a D1 ID that is absent from this Cloudflare account.`);
  }

  const bucketBinding = (environmentConfig.r2_buckets ?? []).find((binding) => binding.binding === "OBJECTS");
  if (!bucketBinding || bucketBinding.bucket_name !== bucketName) {
    throw new Error(`${environment} must bind OBJECTS to the bucket ${bucketName}.`);
  }

  const queueConfig = environmentConfig.queues;
  const hasProducer = (queueConfig?.producers ?? []).some(
    (binding) => binding.binding === "JOBS" && binding.queue === queueName,
  );
  const hasConsumer = (queueConfig?.consumers ?? []).some((binding) => binding.queue === queueName);
  if (!hasProducer || !hasConsumer) {
    throw new Error(`${environment} must configure JOBS producer and consumer bindings for ${queueName}.`);
  }

  return {
    environment,
    databaseName,
    bucketName,
    queueName,
    createDatabase: !remoteDatabase,
    createBucket: !inventory.r2Buckets.has(bucketName),
    createQueue: !inventory.queues.has(queueName),
  };
}

export async function provisionCloudflareEnvironment(input: {
  readonly environment: EnvironmentName;
  readonly apply: boolean;
  readonly configPath?: string;
  readonly runner?: CommandRunner;
  readonly output?: (message: string) => void;
}): Promise<void> {
  const output = input.output ?? ((message) => console.log(message));
  const configPath = input.configPath ?? new URL("../apps/cloudflare-runtime/wrangler.jsonc", import.meta.url).pathname;
  const config = await readWranglerConfig(configPath);
  const runner = input.runner ?? ((args) => runWrangler(args));
  const inventory = await readInventory(runner);
  const plan = buildProvisionPlan(input.environment, config, inventory);
  const missing: string[] = [];
  if (plan.createDatabase) missing.push(`D1 database ${plan.databaseName}`);
  if (plan.createBucket) missing.push(`R2 bucket ${plan.bucketName}`);
  if (plan.createQueue) missing.push(`Queue ${plan.queueName}`);

  if (!input.apply) {
    output(`Dry run for ${plan.environment}; no Cloudflare resources or migrations will be changed.`);
    if (missing.length) output(`Would create: ${missing.join(", ")}.`);
    else output("All configured D1, R2, and Queue resources already exist.");
    output(`Would apply any pending D1 migrations to ${plan.databaseName}.`);
    output("This command does not deploy the Worker or configure secrets.");
    return;
  }

  if (plan.createDatabase) {
    output(`Creating D1 database ${plan.databaseName} and updating the ${plan.environment} DB binding...`);
    await runner(["d1", "create", plan.databaseName, "--env", plan.environment, "--binding", "DB", "--update-config"]);
  }
  if (plan.createBucket) {
    output(`Creating R2 bucket ${plan.bucketName} and updating the ${plan.environment} OBJECTS binding...`);
    await runner([
      "r2",
      "bucket",
      "create",
      plan.bucketName,
      "--env",
      plan.environment,
      "--binding",
      "OBJECTS",
      "--update-config",
    ]);
  }
  if (plan.createQueue) {
    output(`Creating Queue ${plan.queueName}...`);
    await runner(["queues", "create", plan.queueName]);
  }

  const refreshedConfig = await readWranglerConfig(configPath);
  const refreshedInventory = await readInventory(runner);
  const refreshedPlan = buildProvisionPlan(input.environment, refreshedConfig, refreshedInventory);
  if (refreshedPlan.createDatabase || refreshedPlan.createBucket || refreshedPlan.createQueue) {
    throw new Error(
      "Provisioning did not create every configured Cloudflare resource; review Wrangler output and rerun.",
    );
  }

  output(`Applying pending D1 migrations to ${plan.databaseName}...`);
  await runner(["d1", "migrations", "apply", "DB", "--remote", "--env", plan.environment]);
  output(`Cloudflare ${plan.environment} resources and D1 migrations are ready. Worker deployment was not run.`);
}

async function readWranglerConfig(path: string): Promise<WranglerConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await Bun.file(path).text());
  } catch (cause) {
    throw new Error(
      "Could not parse wrangler.jsonc. Keep the provisioning config valid JSONC without comments for this command.",
      {
        cause,
      },
    );
  }
  if (!value || typeof value !== "object") throw new Error("Wrangler config must contain an object.");
  return value as WranglerConfig;
}

async function readInventory(runner: CommandRunner): Promise<ResourceInventory> {
  const [d1, r2, queues] = await Promise.all([
    runner(["d1", "list", "--json"]),
    runner(["r2", "bucket", "list"]),
    readAllQueuePages(runner),
  ]);
  return {
    d1Databases: parseD1Inventory(d1),
    r2Buckets: parseR2Inventory(r2),
    queues,
  };
}

async function readAllQueuePages(runner: CommandRunner): Promise<Set<string>> {
  const queueNames = new Set<string>();
  for (let page = 1; page <= 100; page += 1) {
    const currentPage = parseQueueInventory(await runner(["queues", "list", "--page", String(page)]));
    if (!currentPage.size) return queueNames;
    const previousSize = queueNames.size;
    for (const name of currentPage) queueNames.add(name);
    if (queueNames.size === previousSize) {
      throw new Error("Wrangler Queue inventory repeated a page; refusing to create a possibly existing Queue.");
    }
  }
  throw new Error("Wrangler Queue inventory exceeded 100 pages; refusing to provision from an incomplete list.");
}

function isWranglerBannerLine(line: string): boolean {
  return /^⛅️\s+wrangler\s+\d+(?:\.\d+){1,3}$/u.test(line) || /^[-─]+$/.test(line);
}

async function runWrangler(args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["bunx", "wrangler", ...args], {
    cwd: new URL("../apps/cloudflare-runtime", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    const command = args.slice(0, 2).join(" ");
    throw new Error(`Wrangler ${command} failed with exit code ${exitCode}; inspect Wrangler's local log for details.`);
  }
  return stdout;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPlaceholderUuid(value: string): boolean {
  return /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
}

class ProvisionHelpRequested extends Error {}

async function main(): Promise<void> {
  try {
    const options = parseProvisionArgs(Bun.argv.slice(2));
    await provisionCloudflareEnvironment(options);
  } catch (error) {
    if (error instanceof ProvisionHelpRequested) {
      console.log("Usage: bun run cloudflare:provision -- --env staging|production [--apply]");
      console.log("Without --apply, this command inventories Cloudflare resources and prints a dry-run plan.");
      return;
    }
    console.error(error instanceof Error ? error.message : "Cloudflare environment provisioning failed.");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
