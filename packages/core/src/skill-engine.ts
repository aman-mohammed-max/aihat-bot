import { AppError, unsupportedCapability } from "./errors.js";
import type {
  SecretStore,
  SecretWriter,
  AuditLogRepository,
  IsolatedSkillExecutor,
  SkillRateLimiter,
  SkillRepository,
  TelegramRepository,
  WorkflowExecutionRepository,
  Logger,
} from "./ports.js";
import type {
  InstalledSkill,
  ModelToolDefinition,
  SkillDefinition,
  TenantId,
  WorkflowExecutionAcquisition,
} from "./types.js";
import type { AgentToolRegistry, ToolContext } from "./tools.js";

const MAX_HTTP_RESPONSE_BYTES = 1_048_576;
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "set-cookie",
]);

export type NativeSkillHandler = (
  context: ToolContext,
  input: unknown,
  signal: AbortSignal,
  installation: InstalledSkill,
) => Promise<unknown>;

export interface SkillEngineOptions {
  readonly skills: SkillRepository;
  readonly rateLimiter: SkillRateLimiter;
  readonly secrets: SecretStore;
  readonly allowedHttpOrigins: ReadonlySet<string>;
  readonly telegramGrants?: Pick<TelegramRepository, "isTelegramToolAllowed">;
  readonly authorizationAudit?: Pick<AuditLogRepository, "recordPermissionDecision">;
  readonly nativeHandlers?: ReadonlyMap<string, NativeSkillHandler>;
  readonly isolatedSkillExecutor?: IsolatedSkillExecutor;
  readonly workflowExecutions?: WorkflowExecutionRepository;
  readonly secretWriter?: SecretWriter;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly logger?: Pick<Logger, "warn">;
}

/** Tenant-scoped installed skills exposed to the agent as authorized tools or prompt additions. */
export class SkillEngine implements AgentToolRegistry {
  readonly #skills: SkillRepository;
  readonly #rateLimiter: SkillRateLimiter;
  readonly #secrets: SecretStore;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #nativeHandlers: ReadonlyMap<string, NativeSkillHandler>;
  readonly #isolatedSkillExecutor: IsolatedSkillExecutor | undefined;
  readonly #telegramGrants: SkillEngineOptions["telegramGrants"];
  readonly #authorizationAudit: SkillEngineOptions["authorizationAudit"];
  readonly #workflowExecutions: WorkflowExecutionRepository | undefined;
  readonly #secretWriter: SecretWriter | undefined;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #logger: Pick<Logger, "warn"> | undefined;

  constructor(options: SkillEngineOptions) {
    this.#skills = options.skills;
    this.#rateLimiter = options.rateLimiter;
    this.#secrets = options.secrets;
    this.#allowedOrigins = normalizeAllowedOrigins(options.allowedHttpOrigins);
    this.#nativeHandlers = options.nativeHandlers ?? new Map();
    this.#isolatedSkillExecutor = options.isolatedSkillExecutor;
    this.#telegramGrants = options.telegramGrants;
    this.#authorizationAudit = options.authorizationAudit;
    this.#workflowExecutions = options.workflowExecutions;
    this.#secretWriter = options.secretWriter;
    this.#fetch = options.fetch ?? fetch;
    this.#logger = options.logger;
  }

  async available(context: ToolContext): Promise<readonly ModelToolDefinition[]> {
    const installed = await this.#skills.listInstalled(context.tenantId, context.botId);
    const result: ModelToolDefinition[] = [];
    const names = new Set<string>();
    for (const skill of installed) {
      if (!(await this.#canActorUse(skill, context)) || skill.definition.executionType === "prompt") continue;
      if (
        !isSupported(
          skill.definition,
          this.#nativeHandlers,
          this.#workflowExecutions !== undefined && this.#secretWriter !== undefined,
          this.#isolatedSkillExecutor,
        )
      )
        continue;
      if (skill.definition.executionType === "http" && !this.#isHttpAllowed(skill)) continue;
      if (skill.definition.executionType === "workflow" && !(await this.#workflowAvailable(skill, installed, context)))
        continue;
      const name = await toolName(skill.definition.id);
      if (names.has(name)) throw new AppError("CONFLICT", "Installed skills have colliding tool identifiers.", 409);
      names.add(name);
      result.push({ name, description: skill.definition.description, inputSchema: skill.definition.inputSchema });
    }
    return result;
  }

  async promptInstructions(context: ToolContext): Promise<readonly string[]> {
    const installed = await this.#skills.listInstalled(context.tenantId, context.botId);
    const instructions: string[] = [];
    for (const item of installed) {
      if (item.definition.executionType !== "prompt" || !(await this.#canActorUse(item, context))) continue;
      const instruction = item.definition.configuration.instructions;
      if (typeof instruction === "string" && instruction.length > 0 && instruction.length <= 12_000) {
        instructions.push(instruction);
      }
    }
    return instructions;
  }

  async execute(context: ToolContext, name: string, input: unknown): Promise<unknown> {
    const installed = await this.#skills.listInstalled(context.tenantId, context.botId);
    let skill: InstalledSkill | undefined;
    for (const candidate of installed) {
      if ((await toolName(candidate.definition.id)) === name) {
        skill = candidate;
        break;
      }
    }
    if (!skill || !(await this.#canActorUse(skill, context)) || skill.definition.executionType === "prompt") {
      throw new AppError("FORBIDDEN", "The requested skill is not installed or authorized for this actor.", 403);
    }
    if (
      !isSupported(
        skill.definition,
        this.#nativeHandlers,
        this.#workflowExecutions !== undefined && this.#secretWriter !== undefined,
        this.#isolatedSkillExecutor,
      )
    ) {
      throw unsupportedCapability(skill.definition.executionType, "current runtime");
    }
    if (skill.definition.executionType === "http" && !this.#isHttpAllowed(skill)) {
      throw new AppError("FORBIDDEN", "HTTP skill endpoint origin is not approved by the deployment.", 403);
    }
    const parsedInput = validateJsonSchema(input, skill.definition.inputSchema, "input", true);
    const allowed = await this.#rateLimiter.consume({
      tenantId: context.tenantId,
      botId: context.botId,
      skillId: skill.definition.id,
      now: Date.now(),
      maxRequests: skill.definition.rateLimit.maxRequests,
      windowSeconds: skill.definition.rateLimit.windowSeconds,
    });
    if (!allowed) throw new AppError("RATE_LIMITED", "Skill request rate limit was reached.", 429);

    const controller = new AbortController();
    const abortFromContext = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", abortFromContext, { once: true });
    if (context.signal?.aborted) abortFromContext();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled: (() => void) | undefined;
    const cancelled = context.signal
      ? new Promise<never>((_, reject) => {
          rejectCancelled = () => reject(new AppError("DEPENDENCY_UNAVAILABLE", "Skill execution was cancelled.", 504));
          if (context.signal?.aborted) rejectCancelled();
          else context.signal?.addEventListener("abort", rejectCancelled, { once: true });
        })
      : new Promise<never>(() => undefined);
    try {
      const handler = this.#nativeHandlers.get(skill.definition.id);
      const execution =
        skill.definition.executionType === "workflow"
          ? this.#executeWorkflow(skill, context, parsedInput, controller.signal)
          : skill.definition.executionType === "sandbox" && this.#isolatedSkillExecutor
            ? this.#isolatedSkillExecutor.execute({
                tenantId: context.tenantId,
                botId: context.botId,
                skillId: skill.definition.id,
                version: skill.definition.version,
                input: parsedInput,
                timeoutMs: skill.definition.timeoutMs,
                signal: controller.signal,
              })
            : handler
              ? handler(context, parsedInput, controller.signal, skill)
              : this.#executeHttp(skill, context, parsedInput, controller.signal);
      const timeoutResult = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error("Skill execution timed out."));
          reject(new AppError("DEPENDENCY_UNAVAILABLE", "Skill execution timed out.", 504));
        }, skill.definition.timeoutMs);
      });
      const result = await Promise.race([execution, timeoutResult, cancelled]);
      return validateJsonSchema(result, skill.definition.outputSchema, "output", false);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (controller.signal.aborted) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill execution timed out or was cancelled.", 504);
      }
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill execution failed.", 502, { cause });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abortFromContext);
      if (rejectCancelled) context.signal?.removeEventListener("abort", rejectCancelled);
    }
  }

  async #executeHttp(
    skill: InstalledSkill,
    context: ToolContext,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const config = this.#httpConfiguration(skill);
    const endpoint = new URL(config.endpoint);
    if (!this.#allowedOrigins.has(endpoint.origin)) {
      throw new AppError("FORBIDDEN", "HTTP skill endpoint origin is not approved by the deployment.", 403);
    }
    const method = config.method;
    const record = input as Record<string, unknown>;
    if (method === "GET" || method === "DELETE") {
      for (const [key, value] of Object.entries(record)) {
        endpoint.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }

    const headers = new Headers();
    const staticHeaders = config.headers ?? {};
    for (const [name, value] of Object.entries(staticHeaders)) {
      validateHeader(name, value);
      headers.set(name, value);
    }
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (method !== "GET" && method !== "DELETE" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const secretRef = skill.configuration.credentialRef;
    const authentication = config.authentication;
    if (authentication.required && !secretRef) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill requires an encrypted credential reference.", 400);
    }
    if (secretRef !== undefined) {
      if (typeof secretRef !== "string" || !/^secret_[a-f0-9]{32}$/.test(secretRef)) {
        throw new AppError("VALIDATION_ERROR", "Installed skill credential reference is invalid.", 400);
      }
      const credential = await this.#secrets.resolve(context.tenantId, secretRef, signal);
      validateCredentialValue(credential);
      if (authentication.type === "none") {
        throw new AppError("VALIDATION_ERROR", "HTTP skill does not accept a credential reference.", 400);
      }
      if (authentication.type === "bearer") {
        headers.set("authorization", `Bearer ${credential}`);
      } else if (authentication.type === "header") {
        headers.set(authentication.header, credential);
      }
    }

    const retry = skill.definition.retryPolicy;
    if (!retry.idempotent && retry.maxAttempts > 1 && !config.idempotencyKeyHeader) {
      throw new AppError("VALIDATION_ERROR", "Non-idempotent HTTP skill retries need an idempotency-key header.", 400);
    }
    const idempotencyKey = config.idempotencyKeyHeader
      ? (context.executionKey ?? crypto.randomUUID())
      : retry.maxAttempts > 1
        ? crypto.randomUUID()
        : undefined;
    if (idempotencyKey && config.idempotencyKeyHeader) {
      validateHeader(config.idempotencyKeyHeader, idempotencyKey);
      headers.set(config.idempotencyKeyHeader, idempotencyKey);
    }

    let lastStatus = 0;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      if (signal.aborted) throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill request was cancelled.", 504);
      let response: Response;
      try {
        response = await this.#fetch(endpoint, {
          method,
          headers,
          redirect: "error",
          signal,
          ...("GET" === method || "DELETE" === method ? {} : { body: JSON.stringify(input) }),
        });
      } catch (cause) {
        if (signal.aborted) throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill request timed out.", 504);
        if (attempt === retry.maxAttempts) {
          throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill request failed.", 502, { cause });
        }
        const delayMs = retry.backoffMs * 2 ** (attempt - 1);
        try {
          this.#logger?.warn("dependency.retry", {
            service: "http_skill",
            attempt,
            maxAttempts: retry.maxAttempts,
            delayMs,
            reason: "network_error",
          });
        } catch {
          // Observability must not change retry behavior.
        }
        await delay(delayMs, signal);
        continue;
      }

      lastStatus = response.status;
      if (retry.retryableStatusCodes.includes(response.status) && attempt < retry.maxAttempts) {
        await response.body?.cancel();
        const delayMs = retry.backoffMs * 2 ** (attempt - 1);
        try {
          this.#logger?.warn("dependency.retry", {
            service: "http_skill",
            attempt,
            maxAttempts: retry.maxAttempts,
            delayMs,
            statusCode: response.status,
          });
        } catch {
          // Observability must not change retry behavior.
        }
        await delay(delayMs, signal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", `HTTP skill returned status ${response.status}.`, 502);
      }
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "application/json" && !contentType.endsWith("+json")) {
        await response.body?.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill returned a non-JSON response.", 502);
      }
      return await readBoundedJson(response);
    }
    throw new AppError("DEPENDENCY_UNAVAILABLE", `HTTP skill retries ended at status ${lastStatus}.`, 502);
  }

  async #workflowAvailable(
    workflow: InstalledSkill,
    installed: readonly InstalledSkill[],
    context: ToolContext,
  ): Promise<boolean> {
    let definition: WorkflowDefinition;
    try {
      definition = parseWorkflowDefinition(workflow.definition.configuration.workflow);
    } catch {
      return false;
    }
    for (const step of definition.steps) {
      if (step.type !== "skill") continue;
      const child = installed.find((item) => item.definition.id === step.skillId);
      if (
        !child ||
        !(await this.#canActorUse(child, context)) ||
        !isWorkflowChildSupported(child, this.#nativeHandlers)
      ) {
        return false;
      }
      if (child.definition.executionType === "http" && !this.#isHttpAllowed(child)) return false;
    }
    return true;
  }

  async #executeWorkflow(
    skill: InstalledSkill,
    context: ToolContext,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const executions = this.#workflowExecutions;
    const writer = this.#secretWriter;
    if (!executions || !writer) throw unsupportedCapability("workflow", "current runtime");
    const definition = parseWorkflowDefinition(skill.definition.configuration.workflow);
    const installed = await this.#skills.listInstalled(context.tenantId, context.botId);
    const children = new Map(installed.map((item) => [item.definition.id, item]));
    for (const step of definition.steps) {
      if (step.type !== "skill") continue;
      const child = children.get(step.skillId);
      if (!child || child.definition.executionType === "workflow" || !(await this.#canActorUse(child, context))) {
        throw new AppError("FORBIDDEN", "A workflow child skill is not installed or authorized for this actor.", 403);
      }
      if (!isWorkflowChildSupported(child, this.#nativeHandlers)) {
        throw unsupportedCapability(child.definition.executionType, "workflow child execution");
      }
      if (child.definition.executionType === "http" && !this.#isHttpAllowed(child)) {
        throw new AppError("FORBIDDEN", "A workflow child HTTP origin is not approved by the deployment.", 403);
      }
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const executionKey = await digestHex(context.executionKey ?? crypto.randomUUID());
    const workflowHash = await digestHex(JSON.stringify(definition));
    const expiry = new Date(now.getTime() + WORKFLOW_EXECUTION_TTL_MS).toISOString();
    const leaseToken = crypto.randomUUID();
    const initialState: WorkflowState = {
      input,
      outputs: {},
      attempts: {},
      nextStep: 0,
      workflowHash,
    };
    const initialStateRef = await writer.put(context.tenantId, serializeWorkflowState(initialState));
    let acquisition: WorkflowExecutionAcquisition;
    try {
      for (let index = 0; index < 10; index += 1) {
        const expiredRefs = await executions.purgeExpired(context.tenantId, nowIso, 1000);
        await Promise.allSettled(expiredRefs.map((reference) => writer.delete(context.tenantId, reference)));
        if (expiredRefs.length < 1000) break;
      }
      acquisition = await executions.acquire({
        tenantId: context.tenantId,
        botId: context.botId,
        skillId: skill.definition.id,
        executionKey,
        initialStateRef,
        leaseToken,
        now: nowIso,
        leaseUntil: new Date(now.getTime() + WORKFLOW_LEASE_MS).toISOString(),
        expiresAt: expiry,
      });
    } catch (cause) {
      await safelyDeleteSecret(writer, context.tenantId, initialStateRef);
      throw cause;
    }

    if (acquisition.state === "busy") {
      await safelyDeleteSecret(writer, context.tenantId, initialStateRef);
      throw new AppError("CONFLICT", "This workflow call is already running.", 409);
    }
    if (acquisition.state === "completed") {
      await safelyDeleteSecret(writer, context.tenantId, initialStateRef);
      const cached = parseWorkflowState(
        await this.#secrets.resolve(context.tenantId, acquisition.execution.stateRef, signal),
      );
      if (cached.workflowHash !== workflowHash || !("result" in cached)) {
        throw new AppError("CONFLICT", "Workflow definition changed after this call completed.", 409);
      }
      return cached.result;
    }

    const execution = acquisition.execution;
    let activeStateRef = execution.stateRef;
    let version = execution.version;
    if (activeStateRef !== initialStateRef) await safelyDeleteSecret(writer, context.tenantId, initialStateRef);
    else if (acquisition.replacedStateRef)
      await safelyDeleteSecret(writer, context.tenantId, acquisition.replacedStateRef);

    const persist = async (state: WorkflowState, nextStep: number): Promise<void> => {
      state.nextStep = nextStep;
      const newStateRef = await writer.put(context.tenantId, serializeWorkflowState(state));
      const timestamp = new Date();
      let saved: boolean;
      try {
        saved = await executions.checkpoint({
          tenantId: context.tenantId,
          botId: context.botId,
          skillId: skill.definition.id,
          executionKey,
          leaseToken,
          expectedVersion: version,
          stateRef: newStateRef,
          nextStep,
          now: timestamp.toISOString(),
          leaseUntil: new Date(timestamp.getTime() + WORKFLOW_LEASE_MS).toISOString(),
          expiresAt: new Date(timestamp.getTime() + WORKFLOW_EXECUTION_TTL_MS).toISOString(),
        });
      } catch (cause) {
        await safelyDeleteSecret(writer, context.tenantId, newStateRef);
        throw cause;
      }
      if (!saved) {
        await safelyDeleteSecret(writer, context.tenantId, newStateRef);
        throw new AppError("CONFLICT", "Workflow checkpoint was superseded by another worker.", 409);
      }
      const previousStateRef = activeStateRef;
      activeStateRef = newStateRef;
      version += 1;
      await safelyDeleteSecret(writer, context.tenantId, previousStateRef);
    };

    try {
      const state = parseWorkflowState(await this.#secrets.resolve(context.tenantId, activeStateRef, signal));
      if (
        state.workflowHash !== workflowHash ||
        state.nextStep !== execution.nextStep ||
        state.nextStep > definition.steps.length
      ) {
        throw new AppError("CONFLICT", "Workflow definition or checkpoint is inconsistent.", 409);
      }
      while (state.nextStep < definition.steps.length) {
        if (signal.aborted) throw new AppError("DEPENDENCY_UNAVAILABLE", "Workflow execution was cancelled.", 504);
        const stepIndex = state.nextStep;
        const step = definition.steps[stepIndex];
        if (!step) throw new AppError("INTERNAL_ERROR", "Workflow step index is invalid.", 500);
        if (state.inFlightStep !== undefined && (step.type !== "skill" || state.inFlightStep !== step.id)) {
          throw new AppError("INTERNAL_ERROR", "Workflow in-flight step does not match its checkpoint.", 500);
        }
        if (step.type === "condition") {
          const value = resolveWorkflowPath(step.path, state);
          const matches =
            step.operator === "exists"
              ? value !== undefined
              : step.operator === "truthy"
                ? Boolean(value)
                : JSON.stringify(value) === JSON.stringify(step.value);
          const target = matches ? step.ifTrue : step.ifFalse;
          await persist(state, target === "end" ? definition.steps.length : (definition.indexes.get(target) as number));
          continue;
        }

        const child = children.get(step.skillId) as InstalledSkill;
        const childName = await toolName(child.definition.id);
        const maxAttempts = step.retry?.maxAttempts ?? 1;
        const backoffMs = step.retry?.backoffMs ?? 0;
        const childInput = step.input === undefined ? {} : resolveWorkflowTemplate(step.input, state);
        let recoveringAttempt = state.inFlightStep === step.id;
        if (!recoveringAttempt && (state.attempts[step.id] ?? 0) >= maxAttempts) {
          throw new AppError("DEPENDENCY_UNAVAILABLE", "Workflow step exhausted its retry limit.", 502);
        }
        while (recoveringAttempt || (state.attempts[step.id] ?? 0) < maxAttempts) {
          if (!recoveringAttempt) {
            state.attempts[step.id] = (state.attempts[step.id] ?? 0) + 1;
            state.inFlightStep = step.id;
            await persist(state, stepIndex);
          }
          recoveringAttempt = false;
          try {
            const childExecutionKey = await digestHex(`${executionKey}:${step.id}`);
            const childResult = await this.execute(
              { ...context, signal, executionKey: childExecutionKey },
              childName,
              childInput,
            );
            state.outputs[step.id] = childResult;
            delete state.attempts[step.id];
            delete state.inFlightStep;
            await persist(state, stepIndex + 1);
            break;
          } catch (cause) {
            delete state.inFlightStep;
            await persist(state, stepIndex);
            if ((state.attempts[step.id] ?? 0) >= maxAttempts || !isRetryableWorkflowError(cause)) throw cause;
            const attempt = state.attempts[step.id] ?? 1;
            const delayMs = backoffMs * 2 ** (attempt - 1);
            this.#observeRetry({
              service: "workflow_step",
              attempt,
              maxAttempts,
              delayMs,
              stepId: step.id,
            });
            await delay(delayMs, signal);
          }
        }
      }

      const result =
        definition.output === undefined ? { steps: state.outputs } : resolveWorkflowTemplate(definition.output, state);
      state.result = result;
      state.nextStep = definition.steps.length;
      const completedStateRef = await writer.put(context.tenantId, serializeWorkflowState(state));
      const timestamp = new Date();
      let completed: boolean;
      try {
        completed = await executions.complete({
          tenantId: context.tenantId,
          botId: context.botId,
          skillId: skill.definition.id,
          executionKey,
          leaseToken,
          expectedVersion: version,
          stateRef: completedStateRef,
          nextStep: definition.steps.length,
          now: timestamp.toISOString(),
          expiresAt: new Date(timestamp.getTime() + WORKFLOW_EXECUTION_TTL_MS).toISOString(),
        });
      } catch (cause) {
        await safelyDeleteSecret(writer, context.tenantId, completedStateRef);
        throw cause;
      }
      if (!completed) {
        await safelyDeleteSecret(writer, context.tenantId, completedStateRef);
        throw new AppError("CONFLICT", "Workflow completion was superseded by another worker.", 409);
      }
      await safelyDeleteSecret(writer, context.tenantId, activeStateRef);
      return result;
    } catch (cause) {
      await executions
        .release({
          tenantId: context.tenantId,
          botId: context.botId,
          skillId: skill.definition.id,
          executionKey,
          leaseToken,
          now: new Date().toISOString(),
        })
        .catch(() => undefined);
      throw cause;
    }
  }

  #httpConfiguration(skill: InstalledSkill): HttpSkillConfiguration {
    if (skill.definition.executionType !== "http") {
      throw new AppError("VALIDATION_ERROR", "Skill is not configured for HTTP execution.", 400);
    }
    return parseHttpConfiguration(skill.definition.configuration.http);
  }

  #isHttpAllowed(skill: InstalledSkill): boolean {
    const config = this.#httpConfiguration(skill);
    return this.#allowedOrigins.has(new URL(config.endpoint).origin);
  }

  async #canActorUse(skill: InstalledSkill, context: ToolContext): Promise<boolean> {
    let allowed = canUse(skill, context);
    if (allowed && context.platform === "telegram") {
      if (
        !this.#telegramGrants ||
        !context.telegramDeploymentId ||
        !Number.isSafeInteger(context.telegramUserId) ||
        (context.telegramUserId ?? 0) < 1
      ) {
        allowed = false;
      } else {
        allowed = await this.#telegramGrants.isTelegramToolAllowed({
          deploymentId: context.telegramDeploymentId,
          telegramUserId: context.telegramUserId as number,
          toolRef: `skill:${skill.definition.id}`,
        });
      }
    }
    await this.#authorizationAudit?.recordPermissionDecision({
      tenantId: context.tenantId,
      botId: context.botId,
      category: "skill",
      permission: `skill:${skill.definition.id}`,
      outcome: allowed ? "allowed" : "denied",
      createdAt: new Date().toISOString(),
    });
    return allowed;
  }

  #observeRetry(fields: Readonly<Record<string, unknown>>): void {
    try {
      this.#logger?.warn("dependency.retry", fields);
    } catch {
      // Observability must not change workflow recovery behavior.
    }
  }
}

export function validateSkillDefinitionForPublication(
  definition: SkillDefinition,
  catalog: readonly SkillDefinition[],
): void {
  if (definition.executionType === "http") parseHttpConfiguration(definition.configuration.http);
  if (definition.executionType !== "workflow") return;
  const workflow = parseWorkflowDefinition(definition.configuration.workflow);
  for (const step of workflow.steps) {
    if (step.type !== "skill") continue;
    const child = catalog.find((item) => item.id === step.skillId && item.enabled);
    if (!child || child.id === definition.id || !["http", "native"].includes(child.executionType)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Workflow steps must reference an enabled HTTP or native catalog skill.",
        400,
      );
    }
    if (child.executionType === "http") parseHttpConfiguration(child.configuration.http);
    const hasHttpIdempotencyKey =
      child.executionType === "http" &&
      isRecord(child.configuration.http) &&
      typeof child.configuration.http.idempotencyKeyHeader === "string";
    if (!child.retryPolicy.idempotent && !hasHttpIdempotencyKey) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Workflow child skills must be idempotent or accept an idempotency key.",
        400,
      );
    }
  }
}

function parseHttpConfiguration(raw: unknown): HttpSkillConfiguration {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError("VALIDATION_ERROR", "HTTP skill configuration is invalid.", 400);
  }
  const config = raw as Record<string, unknown>;
  if (
    Object.keys(config).some(
      (key) => !["endpoint", "method", "headers", "authentication", "idempotencyKeyHeader"].includes(key),
    ) ||
    typeof config.endpoint !== "string" ||
    typeof config.method !== "string" ||
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(config.method)
  ) {
    throw new AppError("VALIDATION_ERROR", "HTTP skill endpoint or method is invalid.", 400);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "HTTP skill endpoint must be an absolute URL.", 400, { cause });
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new AppError("VALIDATION_ERROR", "HTTP skill endpoints must use HTTPS without query or credentials.", 400);
  }
  const headers = config.headers;
  if (headers !== undefined && (!headers || typeof headers !== "object" || Array.isArray(headers))) {
    throw new AppError("VALIDATION_ERROR", "HTTP skill headers are invalid.", 400);
  }
  if (headers !== undefined) {
    if (Object.keys(headers).length > 64) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill has too many static headers.", 400);
    }
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string") {
        throw new AppError("VALIDATION_ERROR", "HTTP skill header values must be strings.", 400);
      }
      validateHeader(name, value);
    }
  }
  const rawAuthentication = config.authentication;
  let authentication: HttpSkillAuthentication = { type: "bearer", required: false };
  if (rawAuthentication !== undefined) {
    if (!rawAuthentication || typeof rawAuthentication !== "object" || Array.isArray(rawAuthentication)) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill authentication settings are invalid.", 400);
    }
    const auth = rawAuthentication as Record<string, unknown>;
    if (
      !(["none", "bearer", "header"] as unknown[]).includes(auth.type) ||
      (auth.required !== undefined && typeof auth.required !== "boolean")
    ) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill authentication settings are invalid.", 400);
    }
    if (auth.type === "header") {
      if (typeof auth.header !== "string") {
        throw new AppError("VALIDATION_ERROR", "HTTP skill credential header is invalid.", 400);
      }
      validateCredentialHeaderName(auth.header);
      authentication = { type: "header", header: auth.header, required: auth.required === true };
    } else {
      if (auth.header !== undefined) {
        throw new AppError("VALIDATION_ERROR", "HTTP skill authentication header is not applicable.", 400);
      }
      if (auth.type === "none" && auth.required === true) {
        throw new AppError("VALIDATION_ERROR", "Unauthenticated HTTP skills cannot require credentials.", 400);
      }
      authentication = { type: auth.type as "none" | "bearer", required: auth.required === true };
    }
  }
  const idempotencyKeyHeader = config.idempotencyKeyHeader;
  if (idempotencyKeyHeader !== undefined && typeof idempotencyKeyHeader !== "string") {
    throw new AppError("VALIDATION_ERROR", "HTTP skill idempotency header is invalid.", 400);
  }
  if (typeof idempotencyKeyHeader === "string") validateHeader(idempotencyKeyHeader, "idempotency-check");
  return {
    endpoint: endpoint.toString(),
    method: config.method as HttpSkillConfiguration["method"],
    authentication,
    ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
    ...(idempotencyKeyHeader === undefined ? {} : { idempotencyKeyHeader }),
  };
}

interface HttpSkillConfiguration {
  readonly endpoint: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly authentication: HttpSkillAuthentication;
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKeyHeader?: string;
}

interface WorkflowSkillStep {
  readonly id: string;
  readonly type: "skill";
  readonly skillId: string;
  readonly input?: unknown;
  readonly retry?: { readonly maxAttempts?: number; readonly backoffMs?: number };
}

interface WorkflowConditionStep {
  readonly id: string;
  readonly type: "condition";
  readonly path: string;
  readonly operator: "exists" | "truthy" | "equals";
  readonly value?: unknown;
  readonly ifTrue: string | "end";
  readonly ifFalse: string | "end";
}

type WorkflowStep = WorkflowSkillStep | WorkflowConditionStep;

interface WorkflowDefinition {
  readonly steps: readonly WorkflowStep[];
  readonly indexes: ReadonlyMap<string, number>;
  readonly output?: unknown;
}

interface WorkflowState {
  readonly input: unknown;
  readonly outputs: Record<string, unknown>;
  readonly attempts: Record<string, number>;
  nextStep: number;
  readonly workflowHash: string;
  inFlightStep?: string;
  result?: unknown;
}

const WORKFLOW_MAX_STEPS = 32;
const WORKFLOW_STATE_MAX_BYTES = 60 * 1024;
const WORKFLOW_LEASE_MS = 120_000;
const WORKFLOW_EXECUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FORBIDDEN_WORKFLOW_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type HttpSkillAuthentication =
  | { readonly type: "none" | "bearer"; readonly required: boolean }
  | { readonly type: "header"; readonly header: string; readonly required: boolean };

function canUse(skill: InstalledSkill, context: ToolContext): boolean {
  if (
    !skill.enabled ||
    !skill.definition.enabled ||
    (skill.definition.tenantId !== null && skill.definition.tenantId !== context.tenantId)
  ) {
    return false;
  }
  return skill.definition.requiredPermissions.every((permission) => skill.grantedPermissions.includes(permission));
}

function isSupported(
  definition: SkillDefinition,
  handlers: ReadonlyMap<string, NativeSkillHandler>,
  workflowEnabled: boolean,
  isolatedSkillExecutor?: IsolatedSkillExecutor,
): boolean {
  if (definition.executionType === "http") return true;
  if (definition.executionType === "native") return handlers.has(definition.id);
  if (definition.executionType === "workflow") return workflowEnabled;
  if (definition.executionType === "sandbox") {
    return isolatedSkillExecutor?.supports({ id: definition.id, version: definition.version }) === true;
  }
  return false;
}

function isWorkflowChildSupported(skill: InstalledSkill, handlers: ReadonlyMap<string, NativeSkillHandler>): boolean {
  if (skill.definition.executionType === "native") {
    return handlers.has(skill.definition.id) && skill.definition.retryPolicy.idempotent;
  }
  if (skill.definition.executionType !== "http") return false;
  const http = skill.definition.configuration.http;
  const hasIdempotencyHeader =
    http !== null &&
    typeof http === "object" &&
    !Array.isArray(http) &&
    typeof (http as Record<string, unknown>).idempotencyKeyHeader === "string";
  return skill.definition.retryPolicy.idempotent || hasIdempotencyHeader;
}

function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "steps" && key !== "output")) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Workflow configuration must contain steps and an optional output mapping.",
      400,
    );
  }
  if (!Array.isArray(value.steps) || value.steps.length > WORKFLOW_MAX_STEPS) {
    throw new AppError("VALIDATION_ERROR", `A workflow must have at most ${WORKFLOW_MAX_STEPS} steps.`, 400);
  }
  const indexes = new Map<string, number>();
  for (const [index, raw] of value.steps.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.id)) {
      throw new AppError("VALIDATION_ERROR", "Workflow step IDs must be simple unique identifiers.", 400);
    }
    if (indexes.has(raw.id)) throw new AppError("VALIDATION_ERROR", "Workflow step IDs must be unique.", 400);
    indexes.set(raw.id, index);
  }

  const steps: WorkflowStep[] = value.steps.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== "string") {
      throw new AppError("VALIDATION_ERROR", "Workflow step is invalid.", 400);
    }
    if (raw.type === "skill") {
      if (
        Object.keys(raw).some((key) => !["id", "type", "skillId", "input", "retry"].includes(key)) ||
        typeof raw.skillId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.skillId)
      ) {
        throw new AppError("VALIDATION_ERROR", "Workflow skill step is invalid.", 400);
      }
      if (raw.retry !== undefined && !isRecord(raw.retry)) {
        throw new AppError("VALIDATION_ERROR", "Workflow retry policy is invalid.", 400);
      }
      const retry = raw.retry as Record<string, unknown> | undefined;
      if (
        retry &&
        (Object.keys(retry).some((key) => key !== "maxAttempts" && key !== "backoffMs") ||
          (retry.maxAttempts !== undefined &&
            (!Number.isSafeInteger(retry.maxAttempts) ||
              (retry.maxAttempts as number) < 1 ||
              (retry.maxAttempts as number) > 4)) ||
          (retry.backoffMs !== undefined &&
            (!Number.isSafeInteger(retry.backoffMs) ||
              (retry.backoffMs as number) < 0 ||
              (retry.backoffMs as number) > 5000)))
      ) {
        throw new AppError("VALIDATION_ERROR", "Workflow retry policy is invalid.", 400);
      }
      if (raw.input !== undefined) validateWorkflowTemplate(raw.input, index, indexes);
      return {
        id: raw.id,
        type: "skill",
        skillId: raw.skillId,
        ...(raw.input === undefined ? {} : { input: raw.input }),
        ...(retry === undefined
          ? {}
          : {
              retry: {
                ...(retry.maxAttempts === undefined ? {} : { maxAttempts: retry.maxAttempts as number }),
                ...(retry.backoffMs === undefined ? {} : { backoffMs: retry.backoffMs as number }),
              },
            }),
      };
    }
    if (raw.type === "condition") {
      if (
        Object.keys(raw).some(
          (key) => !["id", "type", "path", "operator", "value", "ifTrue", "ifFalse"].includes(key),
        ) ||
        typeof raw.path !== "string" ||
        !["exists", "truthy", "equals"].includes(raw.operator as string) ||
        typeof raw.ifTrue !== "string" ||
        typeof raw.ifFalse !== "string" ||
        (raw.operator === "equals" && !Object.hasOwn(raw, "value")) ||
        (raw.operator === "equals" && !isWorkflowScalar(raw.value)) ||
        (raw.operator !== "equals" && Object.hasOwn(raw, "value"))
      ) {
        throw new AppError("VALIDATION_ERROR", "Workflow condition step is invalid.", 400);
      }
      validateWorkflowPath(raw.path, index, indexes);
      for (const target of [raw.ifTrue, raw.ifFalse]) {
        if (target === "end") continue;
        const targetIndex = indexes.get(target);
        if (targetIndex === undefined || targetIndex <= index) {
          throw new AppError("VALIDATION_ERROR", "Workflow branches must jump forward to a later step or end.", 400);
        }
      }
      return {
        id: raw.id,
        type: "condition",
        path: raw.path,
        operator: raw.operator as WorkflowConditionStep["operator"],
        ...(raw.operator === "equals" ? { value: raw.value } : {}),
        ifTrue: raw.ifTrue,
        ifFalse: raw.ifFalse,
      };
    }
    throw new AppError("VALIDATION_ERROR", "Workflow step type must be skill or condition.", 400);
  });
  if (value.output !== undefined) validateWorkflowTemplate(value.output, steps.length, indexes);
  return {
    steps,
    indexes,
    ...(value.output === undefined ? {} : { output: value.output }),
  };
}

function validateWorkflowTemplate(value: unknown, currentIndex: number, indexes: ReadonlyMap<string, number>): void {
  let visited = 0;
  const visit = (item: unknown, depth: number): void => {
    visited += 1;
    if (visited > 1000 || depth > 16) {
      throw new AppError("VALIDATION_ERROR", "Workflow input mapping is too complex.", 400);
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (!isRecord(item)) return;
    if (Object.hasOwn(item, "$from")) {
      if (Object.keys(item).length !== 1 || typeof item.$from !== "string") {
        throw new AppError("VALIDATION_ERROR", "Workflow references must use only a string $from path.", 400);
      }
      validateWorkflowPath(item.$from, currentIndex, indexes);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_WORKFLOW_KEYS.has(key)) {
        throw new AppError("VALIDATION_ERROR", "Workflow mappings contain a forbidden object key.", 400);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function validateWorkflowPath(path: string, currentIndex: number, indexes: ReadonlyMap<string, number>): void {
  const segments = path.split(".");
  if (segments.some((segment) => !segment || FORBIDDEN_WORKFLOW_KEYS.has(segment))) {
    throw new AppError("VALIDATION_ERROR", "Workflow reference path is invalid.", 400);
  }
  if (segments[0] === "input") {
    if (segments.slice(1).some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) {
      throw new AppError("VALIDATION_ERROR", "Workflow input reference path is invalid.", 400);
    }
    return;
  }
  if (segments[0] !== "steps" || segments.length < 3 || segments[2] !== "output") {
    throw new AppError("VALIDATION_ERROR", "Workflow references must start with input or steps.<id>.output.", 400);
  }
  const sourceIndex = indexes.get(segments[1] as string);
  if (
    sourceIndex === undefined ||
    sourceIndex >= currentIndex ||
    segments.slice(3).some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))
  ) {
    throw new AppError("VALIDATION_ERROR", "Workflow references can use only earlier skill outputs.", 400);
  }
}

function resolveWorkflowTemplate(value: unknown, state: WorkflowState): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveWorkflowTemplate(item, state));
  if (!isRecord(value)) return value;
  if (Object.hasOwn(value, "$from")) {
    if (Object.keys(value).length !== 1 || typeof value.$from !== "string") {
      throw new AppError("VALIDATION_ERROR", "Workflow reference is invalid.", 400);
    }
    return cloneWorkflowValue(resolveWorkflowPath(value.$from, state));
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_WORKFLOW_KEYS.has(key))
      throw new AppError("VALIDATION_ERROR", "Workflow mapping key is forbidden.", 400);
    result[key] = resolveWorkflowTemplate(item, state);
  }
  return result;
}

function resolveWorkflowPath(path: string, state: WorkflowState): unknown {
  const segments = path.split(".");
  let value: unknown;
  if (segments[0] === "input") {
    value = state.input;
    segments.shift();
  } else if (segments[0] === "steps" && segments.length >= 3 && segments[2] === "output") {
    value = state.outputs[segments[1] as string];
    segments.splice(0, 3);
  } else {
    throw new AppError("VALIDATION_ERROR", "Workflow reference path is invalid.", 400);
  }
  for (const segment of segments) {
    if (FORBIDDEN_WORKFLOW_KEYS.has(segment))
      throw new AppError("VALIDATION_ERROR", "Workflow reference path is forbidden.", 400);
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      value = value[Number(segment)];
    } else if (isRecord(value) && Object.hasOwn(value, segment)) {
      value = value[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

function cloneWorkflowValue(value: unknown): unknown {
  let visited = 0;
  const visit = (item: unknown, depth: number): unknown => {
    visited += 1;
    if (visited > 1000 || depth > 16) {
      throw new AppError("VALIDATION_ERROR", "Workflow reference value is too complex.", 400);
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (!isRecord(item)) return item;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_WORKFLOW_KEYS.has(key)) {
        throw new AppError("VALIDATION_ERROR", "Workflow reference contains a forbidden object key.", 400);
      }
      result[key] = visit(child, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}

function isWorkflowScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function serializeWorkflowState(state: WorkflowState): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Workflow state must contain JSON-compatible values.", 400, { cause });
  }
  if (new TextEncoder().encode(serialized).length > WORKFLOW_STATE_MAX_BYTES) {
    throw new AppError("VALIDATION_ERROR", "Workflow state exceeds the encrypted checkpoint size limit.", 413);
  }
  return serialized;
}

function parseWorkflowState(serialized: string): WorkflowState {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", "Encrypted workflow checkpoint is invalid JSON.", 500, { cause });
  }
  if (
    !isRecord(value) ||
    typeof value.workflowHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.workflowHash) ||
    !Number.isSafeInteger(value.nextStep) ||
    (value.nextStep as number) < 0 ||
    !isRecord(value.outputs) ||
    !isRecord(value.attempts) ||
    (value.inFlightStep !== undefined && typeof value.inFlightStep !== "string") ||
    Object.values(value.attempts).some((attempt) => !Number.isSafeInteger(attempt) || (attempt as number) < 1)
  ) {
    throw new AppError("INTERNAL_ERROR", "Encrypted workflow checkpoint has an invalid shape.", 500);
  }
  return value as unknown as WorkflowState;
}

function isRetryableWorkflowError(cause: unknown): boolean {
  return cause instanceof AppError && (cause.code === "DEPENDENCY_UNAVAILABLE" || cause.code === "RATE_LIMITED");
}

async function digestHex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function safelyDeleteSecret(writer: SecretWriter, tenantId: TenantId, reference: string): Promise<void> {
  await writer.delete(tenantId, reference).catch(() => undefined);
}

async function toolName(skillId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(skillId)));
  const suffix = Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const prefix = skillId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "installed";
  return `skill_${prefix}_${suffix}`;
}

export function validateJsonSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  strict: boolean,
): unknown {
  let visited = 0;
  const visit = (current: unknown, currentSchema: unknown, currentPath: string, depth: number): void => {
    visited += 1;
    if (
      visited > 1000 ||
      depth > 16 ||
      !currentSchema ||
      typeof currentSchema !== "object" ||
      Array.isArray(currentSchema)
    ) {
      throw new AppError("VALIDATION_ERROR", `Skill ${path} schema is invalid or too complex.`, 400);
    }
    const shape = currentSchema as Record<string, unknown>;
    const type = shape.type;
    const validType =
      type === undefined ||
      (type === "object" && current !== null && typeof current === "object" && !Array.isArray(current)) ||
      (type === "array" && Array.isArray(current)) ||
      (type === "string" && typeof current === "string") ||
      (type === "boolean" && typeof current === "boolean") ||
      (type === "integer" && typeof current === "number" && Number.isSafeInteger(current)) ||
      (type === "number" && typeof current === "number" && Number.isFinite(current)) ||
      (type === "null" && current === null);
    if (!validType)
      throw new AppError("VALIDATION_ERROR", `Skill ${path} did not match its schema at ${currentPath}.`, 400);
    if (Array.isArray(shape.enum) && !shape.enum.some((item) => JSON.stringify(item) === JSON.stringify(current))) {
      throw new AppError("VALIDATION_ERROR", `Skill ${path} did not match its schema at ${currentPath}.`, 400);
    }
    if (typeof current === "string") {
      if (typeof shape.minLength === "number" && current.length < shape.minLength)
        throw invalidSchemaValue(path, currentPath);
      if (typeof shape.maxLength === "number" && current.length > shape.maxLength)
        throw invalidSchemaValue(path, currentPath);
    }
    if (typeof current === "number") {
      if (typeof shape.minimum === "number" && current < shape.minimum) throw invalidSchemaValue(path, currentPath);
      if (typeof shape.maximum === "number" && current > shape.maximum) throw invalidSchemaValue(path, currentPath);
    }
    if (Array.isArray(current)) {
      if (typeof shape.minItems === "number" && current.length < shape.minItems)
        throw invalidSchemaValue(path, currentPath);
      if (typeof shape.maxItems === "number" && current.length > shape.maxItems)
        throw invalidSchemaValue(path, currentPath);
      if (shape.items !== undefined) {
        current.forEach((item, index) => {
          visit(item, shape.items, `${currentPath}[${index}]`, depth + 1);
        });
      }
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      const properties = shape.properties;
      if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) {
        throw new AppError("VALIDATION_ERROR", `Skill ${path} schema has invalid properties.`, 400);
      }
      const propertySchemas = (properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(shape.required) ? shape.required : [];
      for (const key of required) {
        if (typeof key !== "string" || !(key in current))
          throw invalidSchemaValue(path, `${currentPath}.${String(key)}`);
      }
      for (const [key, item] of Object.entries(current)) {
        const propertySchema = propertySchemas[key];
        if (propertySchema === undefined) {
          if (strict && shape.additionalProperties !== true) throw invalidSchemaValue(path, `${currentPath}.${key}`);
        } else {
          visit(item, propertySchema, `${currentPath}.${key}`, depth + 1);
        }
      }
    }
  };
  visit(value, schema, "$", 0);
  return value;
}

function invalidSchemaValue(kind: string, path: string): AppError {
  return new AppError("VALIDATION_ERROR", `Skill ${kind} did not match its schema at ${path}.`, 400);
}

function normalizeAllowedOrigins(values: ReadonlySet<string>): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", "HTTP_SKILL_ALLOWED_ORIGINS contains an invalid origin.", 400, {
        cause,
      });
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new AppError("VALIDATION_ERROR", "HTTP skill allowlist must contain HTTPS origins only.", 400);
    }
    origins.add(url.origin);
  }
  return origins;
}

function validateHeader(name: string, value: string): void {
  const lowerName = name.toLowerCase();
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
    FORBIDDEN_HEADERS.has(lowerName) ||
    /(?:^|[-_])(api[-_]?key|token|secret|password|authorization|auth)(?:$|[-_])/.test(lowerName) ||
    hasControlCharacters(value) ||
    value.length > 4096
  ) {
    throw new AppError("VALIDATION_ERROR", "HTTP skill contains an invalid or restricted header.", 400);
  }
}

function validateCredentialHeaderName(name: string): void {
  const lowerName = name.toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || FORBIDDEN_HEADERS.has(lowerName)) {
    throw new AppError("VALIDATION_ERROR", "HTTP skill credential header name is invalid.", 400);
  }
}

function validateCredentialValue(value: string): void {
  if (!value || value.length > 4096 || hasControlCharacters(value)) {
    throw new AppError("VALIDATION_ERROR", "Resolved HTTP skill credential is invalid.", 400);
  }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill response exceeded the size limit.", 502);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill response exceeded the size limit.", 502);
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("DEPENDENCY_UNAVAILABLE", "HTTP skill returned invalid JSON.", 502, { cause });
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new AppError("DEPENDENCY_UNAVAILABLE", "Skill retry was cancelled.", 504);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new AppError("DEPENDENCY_UNAVAILABLE", "Skill retry was cancelled.", 504));
    };
    const timeout = setTimeout(finish, Math.min(milliseconds, 5_000));
    signal.addEventListener("abort", abort, { once: true });
  });
}
