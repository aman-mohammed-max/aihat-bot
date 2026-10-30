import { AppError } from "./errors.js";
import type {
  AgentEngine,
  ApiConversationRepository,
  BotRepository,
  ConversationRepository,
  ScheduledTaskRepository,
  ScheduledTaskScheduler,
} from "./ports.js";
import type { BotId, JobId, ScheduledTask, ScheduledTaskId, TenantId, UserId } from "./types.js";

export interface ScheduledTaskNotifier {
  assertScheduledRecipient(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly telegramUserId: number;
  }): Promise<void>;
  sendScheduledMessage(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly telegramUserId: number;
    readonly text: string;
  }): Promise<void>;
}

export class ScheduledTaskService {
  constructor(
    private readonly tasks: ScheduledTaskRepository,
    private readonly bots: BotRepository,
    private readonly notifier: ScheduledTaskNotifier,
    private readonly scheduler?: ScheduledTaskScheduler,
  ) {}

  async create(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly schedule: string;
    readonly timezone: string;
    readonly prompt: string;
    readonly notifyTelegramUserId: number;
    readonly now?: string;
  }): Promise<ScheduledTask> {
    const bot = await this.bots.get(input.tenantId, input.botId);
    if (!bot || bot.ownerId !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    if (bot.status !== "published") throw new AppError("CONFLICT", "Publish the bot before scheduling tasks.", 409);
    if (input.prompt.trim().length < 1 || input.prompt.length > 10_000) {
      throw new AppError("VALIDATION_ERROR", "Scheduled prompt must contain 1 to 10000 characters.", 400);
    }
    validateTimeZone(input.timezone);
    await this.notifier.assertScheduledRecipient({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      botId: input.botId,
      telegramUserId: input.notifyTelegramUserId,
    });
    const parsed = parseTaskSchedule(input.schedule);
    const now = input.now ?? new Date().toISOString();
    const normalizedSchedule = parsed.type === "once" ? `once:${parsed.at}` : input.schedule;
    const runAt = nextTaskRunAt(normalizedSchedule, input.timezone, now);
    if (!runAt) throw new AppError("VALIDATION_ERROR", "Scheduled time must be in the future.", 400);
    const taskId = `task_${crypto.randomUUID().replaceAll("-", "")}` as ScheduledTaskId;
    const jobId = await stableJobId(taskId, runAt);
    const task: ScheduledTask = {
      id: taskId,
      tenantId: input.tenantId,
      botId: input.botId,
      ownerId: input.ownerId,
      schedule: normalizedSchedule,
      timezone: input.timezone,
      prompt: input.prompt.trim(),
      notifyTelegramUserId: input.notifyTelegramUserId,
      status: "active",
      nextRunAt: runAt,
      createdAt: now,
      updatedAt: now,
    };
    await this.tasks.createScheduledTask({ task, firstJobId: jobId, idempotencyKey: `${taskId}:${runAt}` });
    try {
      await this.#schedule(task, runAt, jobId);
    } catch (cause) {
      await this.tasks.setScheduledTaskStatus({
        tenantId: task.tenantId,
        ownerId: task.ownerId,
        taskId: task.id,
        status: "failed",
        now: new Date().toISOString(),
      });
      throw cause;
    }
    return task;
  }

  async list(input: { readonly tenantId: TenantId; readonly ownerId: UserId; readonly botId: BotId }) {
    const bot = await this.bots.get(input.tenantId, input.botId);
    if (!bot || bot.ownerId !== input.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
    return this.tasks.listOwnedScheduledTasks(input);
  }

  async get(input: { readonly tenantId: TenantId; readonly ownerId: UserId; readonly taskId: ScheduledTaskId }) {
    const task = await this.tasks.getScheduledTask(input);
    if (!task || task.ownerId !== input.ownerId) throw new AppError("NOT_FOUND", "Scheduled task was not found.", 404);
    return task;
  }

  async setPaused(input: {
    readonly tenantId: TenantId;
    readonly ownerId: UserId;
    readonly taskId: ScheduledTaskId;
    readonly paused: boolean;
    readonly now?: string;
  }): Promise<ScheduledTask> {
    const task = await this.get(input);
    const now = input.now ?? new Date().toISOString();
    if (input.paused) {
      if (task.status === "paused") return task;
      if (task.status !== "active") throw new AppError("CONFLICT", "Only active scheduled tasks can be paused.", 409);
      await this.tasks.setScheduledTaskStatus({ ...input, status: "paused", now });
      await this.scheduler?.cancel({ tenantId: task.tenantId, botId: task.botId, taskId: task.id });
      return { ...task, status: "paused", updatedAt: now };
    }
    if (task.status === "active") return task;
    if (task.status !== "paused") throw new AppError("CONFLICT", "Only paused scheduled tasks can be resumed.", 409);
    const runAt = nextTaskRunAt(task.schedule, task.timezone, now);
    if (!runAt) throw new AppError("CONFLICT", "A completed one-time task cannot be resumed.", 409);
    const jobId = await stableJobId(task.id, `${runAt}:resume`);
    const idempotencyKey = `${task.id}:${runAt}:resume`;
    await this.tasks.createScheduledRunJob({
      tenantId: task.tenantId,
      taskId: task.id,
      jobId,
      runAt,
      idempotencyKey,
      now,
    });
    await this.#schedule(task, runAt, jobId);
    await this.tasks.setScheduledTaskStatus({ ...input, status: "active", nextRunAt: runAt, now });
    return { ...task, status: "active", nextRunAt: runAt, updatedAt: now };
  }

  async #schedule(task: ScheduledTask, runAt: string, jobId: JobId): Promise<void> {
    await this.scheduler?.schedule({
      tenantId: task.tenantId,
      botId: task.botId,
      taskId: task.id,
      runAt,
      timezone: task.timezone,
      payloadRef: jobId,
    });
  }
}

export type ScheduledTaskRunResult = "completed" | "retrying" | "failed" | "cancelled" | "not_claimed";

export class ScheduledTaskRunner {
  constructor(
    private readonly tasks: ScheduledTaskRepository,
    private readonly bots: BotRepository,
    private readonly conversations: ApiConversationRepository & ConversationRepository,
    private readonly engine: AgentEngine,
    private readonly notifier: ScheduledTaskNotifier,
    private readonly scheduler?: ScheduledTaskScheduler,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async process(jobId: JobId, now = this.clock()): Promise<ScheduledTaskRunResult> {
    const job = await this.tasks.claimScheduledJob({
      jobId,
      now,
      leaseUntil: new Date(Date.parse(now) + 600_000).toISOString(),
    });
    if (!job) {
      const existing = await this.tasks.getScheduledJob({ jobId });
      if (!existing) return "failed";
      if (existing.status === "succeeded") return "completed";
      if (existing.status === "failed") return "failed";
      if (existing.status === "cancelled") return "cancelled";
      return "not_claimed";
    }
    const task = await this.tasks.getScheduledTask({ tenantId: job.tenantId, taskId: job.taskId });
    if (task?.status !== "active") {
      await this.tasks.failScheduledJob({ jobId: job.id, now });
      return "cancelled";
    }
    try {
      const bot = await this.bots.get(task.tenantId, task.botId);
      if (bot?.status !== "published") throw new AppError("CONFLICT", "Scheduled bot is unavailable.", 409);
      let resultText = job.resultText;
      if (resultText === undefined) {
        const conversationId = await this.conversations.getOrCreateApiConversation({
          tenantId: task.tenantId,
          botId: task.botId,
          actorId: task.ownerId,
          conversationKey: `scheduled:${task.id}:${job.id}`,
        });
        const history = await this.conversations.load(task.tenantId, conversationId, 100);
        resultText = recoverAgentResult(history, task.prompt);
        if (resultText === undefined) {
          const result = await this.engine.respond({
            bot,
            conversationId,
            actorId: task.ownerId,
            actorContext: { platform: "scheduled" },
            messages: [{ role: "user", content: task.prompt }],
          });
          resultText = result.message.content.slice(0, 100_000);
        }
        await this.tasks.saveScheduledJobResult({ jobId: job.id, resultText, now: laterTimestamp(now, this.clock()) });
      }
      if (resultText) {
        await this.notifier.sendScheduledMessage({
          tenantId: task.tenantId,
          ownerId: task.ownerId,
          botId: task.botId,
          telegramUserId: task.notifyTelegramUserId,
          text: resultText,
        });
      }
      const completedAt = laterTimestamp(now, this.clock());
      const nextRunAt = nextTaskRunAt(task.schedule, task.timezone, completedAt);
      if (nextRunAt) {
        const nextJobId = await stableJobId(task.id, nextRunAt);
        await this.tasks.createScheduledRunJob({
          tenantId: task.tenantId,
          taskId: task.id,
          jobId: nextJobId,
          runAt: nextRunAt,
          idempotencyKey: `${task.id}:${nextRunAt}`,
          now: completedAt,
        });
        await this.#schedule(task, nextRunAt, nextJobId);
      }
      await this.tasks.completeScheduledRun({
        tenantId: task.tenantId,
        taskId: task.id,
        jobId: job.id,
        ...(nextRunAt ? { nextRunAt } : {}),
        now: completedAt,
      });
      return "completed";
    } catch {
      const failedAt = laterTimestamp(now, this.clock());
      if (job.attempts >= 5) {
        await this.tasks.failScheduledJob({ jobId: job.id, now: failedAt });
        await this.tasks.setScheduledTaskStatus({
          tenantId: task.tenantId,
          ownerId: task.ownerId,
          taskId: task.id,
          status: "failed",
          now: failedAt,
        });
        return "failed";
      }
      const delay = Math.min(3_600_000, 30_000 * 2 ** (job.attempts - 1));
      const availableAt = new Date(Date.parse(failedAt) + delay).toISOString();
      await this.tasks.retryScheduledJob({ jobId: job.id, availableAt, now: failedAt });
      await this.#schedule(task, availableAt, job.id);
      return "retrying";
    }
  }

  async runDueBatch(now = new Date().toISOString(), limit = 10): Promise<number> {
    const jobs = await this.tasks.listDueScheduledJobIds({ now, limit });
    for (const jobId of jobs) await this.process(jobId, now);
    return jobs.length;
  }

  async #schedule(task: ScheduledTask, runAt: string, jobId: JobId): Promise<void> {
    await this.scheduler?.schedule({
      tenantId: task.tenantId,
      botId: task.botId,
      taskId: task.id,
      runAt,
      timezone: task.timezone,
      payloadRef: jobId,
    });
  }
}

async function stableJobId(taskId: string, runKey: string): Promise<JobId> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${taskId}:${runKey}`)));
  const suffix = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `job_${suffix}` as JobId;
}

function validateTimeZone(timezone: string): void {
  if (timezone.length < 1 || timezone.length > 128) {
    throw new AppError("VALIDATION_ERROR", "Schedule timezone is invalid.", 400);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Schedule timezone is invalid.", 400, { cause });
  }
}

function laterTimestamp(left: string, right: string): string {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return new Date(Math.max(leftMs, rightMs)).toISOString();
}

function recoverAgentResult(
  messages: readonly { readonly role: string; readonly content: string; readonly toolCalls?: unknown }[],
  prompt: string,
): string | undefined {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0 || messages[userIndex]?.content !== prompt) return undefined;
  for (let index = messages.length - 1; index > userIndex; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.toolCalls === undefined) return message.content;
  }
  return undefined;
}

export type ParsedTaskSchedule =
  | { readonly type: "once"; readonly at: string }
  | { readonly type: "daily"; readonly time: string };

/** Supported schedule strings keep recurrence rules portable between SQLite, D1, and Workers. */
export function parseTaskSchedule(value: string): ParsedTaskSchedule {
  if (value.startsWith("once:")) {
    const at = value.slice("once:".length);
    if (!Number.isFinite(Date.parse(at))) throw new AppError("VALIDATION_ERROR", "One-time schedule is invalid.", 400);
    return { type: "once", at: new Date(at).toISOString() };
  }
  if (value.startsWith("daily:")) {
    const time = value.slice("daily:".length);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new AppError("VALIDATION_ERROR", "Daily schedule time must use 24-hour HH:mm format.", 400);
    }
    return { type: "daily", time };
  }
  throw new AppError("VALIDATION_ERROR", "Schedule must be once:<ISO timestamp> or daily:HH:mm.", 400);
}

/** Compute the next occurrence using the user's timezone, including DST gaps and overlaps. */
export function nextTaskRunAt(
  schedule: string,
  timezone: string,
  after: string | number = Date.now(),
): string | undefined {
  const parsed = parseTaskSchedule(schedule);
  const afterMs = typeof after === "number" ? after : Date.parse(after);
  if (!Number.isFinite(afterMs)) throw new AppError("VALIDATION_ERROR", "Schedule reference time is invalid.", 400);
  if (parsed.type === "once") return Date.parse(parsed.at) > afterMs ? parsed.at : undefined;

  let localDate = getLocalDate(afterMs, timezone);
  for (let day = 0; day < 370; day += 1) {
    const matches = localTimeCandidates(localDate, parsed.time, timezone);
    const future = matches.filter((candidate) => candidate > afterMs).sort((a, b) => a - b);
    if (future[0] !== undefined) return new Date(future[0]).toISOString();
    localDate = incrementDate(localDate, 1);
  }
  throw new AppError("VALIDATION_ERROR", "No future daily occurrence could be calculated.", 400);
}

type LocalDate = { readonly year: number; readonly month: number; readonly day: number };
type LocalDateTime = LocalDate & { readonly hour: number; readonly minute: number };

function localTimeCandidates(date: LocalDate, time: string, timezone: string): number[] {
  const [hourText, minuteText] = time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const desired: LocalDateTime = { ...date, hour, minute };
  const targetUtcLike = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const offsets = new Set<number>();
  for (const deltaHours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = targetUtcLike + deltaHours * 3_600_000;
    offsets.add(localPseudoTimestamp(getLocalDateTime(sample, timezone)) - Math.floor(sample / 60_000) * 60_000);
  }
  const exact: number[] = [];
  const afterGap: { readonly timestamp: number; readonly localMinute: number }[] = [];
  for (const offset of offsets) {
    const candidate = targetUtcLike - offset;
    const local = getLocalDateTime(candidate, timezone);
    if (sameLocalDateTime(local, desired)) {
      exact.push(candidate);
      continue;
    }
    if (sameDate(local, date)) {
      const localMinute = local.hour * 60 + local.minute;
      if (localMinute > hour * 60 + minute) afterGap.push({ timestamp: candidate, localMinute });
    }
  }
  if (exact.length > 0) return exact;
  afterGap.sort((a, b) => a.localMinute - b.localMinute || a.timestamp - b.timestamp);
  return afterGap[0] ? [afterGap[0].timestamp] : [];
}

function getLocalDate(timestamp: number, timezone: string): LocalDate {
  const { year, month, day } = getLocalDateTime(timestamp, timezone);
  return { year, month, day };
}

function getLocalDateTime(timestamp: number, timezone: string): LocalDateTime {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(timestamp);
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    return {
      year: value("year"),
      month: value("month"),
      day: value("day"),
      hour: value("hour"),
      minute: value("minute"),
    };
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Schedule timezone is invalid.", 400, { cause });
  }
}

function localPseudoTimestamp(value: LocalDateTime): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return sameDate(left, right) && left.hour === right.hour && left.minute === right.minute;
}

function sameDate(left: LocalDate, right: LocalDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function incrementDate(value: LocalDate, days: number): LocalDate {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
