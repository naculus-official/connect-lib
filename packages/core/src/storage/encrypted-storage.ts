/**
 * Encrypted Storage Adapter
 *
 * Provides AES-256-GCM encryption + PBKDF2 key derivation
 * for encrypting/decrypting string values using Web Crypto API.
 *
 * Design:
 * - Pure encrypt/decrypt interface (not tied to any storage backend)
 * - Uses Web Crypto API (crypto.subtle) for AES-256-GCM
 * - PBKDF2 iterations >= 600K (OWASP 2025 recommended)
 * - Random salt + IV per encryption
 *
 * Usage:
 * ```ts
 * const adapter = new WebCryptoEncryptedStorageAdapter();
 * const ciphertext = await adapter.encrypt("my secret data", encryptionKey);
 * const plaintext = await adapter.decrypt(ciphertext, encryptionKey);
 * ```
 *
 * @see packages/wallet-engine/src/storage/encrypted.ts
 * @see docs/features/session-keys.md
 */

// ─── Constants ─────────────────────────────────────────────────────────

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_ITERATIONS = 600_000;

// ─── Helpers ───────────────────────────────────────────────────────────

function textEncode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function textDecode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function buf2hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hex2buf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function deriveKey(
  keyMaterial: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial as any,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: KEY_ITERATIONS,
      hash: "SHA-256",
    },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ─── Interface ─────────────────────────────────────────────────────────

/**
 * EncryptedStorageAdapter — unified encrypt/decrypt interface.
 *
 * The encrypt method returns a JSON string containing the IV, salt,
 * and ciphertext, which can be stored as a single value.
 * The decrypt method parses that same format.
 */
export interface EncryptedStorageAdapter {
  /**
   * Encrypt a raw string value.
   * @param value - Plaintext string to encrypt
   * @param key - Encryption key material (raw bytes, 32 bytes recommended)
   * @returns JSON-encoded string with IV, salt, and AES-256-GCM ciphertext
   */
  encrypt(value: string, key: Uint8Array): Promise<string>;

  /**
   * Decrypt a previously encrypted value.
   * @param ciphertext - JSON-encoded string from encrypt()
   * @param key - Same encryption key material used during encrypt
   * @returns Original plaintext string
   * @throws If key is wrong or data is corrupted
   */
  decrypt(ciphertext: string, key: Uint8Array): Promise<string>;
}

/**
 * Encrypted payload structure stored as JSON.
 */
export interface EncryptedPayload {
  /** PBKDF2 salt (hex) */
  salt: string;
  /** AES-GCM initialization vector (hex) */
  iv: string;
  /** AES-256-GCM ciphertext (hex, includes auth tag) */
  ciphertext: string;
}

// ─── Implementation ────────────────────────────────────────────────────

export class WebCryptoEncryptedStorageAdapter
  implements EncryptedStorageAdapter
{
  /**
   * Encrypt a value using AES-256-GCM with PBKDF2 key derivation.
   *
   * Generates a random salt and IV for each encryption.
   * The ciphertext is stored as a JSON string containing
   * the salt, IV, and AES-256-GCM output.
   *
   * @param value - Plaintext to encrypt
   * @param key - 32-byte encryption key material
   * @returns JSON string with format { salt, iv, ciphertext }
   */
  async encrypt(value: string, key: Uint8Array): Promise<string> {
    if (!key || key.length === 0) {
      throw new Error("Encryption key must not be empty");
    }

    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const derivedKey = await deriveKey(key, salt);

    const encoded = textEncode(value);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as any },
      derivedKey,
      encoded as any,
    );

    const payload: EncryptedPayload = {
      salt: buf2hex(salt),
      iv: buf2hex(iv),
      ciphertext: buf2hex(new Uint8Array(ciphertext)),
    };

    return JSON.stringify(payload);
  }

  /**
   * Decrypt a value encrypted by encrypt().
   *
   * @param ciphertext - JSON string from encrypt()
   * @param key - Same 32-byte key used during encrypt
   * @returns Original plaintext string
   * @throws If key is wrong, data is corrupted, or format is invalid
   */
  async decrypt(ciphertext: string, key: Uint8Array): Promise<string> {
    if (!key || key.length === 0) {
      throw new Error("Decryption key must not be empty");
    }

    let payload: EncryptedPayload;
    try {
      payload = JSON.parse(ciphertext) as EncryptedPayload;
    } catch {
      throw new Error("Invalid encrypted payload: not valid JSON");
    }

    if (!payload.salt || !payload.iv || !payload.ciphertext) {
      throw new Error(
        "Invalid encrypted payload: missing salt, iv, or ciphertext",
      );
    }

    const salt = hex2buf(payload.salt);
    const iv = hex2buf(payload.iv);
    const encrypted = hex2buf(payload.ciphertext);

    const derivedKey = await deriveKey(key, salt);

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as any },
        derivedKey,
        encrypted as any,
      );
      return textDecode(new Uint8Array(decrypted));
    } catch {
      throw new Error(
        "Decryption failed. The key may be incorrect or data may be corrupted.",
      );
    }
  }

  /**
   * Check if Web Crypto API is available in the current environment.
   */
  isAvailable(): boolean {
    return (
      typeof crypto !== "undefined" &&
      typeof crypto.subtle !== "undefined" &&
      typeof crypto.getRandomValues !== "undefined"
    );
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

let _defaultAdapter: WebCryptoEncryptedStorageAdapter | null = null;

/**
 * Get or create a shared WebCryptoEncryptedStorageAdapter instance.
 */
export function getEncryptedStorageAdapter(): WebCryptoEncryptedStorageAdapter {
  if (!_defaultAdapter) {
    _defaultAdapter = new WebCryptoEncryptedStorageAdapter();
  }
  return _defaultAdapter;
}
