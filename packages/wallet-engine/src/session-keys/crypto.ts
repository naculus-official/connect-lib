import { WalletError } from "../errors";
import type { EncryptedKeyPair, SessionKeyPair } from "./types";

/**
 * Session key crypto utilities.
 *
 * Client-side secp256k1 ECDSA key pair generation.
 * Private key encrypted with AES-256-GCM, never leaves encrypted storage.
 * Decryption key derived from master wallet seed (via KDF).
 */

export const PBKDF2_ITER = Number(process.env.PBKDF2_ITER) || 600_000;

/** Derive AES key — PBKDF2 (SHA-256) from wallet seed */
async function deriveAESKey(
  walletSeed: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const { pbkdf2 } = await import("@noble/hashes/pbkdf2");
  const { sha256 } = await import("@noble/hashes/sha2");

  const key = pbkdf2(sha256, walletSeed, salt, { c: PBKDF2_ITER, dkLen: 32 });
  return key;
}

/**
 * Generate a new secp256k1 session key pair.
 * Uses @noble/curves/secp256k1.
 */
export async function generateSessionKeyPair(): Promise<SessionKeyPair> {
  const { secp256k1 } = await import("@noble/curves/secp256k1");
  const { bytesToHex } = await import("@noble/hashes/utils");

  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, true); // compressed

  return {
    publicKey: `0x${bytesToHex(publicKey)}` as `0x${string}`,
    privateKey: `0x${bytesToHex(privateKey)}` as `0x${string}`,
  };
}

/**
 * Sign a data hash with session key private key.
 * Returns ECDSA signature (r, s, v).
 */
export async function signWithSessionKey(
  privateKey: `0x${string}`,
  dataHash: Uint8Array,
): Promise<{ r: string; s: string; v: number; signature: `0x${string}` }> {
  const { secp256k1 } = await import("@noble/curves/secp256k1");
  const { bytesToHex } = await import("@noble/hashes/utils");

  const raw = privateKey.replace(/^0x/, "");
  const priv = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    priv[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);

  const sig = secp256k1.sign(dataHash, priv);
  const compact = sig.toBytes("compact");

  const r = bytesToHex(compact.slice(0, 32));
  const s = bytesToHex(compact.slice(32, 64));
  const v = sig.recovery ?? 0;

  // full compact signature hex
  const rHex = r.padStart(64, "0");
  const sHex = s.padStart(64, "0");
  const vHex = v.toString(16);

  return {
    r,
    s,
    v,
    signature: `0x${rHex}${sHex}${vHex}` as `0x${string}`,
  };
}

/**
 * Sign an EVM transaction with session key private key.
 * Delegates to EVMSigner for actual RLP encoding and signing.
 */
export async function signTransactionWithSessionKey(
  privateKey: `0x${string}`,
  tx: {
    to: string;
    value?: string;
    data?: string;
    gas?: string;
    nonce?: string;
    chainId?: number;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  },
): Promise<`0x${string}`> {
  const { EVMSigner } = await import("../signers/evm");
  const signer = new EVMSigner();

  const result = await signer.signTransaction(tx, privateKey);
  return result.signature;
}

/**
 * Encrypt session key private key.
 * Uses AES-256-GCM, key derived from wallet seed via PBKDF2.
 */
export async function encryptSessionKey(
  keyPair: SessionKeyPair,
  walletSeed: Uint8Array,
): Promise<EncryptedKeyPair> {
  const { randomBytes } = await import("@noble/hashes/utils");
  const { gcm } = await import("@noble/ciphers/aes.js");
  const { bytesToHex, concatBytes } = await import("@noble/hashes/utils");

  const salt = randomBytes(16);
  const key = await deriveAESKey(walletSeed, salt);

  const nonce = randomBytes(12); // GCM nonce/IV: 12 bytes recommended
  const aes = gcm(key, nonce);

  const pkBytes = new Uint8Array(32);
  const rawPk = keyPair.privateKey.replace(/^0x/, "");
  for (let i = 0; i < 32; i++)
    pkBytes[i] = parseInt(rawPk.slice(i * 2, i * 2 + 2), 16);

  const ciphertext = aes.encrypt(pkBytes);

  // ciphertext includes appended GCM auth tag (16 bytes)
  return {
    publicKey: keyPair.publicKey,
    encryptedPrivateKey: bytesToHex(ciphertext),
    iv: bytesToHex(nonce),
    salt: bytesToHex(salt),
  };
}

/**
 * Decrypt session key private key.
 * Requires the same wallet seed used by encryptSessionKey.
 *
 * @returns SessionKeyPair (with decrypted private key, in-memory only)
 */
export async function decryptSessionKey(
  encrypted: EncryptedKeyPair,
  walletSeed: Uint8Array,
): Promise<SessionKeyPair> {
  const { gcm } = await import("@noble/ciphers/aes.js");
  const { hexToBytes, bytesToHex } = await import("@noble/hashes/utils");

  const salt = hexToBytes(encrypted.salt);
  const key = await deriveAESKey(walletSeed, salt);

  const nonce = hexToBytes(encrypted.iv);
  const ciphertext = hexToBytes(encrypted.encryptedPrivateKey);

  const aes = gcm(key, nonce);

  try {
    const plaintext = aes.decrypt(ciphertext);
    const pkHex = bytesToHex(plaintext).padStart(64, "0");

    return {
      publicKey: encrypted.publicKey,
      privateKey: `0x${pkHex}` as `0x${string}`,
    };
  } catch (err) {
    throw new WalletError(
      "session_decrypt_failed",
      "Failed to decrypt session key. Wallet seed may have changed.",
      err,
    );
  }
}
