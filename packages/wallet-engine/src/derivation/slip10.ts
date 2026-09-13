/**
 * SLIP-0010 key derivation for ed25519 curves.
 *
 * BIP-32 is defined over secp256k1 and cannot derive ed25519 keys: its child
 * derivation adds scalars, which ed25519's clamped keys do not permit.
 * SLIP-0010 is what wallets actually use for ed25519 chains, and it supports
 * hardened derivation only — a non-hardened ed25519 path has no defined
 * meaning, so asking for one is an error rather than something to approximate.
 *
 * Implemented here rather than pulled in: it is thirty lines of HMAC over
 * dependencies this package already carries, and the derivation decides which
 * address a user's funds live at. A mistake there is unrecoverable, so it is
 * worth being able to read the whole thing.
 */
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha2";
import { WalletError } from "../errors";

/** SLIP-0010 marks hardened indices by setting the high bit. */
const HARDENED_OFFSET = 0x80000000;

export interface Slip10Node {
  /** 32-byte private key. */
  key: Uint8Array;
  /** 32-byte chain code. */
  chainCode: Uint8Array;
}

/**
 * Master node for an ed25519 chain.
 *
 * The HMAC key is the literal ASCII string "ed25519 seed", per SLIP-0010.
 * Unlike secp256k1 there is no validity retry loop: every 32-byte value is a
 * valid ed25519 private key.
 */
export function ed25519MasterNode(seed: Uint8Array): Slip10Node {
  if (seed.length < 16 || seed.length > 64) {
    throw new WalletError(
      "invalid_key",
      "SLIP-0010 requires a seed of 16 to 64 bytes.",
    );
  }
  const I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/**
 * One hardened child step.
 *
 * The data is `0x00 || parentKey || index`, index big-endian with the hardened
 * bit already set. The leading zero byte is what distinguishes this from the
 * secp256k1 form and is not optional.
 */
export function ed25519DeriveChild(
  parent: Slip10Node,
  index: number,
): Slip10Node {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new WalletError(
      "invalid_input",
      `SLIP-0010 index out of range: ${index}`,
    );
  }
  if (index < HARDENED_OFFSET) {
    throw new WalletError(
      "invalid_input",
      "ed25519 supports hardened derivation only; a non-hardened index has no defined meaning on this curve.",
    );
  }

  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(parent.key, 1);
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(
    33,
    index,
    false,
  );

  const I = hmac(sha512, parent.chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/**
 * Parse a BIP-44 style path into hardened indices.
 *
 * Rejects a non-hardened segment rather than silently hardening it. A caller
 * who wrote `m/44'/501'/0'/0` meant something this curve cannot do, and
 * quietly deriving a different key would put their funds at an address they
 * never see.
 */
export function parseHardenedPath(path: string): number[] {
  const trimmed = path.trim();
  if (!/^m(\/\d+'?)*$/.test(trimmed)) {
    throw new WalletError(
      "invalid_input",
      `Malformed derivation path: ${path}`,
    );
  }
  const segments = trimmed.split("/").slice(1);
  return segments.map((segment) => {
    if (!segment.endsWith("'")) {
      throw new WalletError(
        "invalid_input",
        `ed25519 requires every path segment to be hardened; "${segment}" in "${path}" is not.`,
      );
    }
    const value = Number.parseInt(segment.slice(0, -1), 10);
    if (!Number.isInteger(value) || value < 0 || value >= HARDENED_OFFSET) {
      throw new WalletError(
        "invalid_input",
        `Path index out of range: ${segment}`,
      );
    }
    return value + HARDENED_OFFSET;
  });
}

/** Derive an ed25519 private key from a seed along a hardened path. */
export function deriveEd25519(seed: Uint8Array, path: string): Uint8Array {
  let node = ed25519MasterNode(seed);
  for (const index of parseHardenedPath(path)) {
    node = ed25519DeriveChild(node, index);
  }
  return node.key;
}
