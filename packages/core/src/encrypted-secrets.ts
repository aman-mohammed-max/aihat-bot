import { AppError } from "./errors.js";
import type { SecretKeyring, SecretRecordRepository, SecretStore, SecretWriter } from "./ports.js";
import type { TenantId } from "./types.js";

const MAX_SECRET_BYTES = 64 * 1024;

/** AES-GCM envelope encryption. The repository stores ciphertext only; key material remains in a runtime secret binding. */
export class EncryptedSecretStore implements SecretStore, SecretWriter {
  readonly #records: SecretRecordRepository;
  readonly #keyring: SecretKeyring;
  readonly #keyCache = new Map<string, Promise<CryptoKey>>();

  constructor(records: SecretRecordRepository, keyring: SecretKeyring) {
    this.#records = records;
    this.#keyring = keyring;
  }

  async put(tenantId: TenantId, plaintext: string): Promise<string> {
    if (
      typeof plaintext !== "string" ||
      plaintext.length === 0 ||
      new TextEncoder().encode(plaintext).length > MAX_SECRET_BYTES
    ) {
      throw new AppError("VALIDATION_ERROR", "Credential must contain between 1 byte and 64 KiB.", 400);
    }
    const reference = `secret_${crypto.randomUUID().replaceAll("-", "")}`;
    const active = await this.#keyring.activeKey();
    const key = await this.#importKey(active.id, active.material);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = aad(tenantId, reference);
    try {
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(additionalData), tagLength: 128 },
        key,
        toArrayBuffer(new TextEncoder().encode(plaintext)),
      );
      await this.#records.create({
        tenantId,
        reference,
        keyId: active.id,
        nonce: encodeBase64(nonce),
        ciphertext: encodeBase64(new Uint8Array(ciphertext)),
        version: 1,
        createdAt: new Date().toISOString(),
      });
      return reference;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Credential encryption or persistence failed.", 503, { cause });
    }
  }

  async resolve(tenantId: TenantId, reference: string, signal?: AbortSignal): Promise<string> {
    assertNotAborted(signal);
    const record = await this.#records.get(tenantId, reference);
    if (!record || record.tenantId !== tenantId || record.reference !== reference || record.version !== 1) {
      throw new AppError("NOT_FOUND", "Credential reference was not found.", 404);
    }
    const material = await this.#keyring.getKey(record.keyId);
    if (!material) throw new AppError("DEPENDENCY_UNAVAILABLE", "Credential encryption key is unavailable.", 503);
    const key = await this.#importKey(record.keyId, material);
    assertNotAborted(signal);
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(decodeBase64(record.nonce)),
          additionalData: toArrayBuffer(aad(tenantId, reference)),
          tagLength: 128,
        },
        key,
        toArrayBuffer(decodeBase64(record.ciphertext)),
      );
      assertNotAborted(signal);
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Credential decryption failed.", 503);
    }
  }

  async delete(tenantId: TenantId, reference: string): Promise<void> {
    await this.#records.delete(tenantId, reference);
  }

  async #importKey(id: string, material: Uint8Array): Promise<CryptoKey> {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || material.byteLength !== 32) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Credential encryption key configuration is invalid.", 503);
    }
    let pending = this.#keyCache.get(id);
    if (!pending) {
      pending = crypto.subtle.importKey("raw", toArrayBuffer(material), { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
      this.#keyCache.set(id, pending);
      pending.catch(() => this.#keyCache.delete(id));
    }
    return pending;
  }
}

function aad(tenantId: TenantId, reference: string): Uint8Array {
  return new TextEncoder().encode(`aihat-secret-v1\u0000${tenantId}\u0000${reference}`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(""));
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch (cause) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Stored credential envelope is invalid.", 503, { cause });
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError("DEPENDENCY_UNAVAILABLE", "Credential operation was cancelled.", 503);
}
