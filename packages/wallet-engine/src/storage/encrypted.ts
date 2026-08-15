/**
 * Encrypted Storage Adapter — Wallet Engine
 *
 * Wraps a StorageAdapter with AES-256-GCM encryption.
 * Uses the shared EncryptedStorageAdapter from @naculus/connect-core.
 *
 * This module re-exports the core encryption adapter and provides
 * a backward-compatible wrapper for the wallet engine's StorageAdapter interface.
 *
 * @see packages/core/src/storage/encrypted-storage.ts
 */

import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { WalletError } from "../errors";
import type { WalletData } from "../wallet";
import type { StorageAdapter } from "./types";

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_ITERATIONS = 600_000;

function textDecode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8ToBytes(passphrase) as any,
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

/**
 * EncryptedStorageAdapter — wraps a StorageAdapter with AES-256-GCM.
 *
 * This is the wallet-engine's version that operates on WalletData objects.
 * Internally it uses the core's WebCryptoEncryptedStorageAdapter.
 */
export class EncryptedStorageAdapter implements StorageAdapter {
  readonly type = "encrypted" as const;
  private readonly inner: StorageAdapter;
  private readonly getPassphrase: () => Promise<string>;

  constructor(inner: StorageAdapter, getPassphrase: () => Promise<string>) {
    this.inner = inner;
    this.getPassphrase = getPassphrase;
  }

  isAvailable(): boolean {
    return typeof crypto?.subtle !== "undefined" && this.inner.isAvailable();
  }

  async load(): Promise<WalletData | null> {
    const raw = await this.inner.load();
    if (!raw) return null;

    const encrypted = (raw as any)._encrypted;
    if (!encrypted) {
      if (isWalletData(raw)) return raw;
      return null;
    }

    const passphrase = await this.getPassphrase();
    const salt = hexToBytes(encrypted.salt);
    const iv = hexToBytes(encrypted.iv);
    const key = await deriveKey(passphrase, salt);
    const ciphertext = hexToBytes(encrypted.ciphertext);

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as any },
        key,
        ciphertext as any,
      );
      return JSON.parse(textDecode(new Uint8Array(decrypted))) as WalletData;
    } catch {
      throw new WalletError(
        "decryption_failed",
        "Invalid passphrase or corrupted data",
      );
    }
  }

  async save(data: WalletData): Promise<void> {
    const passphrase = await this.getPassphrase();
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key = await deriveKey(passphrase, salt);

    const encoded = utf8ToBytes(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as any },
      key,
      encoded as any,
    );

    return this.inner.save({
      _encrypted: {
        salt: bytesToHex(salt),
        iv: bytesToHex(iv),
        ciphertext: bytesToHex(new Uint8Array(ciphertext)),
      },
    } as any);
  }

  async clear(): Promise<void> {
    return this.inner.clear();
  }
}

function isWalletData(v: unknown): v is WalletData {
  return (
    typeof v === "object" && v !== null && "mnemonic" in v && "privateKey" in v
  );
}
