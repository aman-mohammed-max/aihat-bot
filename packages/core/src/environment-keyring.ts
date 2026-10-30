import { AppError } from "./errors.js";
import type { SecretKeyring } from "./ports.js";

/** Parses deployment-injected 32-byte base64 keys without persisting key material. */
export class EnvironmentSecretKeyring implements SecretKeyring {
  readonly #activeId: string;
  readonly #keys: ReadonlyMap<string, Uint8Array>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    const activeId = env.SECRET_ACTIVE_KEY_ID;
    const serializedKeys = env.SECRET_KEYRING_JSON;
    if (!activeId || !serializedKeys) {
      throw new AppError(
        "DEPENDENCY_UNAVAILABLE",
        "Credential encryption keys are not configured for this runtime.",
        503,
      );
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(activeId)) {
      throw new AppError("VALIDATION_ERROR", "SECRET_ACTIVE_KEY_ID is invalid.", 400);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serializedKeys);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", "SECRET_KEYRING_JSON must be a JSON object of base64 keys.", 400, {
        cause,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError("VALIDATION_ERROR", "SECRET_KEYRING_JSON must be a JSON object of base64 keys.", 400);
    }

    const keys = new Map<string, Uint8Array>();
    for (const [id, encoded] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || typeof encoded !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
        throw new AppError("VALIDATION_ERROR", "SECRET_KEYRING_JSON contains an invalid key entry.", 400);
      }
      let material: Uint8Array;
      try {
        material = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      } catch (cause) {
        throw new AppError("VALIDATION_ERROR", "SECRET_KEYRING_JSON contains invalid base64.", 400, { cause });
      }
      if (material.byteLength !== 32) {
        throw new AppError("VALIDATION_ERROR", "Each secret encryption key must decode to exactly 32 bytes.", 400);
      }
      keys.set(id, material);
    }
    if (!keys.has(activeId)) {
      throw new AppError("VALIDATION_ERROR", "The active key ID is missing from SECRET_KEYRING_JSON.", 400);
    }
    this.#activeId = activeId;
    this.#keys = keys;
  }

  async activeKey(): Promise<{ readonly id: string; readonly material: Uint8Array }> {
    const material = this.#keys.get(this.#activeId);
    if (!material) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Active credential encryption key is unavailable.", 503);
    }
    return { id: this.#activeId, material: material.slice() };
  }

  async getKey(id: string): Promise<Uint8Array | undefined> {
    return this.#keys.get(id)?.slice();
  }
}
