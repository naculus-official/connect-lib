import { aesGcmOpen, aesGcmSeal } from "@naculus/connect-core";
import { randomBytes } from "@noble/hashes/utils.js";
import { WalletError } from "../errors";
import type { WalletData } from "../wallet";
import type { StorageAdapter } from "./types";

/**
 * Wallet storage sealed under a key held by the platform's key store — iOS
 * Keychain / Android Keystore on React Native, where there is no WebCrypto
 * and no Web Worker. The wallet record (mnemonic and keys) is serialized and
 * sealed here with AES-256-GCM, so the platform glue only ever stores two
 * opaque strings: the key (in the key store) and the sealed blob (anywhere).
 */

/** Holds the 32-byte wrapping key as an opaque string (e.g. SecureStore). */
export interface WalletKeyStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  delete(): Promise<void>;
}

/** Holds the sealed record as an opaque string (e.g. AsyncStorage). */
export interface WalletBlobStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

export interface KeyStoreStorageOptions {
  keyStore: WalletKeyStore;
  blobStore: WalletBlobStore;
  /** Authenticated with the record: a blob moved to another slot won't open. */
  slot?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function keyFromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new WalletError(
      "decryption_failed",
      "The stored wallet key is malformed.",
    );
  }
  return Uint8Array.from(hex.match(/../g) as string[], (h) =>
    Number.parseInt(h, 16),
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export class KeyStoreStorageAdapter implements StorageAdapter {
  readonly type = "custom" as const;
  private readonly aad: Uint8Array;
  /** One key per adapter: concurrent first saves must not mint two. */
  private keyPromise: Promise<string> | null = null;

  constructor(private readonly options: KeyStoreStorageOptions) {
    this.aad = encoder.encode(
      `naculus-wallet-key-store/v1:${options.slot ?? "default"}`,
    );
  }

  isAvailable(): boolean {
    return true;
  }

  private keyForWriting(): Promise<string> {
    this.keyPromise ??= (async () => {
      const existing = await this.options.keyStore.load();
      if (existing !== null) return existing;
      const created = toHex(randomBytes(32));
      await this.options.keyStore.save(created);
      return created;
    })();
    // A failed read or write must not stick: the next save retries.
    this.keyPromise.catch(() => {
      this.keyPromise = null;
    });
    return this.keyPromise;
  }

  async load(): Promise<WalletData | null> {
    const sealed = await this.options.blobStore.read();
    if (sealed === null) return null;
    const hex = await this.options.keyStore.load();
    // A record without its key cannot be opened. Say so rather than report
    // "no wallet", which would invite creating one over it.
    if (hex === null) {
      throw new WalletError(
        "decryption_failed",
        "The wallet record exists but its key is gone.",
      );
    }
    const key = keyFromHex(hex);
    try {
      return JSON.parse(
        decoder.decode(aesGcmOpen(key, fromBase64(sealed), this.aad)),
      ) as WalletData;
    } finally {
      key.fill(0);
    }
  }

  async save(data: WalletData): Promise<void> {
    const key = keyFromHex(await this.keyForWriting());
    try {
      const sealed = aesGcmSeal(
        key,
        encoder.encode(JSON.stringify(data)),
        this.aad,
      );
      await this.options.blobStore.write(toBase64(sealed));
    } finally {
      key.fill(0);
    }
  }

  async clear(): Promise<void> {
    await this.options.blobStore.remove();
    await this.options.keyStore.delete();
    this.keyPromise = null;
  }
}
