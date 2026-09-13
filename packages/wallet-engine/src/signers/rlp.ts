/**
 * RLP primitives shared by the in-process signer and the isolated worker.
 *
 * These existed as three near-copies: two inside evm.ts and one in
 * crypto-worker.ts. The copies drifted, and the drift was not cosmetic — the
 * worker's quantity encoder ended up demanding canonical form and rejected
 * roughly 18% of the signatures it was handed, because secp256k1 r/s are fixed
 * 32-byte values whose top nibble is frequently zero. Signing failed
 * intermittently and looked random.
 *
 * The worker is bundled with `noExternal`, so importing from here costs the
 * worker asset nothing at runtime.
 */
import { concatBytes } from "@noble/hashes/utils";

export function hexToBytes(hex: string): Uint8Array {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(raw)) {
    throw new Error("hex value must contain complete bytes");
  }
  const bytes = new Uint8Array(raw.length / 2);
  for (let i = 0; i < raw.length; i += 2) {
    bytes[i / 2] = Number.parseInt(raw.slice(i, i + 2), 16);
  }
  return bytes;
}

/** RLP-encode a byte string exactly as given. Use for addresses and calldata. */
export function toRlpBytes(hex: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length === 1 && b[0] < 0x80) return b;
  if (b.length < 56) return concatBytes(new Uint8Array([0x80 + b.length]), b);
  const lenHex = b.length.toString(16);
  const lenBytes = hexToBytes(`0x${lenHex.length % 2 ? `0${lenHex}` : lenHex}`);
  return concatBytes(new Uint8Array([0xb7 + lenBytes.length]), lenBytes, b);
}

/**
 * RLP-encode a quantity: a big-endian integer with leading zeros stripped.
 *
 * Normalizes rather than rejects. Inputs arrive zero-padded from two
 * directions — JSON-RPC callers may omit a leading zero nibble, and secp256k1
 * r/s are fixed 32-byte values — so demanding canonical form here rejects
 * valid signatures. Callers that need to hold *their own* input to canonical
 * form should validate it separately before encoding.
 */
export function toRlpQuantity(hex: string): Uint8Array {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(raw)) {
    throw new Error("quantity must be a hexadecimal value");
  }
  const normalized = raw.replace(/^0+/, "");
  return normalized.length === 0
    ? toRlpBytes("0x")
    : toRlpBytes(`0x${normalized.length % 2 ? `0${normalized}` : normalized}`);
}

export function encodeRlpList(items: Uint8Array[]): Uint8Array {
  const encoded = concatBytes(...items);
  if (encoded.length < 56) {
    return concatBytes(new Uint8Array([0xc0 + encoded.length]), encoded);
  }
  const lenHex = encoded.length.toString(16);
  const lenBytes = hexToBytes(`0x${lenHex.length % 2 ? `0${lenHex}` : lenHex}`);
  return concatBytes(
    new Uint8Array([0xf7 + lenBytes.length]),
    lenBytes,
    encoded,
  );
}
