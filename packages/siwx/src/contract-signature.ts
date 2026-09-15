import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Contract-account signature verification: ERC-1271 and ERC-6492.
 *
 * SIWx previously verified EVM signatures by recovering an address with
 * `ecrecover`, which only answers for an externally owned account. A smart
 * account signs through its own logic, so recovery returns some unrelated
 * address and the sign-in is rejected — silently, and with no indication that
 * the account type was the problem. A counterfactual account, one whose
 * address is known but whose contract is not deployed yet, cannot be asked at
 * all until it exists; ERC-6492 exists for exactly that case.
 *
 * This module is chain-access agnostic: the caller supplies an `eth_call`
 * function, so it can be pointed at a viem client, a raw RPC, or a stub.
 */

/**
 * `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`, the value ERC-1271
 * requires a contract to return when a signature is valid. Derived rather than
 * transcribed so it cannot drift from the signature it comes from.
 */
export const ERC1271_MAGIC_VALUE = "0x1626ba7e";

/**
 * Trailing 32 bytes that mark an ERC-6492 wrapper, defined by the ERC as
 * `0x6492…6492`. Chosen by the spec to be improbable as a real signature tail.
 */
export const ERC6492_MAGIC_SUFFIX =
  "6492649264926492649264926492649264926492649264926492649264926492";

/** Performs an `eth_call`; returns the raw hex result. */
export type EthCall = (params: {
  to: string;
  data: string;
}) => Promise<string>;

/**
 * EIP-191 personal-sign digest.
 *
 * Computed here rather than imported from viem. It is a few lines built on a
 * dependency this package already carries, and routing it through a dynamic
 * `import("viem")` made it hostage to whatever shape the consumer's bundler
 * gives the namespace object: under one resolver `hashMessage` was simply
 * absent, so contract verification failed with an error about a missing
 * function rather than about the signature.
 */
export function hashPersonalMessage(message: string): string {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(
    String.fromCharCode(0x19) + "Ethereum Signed Message:" + "\n" + body.length,
  );
  const full = new Uint8Array(prefix.length + body.length);
  full.set(prefix);
  full.set(body, prefix.length);
  return "0x" + bytesToHex(keccak_256(full));
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/** True when the signature carries the ERC-6492 wrapper. */
export function isErc6492Signature(signature: string): boolean {
  const raw = strip0x(signature).toLowerCase();
  return raw.length > 64 && raw.endsWith(ERC6492_MAGIC_SUFFIX);
}

export interface Erc6492Envelope {
  /** Factory that would deploy the account. */
  factory: string;
  /** Calldata that deploys it. */
  factoryCalldata: string;
  /** The signature the account itself produced. */
  signature: string;
}

/**
 * Unwrap `abi.encode(address factory, bytes factoryCalldata, bytes signature)`
 * followed by the magic suffix.
 *
 * @returns the envelope, or undefined when the payload is not a well-formed
 *   wrapper. Returning undefined rather than throwing lets the caller fall
 *   back to treating it as a plain signature, which is what a non-wrapped
 *   signature that happens to end in the magic bytes would be.
 */
export function decodeErc6492Signature(
  signature: string,
): Erc6492Envelope | undefined {
  if (!isErc6492Signature(signature)) return undefined;
  const body = strip0x(signature).slice(0, -64);
  // head: 3 words — address, offset(bytes), offset(bytes)
  if (body.length < 192) return undefined;

  const word = (i: number) => body.slice(i * 64, (i + 1) * 64);
  const factory = `0x${word(0).slice(24)}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(factory)) return undefined;

  const readBytesAt = (offsetWord: string): string | undefined => {
    const offset = Number.parseInt(offsetWord, 16);
    if (!Number.isSafeInteger(offset)) return undefined;
    const at = offset * 2;
    if (at + 64 > body.length) return undefined;
    const length = Number.parseInt(body.slice(at, at + 64), 16);
    if (!Number.isSafeInteger(length)) return undefined;
    const start = at + 64;
    const end = start + length * 2;
    // Refuse a length that promises more data than the payload carries rather
    // than padding it out and producing a plausible-looking signature.
    if (end > body.length) return undefined;
    return `0x${body.slice(start, end)}`;
  };

  const factoryCalldata = readBytesAt(word(1));
  const inner = readBytesAt(word(2));
  if (factoryCalldata === undefined || inner === undefined) return undefined;

  return { factory, factoryCalldata, signature: inner };
}

/** ABI-encode `isValidSignature(bytes32 hash, bytes signature)`. */
export function encodeIsValidSignatureCall(
  hash: string,
  signature: string,
): string {
  const h = strip0x(hash).padStart(64, "0");
  const sig = strip0x(signature);
  const len = (sig.length / 2).toString(16).padStart(64, "0");
  const padded = sig.padEnd(Math.ceil(sig.length / 64) * 64, "0");
  // selector + hash + offset(0x40) + length + data
  return `${ERC1271_MAGIC_VALUE}${h}${"40".padStart(64, "0")}${len}${padded}`;
}

/** True when an `isValidSignature` return value is the ERC-1271 magic value. */
export function isErc1271Accepted(returnData: string): boolean {
  const raw = strip0x(returnData).toLowerCase();
  if (raw.length < 8) return false;
  return `0x${raw.slice(0, 8)}` === ERC1271_MAGIC_VALUE;
}

/**
 * Verify a signature against a deployed contract account via ERC-1271.
 *
 * @returns false when the call reverts or returns anything other than the
 *   magic value. A revert is a rejection, not an error to propagate: an
 *   account that does not implement ERC-1271 has not signed anything.
 */
export async function verifyErc1271(
  account: string,
  hash: string,
  signature: string,
  call: EthCall,
): Promise<boolean> {
  try {
    const returnData = await call({
      to: account,
      data: encodeIsValidSignatureCall(hash, signature),
    });
    return isErc1271Accepted(returnData);
  } catch {
    return false;
  }
}
