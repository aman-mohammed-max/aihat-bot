import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import { validateSkillCatalogPublication, validateSkillInstallation } from "./skill-data.js";
import { validateSkillDefinitionForPublication } from "./skill-engine.js";
import type { BotRepository, SecretStore, SkillRepository } from "./ports.js";
import type { BotId, InstalledSkill, SkillDefinition } from "./types.js";

const BOT_ID = "bot_[a-f0-9-]{36}";
const BOT_SKILLS_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/skills$`);
const BOT_SKILL_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/skills/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$`);

/** Owner-scoped catalog and bot skill installation API. */
export function createSkillsApiHandler(
  authenticator: ApiTokenAuthenticator,
  bots: BotRepository,
  skills: SkillRepository,
  secrets: SecretStore,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    const catalogRoute = pathname === "/v1/skills";
    const botSkills = BOT_SKILLS_ROUTE.exec(pathname);
    const botSkill = BOT_SKILL_ROUTE.exec(pathname);
    if (!catalogRoute && !botSkills && !botSkill) return undefined;

    try {
      const principal = await authenticator.authenticate(request);
      if (catalogRoute) {
        if (request.method === "GET") {
          await requireApiScope(principal, "bots:read");
          const catalog = await skills.listCatalog(principal.tenantId);
          return Response.json(catalog.map(skillSummary), { headers: { "cache-control": "no-store" } });
        }
        if (request.method !== "POST") return methodNotAllowed("GET, POST");
        await requireApiScope(principal, "skills:publish");
        const definition = validateSkillCatalogPublication(await readJsonBody(request));
        const catalog = await skills.listCatalog(principal.tenantId);
        validateSkillDefinitionForPublication({ ...definition, tenantId: principal.tenantId, enabled: true }, catalog);
        await skills.publishCatalogSkill({ tenantId: principal.tenantId, definition });
        return Response.json(
          { skill: skillSummary({ ...definition, tenantId: principal.tenantId, enabled: true }) },
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      }

      const botId = (botSkills?.[1] ?? botSkill?.[1]) as BotId | undefined;
      if (!botId) return undefined;
      const bot = await bots.get(principal.tenantId, botId);
      if (!bot || bot.ownerId !== principal.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);

      if (botSkills) {
        if (request.method === "GET") {
          await requireApiScope(principal, "bots:read");
          const installed = await skills.listInstalled(principal.tenantId, botId);
          return Response.json(installed.map(installedSummary), { headers: { "cache-control": "no-store" } });
        }
        if (request.method !== "POST") return methodNotAllowed("GET, POST");
        await requireApiScope(principal, "bots:write");
        const body = await readJsonBody(request);
        if (
          typeof body.skillId !== "string" ||
          !isRecord(body.configuration ?? {}) ||
          !Array.isArray(body.grantedPermissions)
        ) {
          throw new AppError("VALIDATION_ERROR", "Skill installation settings are invalid.", 400);
        }
        const definition = await skills.getCatalogSkill(principal.tenantId, body.skillId);
        if (!definition) throw new AppError("NOT_FOUND", "Skill was not found in this tenant's catalog.", 404);
        const grantedPermissions = body.grantedPermissions;
        if (grantedPermissions.some((permission) => typeof permission !== "string")) {
          throw new AppError("VALIDATION_ERROR", "Skill permission grants are invalid.", 400);
        }
        const validated = validateSkillInstallation(
          definition,
          (body.configuration ?? {}) as Record<string, unknown>,
          grantedPermissions as string[],
        );
        const configuration = validated.configuration;
        if (configuration.credentialRef) {
          await secrets.resolve(principal.tenantId, configuration.credentialRef);
        }
        await skills.install({
          tenantId: principal.tenantId,
          botId,
          skillId: definition.id,
          installedBy: principal.ownerId,
          configuration,
          grantedPermissions: validated.grantedPermissions,
        });
        return Response.json(
          { skill: skillSummary(definition), enabled: true },
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      }

      const skillId = botSkill?.[2];
      if (!skillId) return undefined;
      await requireApiScope(principal, "bots:write");
      if (request.method === "DELETE") {
        await skills.uninstall({ tenantId: principal.tenantId, botId, skillId });
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (request.method !== "PATCH") return methodNotAllowed("PATCH, DELETE");
      const body = await readJsonBody(request);
      if (typeof body.enabled !== "boolean") {
        throw new AppError("VALIDATION_ERROR", "Skill enabled must be a boolean.", 400);
      }
      await skills.setEnabled({ tenantId: principal.tenantId, botId, skillId, enabled: body.enabled });
      return Response.json({ skillId, enabled: body.enabled }, { headers: { "cache-control": "no-store" } });
    } catch (cause) {
      if (cause instanceof AppError) {
        await recordApiAuthorizationDenial(request, cause);
        return Response.json(
          { error: cause.code, message: cause.message },
          {
            status: cause.status,
            headers: {
              "cache-control": "no-store",
              ...(cause.status === 401 ? { "www-authenticate": "Bearer" } : {}),
            },
          },
        );
      }
      return Response.json(
        { error: "INTERNAL_ERROR", message: "The request could not be completed." },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  };
}

function skillSummary(skill: SkillDefinition) {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    author: skill.author,
    category: skill.category,
    description: skill.description,
    executionType: skill.executionType,
    inputSchema: skill.inputSchema,
    outputSchema: skill.outputSchema,
    requiredPermissions: skill.requiredPermissions,
    enabled: skill.enabled,
  };
}

function installedSummary(skill: InstalledSkill) {
  return {
    ...skillSummary(skill.definition),
    enabled: skill.enabled && skill.definition.enabled,
    grantedPermissions: skill.grantedPermissions,
    hasCredential: typeof skill.configuration.credentialRef === "string",
    installedBy: skill.installedBy,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > 16_384) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let value: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 16_384) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    value = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!isRecord(value)) throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow, "cache-control": "no-store" } },
  );
}
