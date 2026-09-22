import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { SessionKeyTransaction } from "./types";

/**
 * EIP-712 typed data a session key may be asked to sign. Exactly one
 * primary type is understood — EIP-3009 `TransferWithAuthorization`, the
 * gasless stable-coin transfer that x402 and similar payment flows use.
 * Anything else is refused: unknown typed data is not "unscoped", it is
 * denied. The manager computes the digest itself from these facts; a caller
 * never supplies a digest for typed data, so what is checked is what is
 * signed.
 */
export interface SessionKeyTypedDataRequest {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  primaryType: "TransferWithAuthorization";
  message: {
    from: `0x${string}`;
    to: `0x${string}`;
    /** Token base units, decimal string. */
    value: string;
    /** Unix seconds, decimal string. */
    validAfter: string;
    /** Unix seconds, decimal string. */
    validBefore: string;
    /** 32-byte hex. */
    nonce: `0x${string}`;
  };
}

export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xa9059cbb"; // transfer(address,uint256) — the equivalent calldata used for scope checks

const TYPE_HASH = keccak_256(
  new TextEncoder().encode(
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
);
const DOMAIN_TYPE_HASH = keccak_256(
  new TextEncoder().encode(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;

function word(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  const bytes = hexToBytes(hex.slice(2));
  out.set(bytes, 32 - bytes.length);
  return out;
}
function uint(value: bigint): Uint8Array {
  return word(`0x${value.toString(16).padStart(64, "0")}`);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Structural validation; returns a reason instead of throwing so callers can report it as a scope failure. */
export function validateTypedDataRequest(
  req: SessionKeyTypedDataRequest,
): string | null {
  if (req.primaryType !== "TransferWithAuthorization") {
    return `Typed data primary type ${String(req.primaryType)} is not permitted for session keys`;
  }
  const d = req.domain;
  const m = req.message;
  if (!d || typeof d.name !== "string" || typeof d.version !== "string") {
    return "Typed data domain must carry name and version";
  }
  if (!Number.isSafeInteger(d.chainId) || d.chainId <= 0) {
    return "Typed data domain chainId must be a positive integer";
  }
  if (!ADDRESS.test(d.verifyingContract)) {
    return "Typed data verifyingContract must be an EVM address";
  }
  if (!m || !ADDRESS.test(m.from) || !ADDRESS.test(m.to)) {
    return "TransferWithAuthorization from/to must be EVM addresses";
  }
  for (const [name, v] of [
    ["value", m.value],
    ["validAfter", m.validAfter],
    ["validBefore", m.validBefore],
  ] as const) {
    if (typeof v !== "string" || !DECIMAL.test(v) || BigInt(v) > UINT256_MAX) {
      return `TransferWithAuthorization ${name} must be a decimal uint256`;
    }
  }
  if (!BYTES32.test(m.nonce)) {
    return "TransferWithAuthorization nonce must be 32 bytes";
  }
  return null;
}

/** EIP-712 digest for a validated TransferWithAuthorization request. */
export function typedDataDigest(
  req: SessionKeyTypedDataRequest,
): `0x${string}` {
  const d = req.domain;
  const m = req.message;
  const domainSeparator = keccak_256(
    concat(
      DOMAIN_TYPE_HASH,
      keccak_256(new TextEncoder().encode(d.name)),
      keccak_256(new TextEncoder().encode(d.version)),
      uint(BigInt(d.chainId)),
      word(d.verifyingContract),
    ),
  );
  const structHash = keccak_256(
    concat(
      TYPE_HASH,
      word(m.from),
      word(m.to),
      uint(BigInt(m.value)),
      uint(BigInt(m.validAfter)),
      uint(BigInt(m.validBefore)),
      hexToBytes(m.nonce.slice(2)),
    ),
  );
  return `0x${bytesToHex(
    keccak_256(
      concat(new Uint8Array([0x19, 0x01]), domainSeparator, structHash),
    ),
  )}`;
}

/**
 * The transaction the typed data is equivalent to, for the existing scope
 * check: a `transfer(to, value)` on the token at `verifyingContract` on
 * `chainId`. Contract allowlist, forbidden selectors, token allowances,
 * recipient allowlist and counts all apply unchanged.
 */
export function typedDataAsTransaction(
  req: SessionKeyTypedDataRequest,
): SessionKeyTransaction {
  const to = req.message.to.slice(2).toLowerCase().padStart(64, "0");
  const value = BigInt(req.message.value).toString(16).padStart(64, "0");
  return {
    to: req.domain.verifyingContract,
    chainId: req.domain.chainId,
    value: "0",
    data: `${TRANSFER_WITH_AUTHORIZATION_SELECTOR}${to}${value}`,
  };
}

/** The EVM address a session key's public key controls. */
export function sessionKeyAddress(publicKeyHex: `0x${string}`): `0x${string}` {
  const point = secp256k1.Point.fromHex(publicKeyHex.slice(2));
  const uncompressed = point.toBytes(false); // 0x04 ‖ x ‖ y
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
}
