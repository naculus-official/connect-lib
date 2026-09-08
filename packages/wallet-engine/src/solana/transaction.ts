/**
 * Solana transaction wire format — the part a wallet is responsible for.
 *
 * The division of labour matches every Solana wallet: an application builds
 * and serializes the transaction with `@solana/kit` or `@solana/web3.js`, and
 * the wallet signs it. What the wallet cannot delegate is *where the signature
 * goes*: a transaction carries a fixed-length array of signatures, positionally
 * matched to the accounts that must sign. Signing the right bytes and putting
 * the result in the wrong slot produces a transaction the cluster rejects, and
 * nothing about the failure says why.
 *
 * That is the whole of what this module does. It does not build instructions,
 * resolve account metas, or fetch a blockhash.
 *
 * Layout, confirmed against `@solana/web3.js` v2 output rather than from
 * memory:
 *
 * ```
 * [compact-u16 count][signature × count, 64 bytes each][message …]
 *                                                    │
 *   message, versioned:  0x80|version, header(3), compact-u16 keyCount, keys…
 *   message, legacy:                   header(3), compact-u16 keyCount, keys…
 *
 *   header = numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
 * ```
 *
 * The first `numRequiredSignatures` account keys are the signers, in the same
 * order as the signature array. That correspondence is the only thing that
 * decides which slot belongs to this wallet.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { WalletError } from "../errors";

const SIGNATURE_LENGTH = 64;
const PUBKEY_LENGTH = 32;
const HEADER_LENGTH = 3;

export interface ShortVec {
  value: number;
  /** Bytes consumed. Needed by the caller to continue reading. */
  size: number;
}

/**
 * compact-u16: 7 bits per byte, high bit continues. Up to three bytes.
 */
export function decodeShortVec(bytes: Uint8Array, offset: number): ShortVec {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= bytes.length) {
      throw new WalletError(
        "invalid_input",
        "Malformed Solana transaction: truncated length prefix",
      );
    }
    const byte = bytes[offset + size];
    value |= (byte & 0x7f) << (size * 7);
    size += 1;
    if ((byte & 0x80) === 0) break;
    if (size >= 3) {
      throw new WalletError(
        "invalid_input",
        "Malformed Solana transaction: length prefix longer than three bytes",
      );
    }
  }
  return { value, size };
}

export interface SolanaTransactionLayout {
  /** Slots present in the signature array, one per required signer. */
  signatureCount: number;
  /** Where the message begins. Everything from here on is what gets signed. */
  messageOffset: number;
  /** The exact bytes an ed25519 signature covers. */
  message: Uint8Array;
  version: "legacy" | number;
  numRequiredSignatures: number;
  /** The signer account keys, in signature order. */
  signerKeys: Uint8Array[];
}

export function parseSolanaTransaction(
  wire: Uint8Array,
): SolanaTransactionLayout {
  if (!(wire instanceof Uint8Array) || wire.length === 0) {
    throw new WalletError(
      "invalid_input",
      "A serialized Solana transaction is required.",
    );
  }

  const count = decodeShortVec(wire, 0);
  const messageOffset = count.size + count.value * SIGNATURE_LENGTH;
  if (messageOffset >= wire.length) {
    throw new WalletError(
      "invalid_input",
      "Malformed Solana transaction: signature array runs past the end",
    );
  }

  const message = wire.subarray(messageOffset);
  let cursor = 0;
  let version: "legacy" | number = "legacy";
  // The high bit distinguishes a versioned message from a legacy one, which
  // begins directly with the header. A legacy header's first byte is a signer
  // count, so it can never have the high bit set.
  if ((message[0] & 0x80) !== 0) {
    version = message[0] & 0x7f;
    cursor += 1;
  }

  if (cursor + HEADER_LENGTH > message.length) {
    throw new WalletError(
      "invalid_input",
      "Malformed Solana transaction: message header is truncated",
    );
  }
  const numRequiredSignatures = message[cursor];
  cursor += HEADER_LENGTH;

  // A transaction whose signature array is shorter than its declared signer
  // count has nowhere to put a signature. Reading on would index past the end.
  if (count.value < numRequiredSignatures) {
    throw new WalletError(
      "invalid_input",
      `Malformed Solana transaction: ${numRequiredSignatures} signers required but only ${count.value} signature slots`,
    );
  }

  const keyCount = decodeShortVec(message, cursor);
  cursor += keyCount.size;
  if (keyCount.value < numRequiredSignatures) {
    throw new WalletError(
      "invalid_input",
      "Malformed Solana transaction: fewer account keys than required signers",
    );
  }
  if (cursor + keyCount.value * PUBKEY_LENGTH > message.length) {
    throw new WalletError(
      "invalid_input",
      "Malformed Solana transaction: account key array runs past the end",
    );
  }

  const signerKeys: Uint8Array[] = [];
  for (let i = 0; i < numRequiredSignatures; i++) {
    const start = cursor + i * PUBKEY_LENGTH;
    signerKeys.push(message.subarray(start, start + PUBKEY_LENGTH));
  }

  return {
    signatureCount: count.value,
    messageOffset,
    message,
    version,
    numRequiredSignatures,
    signerKeys,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Add this wallet's signature to a serialized transaction.
 *
 * A partial sign: signatures already present are left alone, so a
 * multi-signature transaction can be passed between signers.
 *
 * Refuses a transaction this key is not a required signer of. The alternative
 * — signing anyway and putting the result nowhere in particular — returns
 * something that looks like a signed transaction and fails on submission,
 * which is a worse outcome than refusing here.
 */
export function signSolanaTransaction(
  wire: Uint8Array,
  secretSeed: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  const layout = parseSolanaTransaction(wire);
  const index = layout.signerKeys.findIndex((key) =>
    sameBytes(key, publicKey),
  );
  if (index === -1) {
    throw new WalletError(
      "invalid_input",
      "This wallet is not a required signer of that transaction.",
    );
  }

  const signature = ed25519.sign(layout.message, secretSeed);
  const signed = new Uint8Array(wire);
  const start =
    decodeShortVec(wire, 0).size + index * SIGNATURE_LENGTH;
  signed.set(signature, start);
  return signed;
}

/**
 * Whether every required signature slot is filled.
 *
 * An all-zero slot is how both `@solana/web3.js` and the runtime represent
 * "not signed yet", so this is the check that distinguishes a transaction
 * ready to submit from one still waiting on a co-signer.
 */
export function isFullySigned(wire: Uint8Array): boolean {
  const layout = parseSolanaTransaction(wire);
  const prefix = decodeShortVec(wire, 0).size;
  for (let i = 0; i < layout.numRequiredSignatures; i++) {
    const start = prefix + i * SIGNATURE_LENGTH;
    let allZero = true;
    for (let j = 0; j < SIGNATURE_LENGTH; j++) {
      if (wire[start + j] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) return false;
  }
  return true;
}

// ── Encoding helpers ──────────────────────────────────────────────

/**
 * Accept a transaction in the form it arrives in.
 *
 * base64 is what an RPC, a relayer and most APIs hand you; raw bytes are what
 * `@solana/kit` produces locally. Requiring one and silently mis-reading the
 * other would corrupt the message before it is signed.
 */
export function toWireBytes(transaction: Uint8Array | string): Uint8Array {
  if (transaction instanceof Uint8Array) return transaction;
  if (typeof transaction !== "string" || transaction.length === 0) {
    throw new WalletError(
      "invalid_input",
      "A serialized Solana transaction is required, as bytes or base64.",
    );
  }
  // Reject anything that is not base64 rather than letting a decoder invent
  // bytes for it. A hex string decoded as base64 produces a valid-looking
  // buffer of the wrong content.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(transaction)) {
    throw new WalletError(
      "invalid_input",
      "Expected a base64-encoded Solana transaction.",
    );
  }
  const binary = atob(transaction);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** The 32-byte ed25519 seed a Solana account stores, as hex. */
export function solanaSecretSeed(privateKey: string): Uint8Array {
  const raw = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new WalletError(
      "invalid_key",
      "An ed25519 secret key is 32 bytes of hex.",
    );
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
}
