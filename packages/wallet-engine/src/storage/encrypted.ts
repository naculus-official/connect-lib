/**
 * Encrypted Storage Adapter — Wallet Engine
 *
 * Wraps a StorageAdapter with AES-256-GCM.
 *
 * The wallet JSON is encrypted once under a random data key, and that data key
 * is then wrapped separately for each way in — a passphrase, and optionally
 * WebAuthn PRF. Either wrap opens the record.
 *
 * That envelope is not decoration. Sealing directly under PRF would make the
 * passphrase useless against a PRF-sealed record: the bytes were never derived
 * from it, so "keep the passphrase as a fallback" would be an API that exists
 * and a recovery path that does not. Wrapping the data key twice is the only
 * shape in which a broken authenticator does not cost the local copy.
 *
 * The price is stated rather than hidden: a record with both wraps is only as
 * hard to open as the weaker of the two. `assessStorageSecurity()` reports
 * that instead of scoring it as if PRF alone were protecting it.
 */

import { WalletError } from "../errors";
import type { WalletData } from "../wallet";
import type { StorageAdapter } from "./types";
import {
  derivePrfWrappingKey,
  type PrfAvailability,
  type PrfUnlockProvider,
  type UnlockMethod,
  type UnlockState,
} from "./unlock";

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_ITERATIONS = 600_000;
const DATA_KEY_LENGTH = 32;
const PRF_SALT_LENGTH = 32;

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
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncode(passphrase) as any,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations,
      hash: "SHA-256",
    },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── Record shapes ─────────────────────────────────────────────────

/** Original single-envelope record. No version field; passphrase only. */
interface EncryptedRecordV1 {
  salt: string;
  iv: string;
  ciphertext: string;
}

interface WrapEntry {
  /** Random per write for the passphrase wrap; stable for the PRF wrap. */
  salt: string;
  iv: string;
  /** The data key, encrypted under this wrap's key. */
  key: string;
  /**
   * Recorded rather than assumed. A later change to KEY_ITERATIONS would
   * otherwise leave every existing record impossible to derive a key for, and
   * the same passphrase producing a different key reads as "invalid
   * passphrase" for a passphrase that was never wrong.
   */
  iterations?: number;
}

interface EncryptedRecordV2 {
  v: 2;
  iv: string;
  ciphertext: string;
  wraps: Partial<Record<UnlockMethod, WrapEntry>>;
}

function isV2(enc: unknown): enc is EncryptedRecordV2 {
  return (
    typeof enc === "object" &&
    enc !== null &&
    (enc as { v?: unknown }).v === 2 &&
    typeof (enc as { wraps?: unknown }).wraps === "object" &&
    (enc as { wraps?: unknown }).wraps !== null
  );
}

// ── Adapter ───────────────────────────────────────────────────────

export interface EncryptedStorageOptions {
  /**
   * Evaluates WebAuthn PRF. When supplied and the authenticator answers, every
   * write gains a PRF wrap in addition to the passphrase wrap — no opt-in
   * step, because a protection nobody switches on protects nobody.
   *
   * When it returns null the record is written passphrase-only and nothing
   * fails. That is the whole point of the fallback.
   */
  prf?: PrfUnlockProvider;
}

/**
 * EncryptedStorageAdapter — wraps a StorageAdapter with AES-256-GCM.
 */
export class EncryptedStorageAdapter implements StorageAdapter {
  readonly type = "encrypted" as const;
  private readonly inner: StorageAdapter;
  private readonly getPassphrase: () => Promise<string>;
  private readonly prf: PrfUnlockProvider | undefined;

  /**
   * Stable for the life of a record: the same salt must yield the same key or
   * the ciphertext stops opening. Recovered from the stored record rather than
   * regenerated, and written back unchanged.
   */
  private prfSalt: Uint8Array | null = null;
  /**
   * Derived once per session. Without this every save would raise a biometric
   * prompt, and a wallet that asks for a fingerprint on each mutation is one
   * the user turns off. Holding it is no weaker than the decrypted wallet that
   * is already in memory alongside it.
   */
  private prfKeyCache: { salt: string; key: CryptoKey } | null = null;
  private prfAvailability: PrfAvailability = "none";
  private sealedWith: UnlockMethod[] | null = null;

  constructor(
    inner: StorageAdapter,
    getPassphrase: () => Promise<string>,
    options: EncryptedStorageOptions = {},
  ) {
    this.inner = inner;
    this.getPassphrase = getPassphrase;
    this.prf = options.prf;
    this.prfAvailability = options.prf ? "unknown" : "none";
  }

  isAvailable(): boolean {
    return typeof crypto?.subtle !== "undefined" && this.inner.isAvailable();
  }

  /** What the unlock layer knows so far. Feeds the security report. */
  getUnlockState(): UnlockState {
    return { prf: this.prfAvailability, sealedWith: this.sealedWith };
  }

  /**
   * Derive the PRF wrapping key for a salt, or null when PRF cannot be used.
   *
   * Never throws: a caller on the save path must be able to write a
   * passphrase-only record, and a caller on the load path must be able to try
   * the passphrase wrap instead.
   */
  private async prfKeyFor(salt: Uint8Array): Promise<CryptoKey | null> {
    if (!this.prf) return null;
    const saltHex = buf2hex(salt);
    if (this.prfKeyCache?.salt === saltHex) return this.prfKeyCache.key;
    let output: Uint8Array | null = null;
    try {
      output = await this.prf.derive(salt);
    } catch {
      output = null;
    }
    if (!output || output.length === 0) {
      this.prfAvailability = "unavailable";
      return null;
    }
    const key = await derivePrfWrappingKey(output, salt);
    // Not kept beyond this call. The wrapping key is what the session needs.
    output.fill(0);
    this.prfAvailability = "available";
    this.prfKeyCache = { salt: saltHex, key };
    return key;
  }

  private async decryptData(
    dataKeyBytes: Uint8Array,
    iv: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<WalletData> {
    const dataKey = await crypto.subtle.importKey(
      "raw",
      dataKeyBytes as any,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as any },
      dataKey,
      ciphertext as any,
    );
    return JSON.parse(textDecode(new Uint8Array(decrypted))) as WalletData;
  }

  async load(): Promise<WalletData | null> {
    const raw = await this.inner.load();
    if (!raw) return null;

    const encrypted = (raw as any)._encrypted;
    if (!encrypted) {
      // Never fall back to plaintext when encryption was explicitly enabled.
      // Accepting a legacy record here would let a tampered storage entry
      // bypass the passphrase entirely.
      throw new WalletError(
        "decryption_failed",
        "Encrypted wallet data is missing or corrupted",
      );
    }

    if (isV2(encrypted)) return this.loadV2(encrypted);
    return this.loadV1(encrypted as EncryptedRecordV1);
  }

  /** Records written before envelope wrapping. Absent version means
   *  passphrase, which is both true and needs no rewrite to read. */
  private async loadV1(enc: EncryptedRecordV1): Promise<WalletData> {
    const passphrase = await this.getPassphrase();
    const key = await deriveKey(passphrase, hex2buf(enc.salt), KEY_ITERATIONS);
    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: hex2buf(enc.iv) as any },
        key,
        hex2buf(enc.ciphertext) as any,
      );
      this.sealedWith = ["passphrase"];
      return JSON.parse(textDecode(new Uint8Array(decrypted))) as WalletData;
    } catch {
      throw new WalletError(
        "decryption_failed",
        "Invalid passphrase or corrupted data",
      );
    }
  }

  private async loadV2(enc: EncryptedRecordV2): Promise<WalletData> {
    const present = (["prf", "passphrase"] as const).filter(
      (m) => enc.wraps[m] !== undefined,
    );
    this.sealedWith = [...present];
    if (present.length === 0) {
      throw new WalletError(
        "decryption_failed",
        "Encrypted wallet record carries no unlock wrap",
      );
    }

    const iv = hex2buf(enc.iv);
    const ciphertext = hex2buf(enc.ciphertext);

    // PRF first when the record has it: it is the stronger path and the one
    // that needs no typing. A failure here falls through to the passphrase
    // rather than stopping, so a replaced or unavailable authenticator does
    // not lock a user out of a record the passphrase still opens.
    const prfWrap = enc.wraps.prf;
    if (prfWrap) {
      const salt = hex2buf(prfWrap.salt);
      this.prfSalt = salt;
      const key = await this.prfKeyFor(salt);
      if (key) {
        try {
          const dataKey = new Uint8Array(
            await crypto.subtle.decrypt(
              { name: "AES-GCM", iv: hex2buf(prfWrap.iv) as any },
              key,
              hex2buf(prfWrap.key) as any,
            ),
          );
          return await this.decryptData(dataKey, iv, ciphertext);
        } catch {
          // A stored PRF wrap that will not open means this authenticator is
          // not the one that sealed it. Drop the cache so a later save does
          // not reuse a key that is already known not to fit.
          this.prfKeyCache = null;
        }
      }
    }

    const passWrap = enc.wraps.passphrase;
    if (!passWrap) {
      throw new WalletError(
        "decryption_failed",
        "This wallet is sealed to a passkey that is not available here, and has no passphrase fallback",
      );
    }
    const passphrase = await this.getPassphrase();
    const key = await deriveKey(
      passphrase,
      hex2buf(passWrap.salt),
      passWrap.iterations ?? KEY_ITERATIONS,
    );
    try {
      const dataKey = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: hex2buf(passWrap.iv) as any },
          key,
          hex2buf(passWrap.key) as any,
        ),
      );
      return await this.decryptData(dataKey, iv, ciphertext);
    } catch {
      throw new WalletError(
        "decryption_failed",
        "Invalid passphrase or corrupted data",
      );
    }
  }

  /**
   * The PRF salt to write with.
   *
   * Reuses the one already in storage so the session's derived key stays
   * valid; only generates when there is nothing to reuse. Regenerating a salt
   * that an existing ciphertext depends on would be equivalent to discarding
   * that ciphertext, so this never overwrites one it found.
   */
  private async resolvePrfSalt(): Promise<Uint8Array> {
    if (this.prfSalt) return this.prfSalt;
    try {
      const existing = (await this.inner.load()) as any;
      const enc = existing?._encrypted;
      if (isV2(enc) && enc.wraps.prf) {
        this.prfSalt = hex2buf(enc.wraps.prf.salt);
        return this.prfSalt;
      }
    } catch {
      // An unreadable existing record is not a reason to refuse to write a new
      // one; the salt is regenerated below.
    }
    this.prfSalt = crypto.getRandomValues(new Uint8Array(PRF_SALT_LENGTH));
    return this.prfSalt;
  }

  async save(data: WalletData): Promise<void> {
    const dataKeyBytes = crypto.getRandomValues(
      new Uint8Array(DATA_KEY_LENGTH),
    );
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const dataKey = await crypto.subtle.importKey(
      "raw",
      dataKeyBytes as any,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as any },
      dataKey,
      textEncode(JSON.stringify(data)) as any,
    );

    const wraps: Partial<Record<UnlockMethod, WrapEntry>> = {};

    // Always written. This is the route back when the authenticator is gone.
    const passphrase = await this.getPassphrase();
    const passSalt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const passIv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const passKek = await deriveKey(passphrase, passSalt, KEY_ITERATIONS);
    wraps.passphrase = {
      salt: buf2hex(passSalt),
      iv: buf2hex(passIv),
      iterations: KEY_ITERATIONS,
      key: buf2hex(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: passIv as any },
          passKek,
          dataKeyBytes as any,
        ),
      ),
    };

    if (this.prf) {
      const prfSalt = await this.resolvePrfSalt();
      const prfKek = await this.prfKeyFor(prfSalt);
      if (prfKek) {
        const prfIv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        wraps.prf = {
          salt: buf2hex(prfSalt),
          iv: buf2hex(prfIv),
          key: buf2hex(
            await crypto.subtle.encrypt(
              { name: "AES-GCM", iv: prfIv as any },
              prfKek,
              dataKeyBytes as any,
            ),
          ),
        };
      }
    }

    dataKeyBytes.fill(0);
    this.sealedWith = (["prf", "passphrase"] as const).filter(
      (m) => wraps[m] !== undefined,
    );

    const record: EncryptedRecordV2 = {
      v: 2,
      iv: buf2hex(iv),
      ciphertext: buf2hex(ciphertext),
      wraps,
    };
    return this.inner.save({ _encrypted: record } as any);
  }

  async clear(): Promise<void> {
    this.prfKeyCache = null;
    this.prfSalt = null;
    this.sealedWith = null;
    return this.inner.clear();
  }
}
