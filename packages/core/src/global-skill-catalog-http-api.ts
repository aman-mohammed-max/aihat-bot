import { AppError } from "./errors.js";
import { isOperatorRequestAuthorized, isOperatorTokenConfigured } from "./operator-auth.js";
import { validateSkillCatalogPublication } from "./skill-data.js";
import { validateSkillDefinitionForPublication } from "./skill-engine.js";
import type { NativeSkillRegistry } from "./native-skills.js";
import type { SkillRepository } from "./ports.js";
import type { SkillDefinition } from "./types.js";

const GLOBAL_SKILLS_ROUTE = "/_operator/skills";
const GLOBAL_SKILL_ROUTE = /^\/_operator\/skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

/** Platform-operator API for reviewing and distributing skills to every tenant. */
export function createGlobalSkillCatalogAdminHandler(input: {
  readonly skills: SkillRepository;
  readonly authorizationToken: string;
  readonly nativeSkills?: NativeSkillRegistry;
}): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const collectionRoute = url.pathname === GLOBAL_SKILLS_ROUTE;
    const itemRoute = GLOBAL_SKILL_ROUTE.exec(url.pathname);
    if (!collectionRoute && !itemRoute) return undefined;
    if (!isOperatorTokenConfigured(input.authorizationToken)) {
      return errorResponse(503, "UNSUPPORTED_CAPABILITY", "Global skill catalog administration is not configured.");
    }
    if (!isOperatorRequestAuthorized(request, input.authorizationToken)) {
      return errorResponse(401, "UNAUTHENTICATED", "Operator authorization is invalid.", {
        "www-authenticate": "Bearer",
      });
    }

    try {
      if (collectionRoute && request.method === "GET") {
        const catalog = await input.skills.listGlobalCatalog();
        return Response.json(catalog.map(skillSummary), { headers: noStoreHeaders() });
      }
      if (collectionRoute && request.method === "POST") {
        const definition = validateSkillCatalogPublication(await readJsonBody(request), {
          allowNative: input.nativeSkills !== undefined,
        });
        if (definition.executionType === "native" && !input.nativeSkills?.matchesDefinition(definition)) {
          throw new AppError(
            "VALIDATION_ERROR",
            "Native skill metadata must exactly match a code-registered reviewed handler.",
            400,
          );
        }
        const catalog = await input.skills.listGlobalCatalog();
        const published: SkillDefinition = { ...definition, tenantId: null, enabled: true };
        validateSkillDefinitionForPublication(published, catalog);
        await input.skills.publishGlobalCatalogSkill({ definition });
        return Response.json({ skill: skillSummary(published) }, { status: 201, headers: noStoreHeaders() });
      }
      if (itemRoute && request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") {
          throw new AppError("VALIDATION_ERROR", "Global skill enabled must be a boolean.", 400);
        }
        const skillId = itemRoute[1];
        if (!skillId) return undefined;
        await input.skills.setGlobalCatalogSkillEnabled(skillId, body.enabled);
        return Response.json({ skillId, enabled: body.enabled }, { headers: noStoreHeaders() });
      }
      return methodNotAllowed(collectionRoute ? "GET, POST" : "PATCH");
    } catch (cause) {
      if (cause instanceof AppError) return errorResponse(cause.status, cause.code, cause.message);
      return errorResponse(500, "INTERNAL_ERROR", "Global skill catalog operation could not be completed.");
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
    { status: 405, headers: { allow, ...noStoreHeaders() } },
  );
}

function errorResponse(status: number, error: string, message: string, extra: HeadersInit = {}): Response {
  return Response.json(
    { error, message },
    { status, headers: { ...noStoreHeaders(), ...Object.fromEntries(new Headers(extra).entries()) } },
  );
}

function noStoreHeaders(): Record<string, string> {
  return { "cache-control": "no-store", pragma: "no-cache" };
}
