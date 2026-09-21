import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** Address validation helpers used at transfer/route boundaries. */

/** Vanity prefixes conventionally used for addresses that provably cannot spend. */
const BURN_PREFIXES = ["dead", "deaf", "deed", "deec"];
/** Well-known sinks that carry no recognizable prefix. */
const BURN_SINKS = new Set([
  "0000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000001",
  "000000000000000000000000000000000000dead",
]);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const XRPL_BASE58 =
  "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const SOLANA_BASE58 =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Canonical EIP-55 mixed-case form of a 20-byte EVM address. */
export function toChecksumAddress(address: string): `0x${string}` {
  if (typeof address !== "string" || !EVM_ADDR_RE.test(address)) {
    throw new Error("Invalid EVM address");
  }

  const lower = address.slice(2).toLowerCase();
  // EIP-55 hashes the lowercase hex characters as ASCII, not the 20 address bytes.
  const hash = keccak_256(new TextEncoder().encode(lower));
  let result = "0x";
  for (let i = 0; i < lower.length; i++) {
    const byte = hash[i >> 1];
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    result += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return result as `0x${string}`;
}

/** True only when an EVM address already has its canonical EIP-55 casing. */
export function isChecksumAddress(address: string): boolean {
  return (
    typeof address === "string" &&
    EVM_ADDR_RE.test(address) &&
    toChecksumAddress(address) === address
  );
}

function isValidSolanaAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  let value = 0n;
  for (const char of address) {
    const digit = SOLANA_BASE58.indexOf(char);
    if (digit < 0) return false;
    value = value * 58n + BigInt(digit);
  }
  const significant =
    value === 0n
      ? []
      : value
          .toString(16)
          .padStart(
            value.toString(16).length % 2
              ? value.toString(16).length + 1
              : value.toString(16).length,
            "0",
          );
  const leadingZeroBytes = address.match(/^1*/)?.[0].length ?? 0;
  return leadingZeroBytes + significant.length / 2 === 32;
}

function decodeXrplBase58(input: string): Uint8Array | null {
  if (!input || /[^1-9A-HJ-NP-Za-km-z]/.test(input)) return null;
  let value = 0n;
  for (const char of input) {
    const index = XRPL_BASE58.indexOf(char);
    if (index < 0) return null;
    value = value * 58n + BigInt(index);
  }
  const valueHex = value === 0n ? "" : value.toString(16);
  const hex = valueHex
    ? valueHex.padStart(
        valueHex.length % 2 ? valueHex.length + 1 : valueHex.length,
        "0",
      )
    : "";
  const significant = new Uint8Array(hex.length / 2);
  for (let i = 0; i < significant.length; i++) {
    significant[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // XRP's alphabet encodes a zero byte with `r` (not Bitcoin's `1`).
  const leading = input.match(/^r*/)?.[0].length ?? 0;
  const result = new Uint8Array(leading + significant.length);
  result.set(significant, leading);
  return result;
}

function hasXrplChecksum(input: string, prefix: number[]): boolean {
  const decoded = decodeXrplBase58(input);
  if (!decoded || decoded.length < prefix.length + 5) return false;
  if (!prefix.every((byte, index) => decoded[index] === byte)) return false;
  const payload = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);
  const expected = sha256(sha256(payload)).slice(0, 4);
  return checksum.every((byte, index) => byte === expected[index]);
}

function isValidXrplAddress(address: string): boolean {
  const [base, tag] = address.split("-");
  if (tag !== undefined && !/^\d{1,10}$/.test(tag)) return false;
  if (tag !== undefined && Number(tag) > 0xffffffff) return false;
  if (base.startsWith("r")) return hasXrplChecksum(base, [0]);
  if (base.startsWith("X")) return hasXrplChecksum(base, [0x05, 0x44]);
  if (base.startsWith("T")) return hasXrplChecksum(base, [0x04, 0x93]);
  return false;
}

/** True for `0x0000…0000` (zero/burn address on all EVM chains) */
export function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDR;
}

/**
 * True for addresses conventionally used to destroy funds: the zero and
 * 0x…01 sinks, 0x…dead, the dead/deaf/deed/deec vanity prefixes, and any
 * address containing "dead". The single definition shared with appkit-core's
 * destination validation; a heuristic, not proof that funds are lost.
 */
export function isBurnAddress(address: string): boolean {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return (
    BURN_SINKS.has(clean) ||
    BURN_PREFIXES.some((p) => clean.startsWith(p)) ||
    // Anywhere, not only as a prefix: 0x00dead…, 0x…dead00 are burns too.
    clean.includes("dead")
  );
}

/**
 * Returns true if the string is a valid address for the given chain namespace.
 * For EVM chains: 0x + 40 hex chars (checksum optional).
 * Solana: base58 public-key shape. XRPL: checksum-verified classic/X-address.
 */
export function isValidAddress(
  address: string,
  chainNamespace?: string,
): boolean {
  if (!address || typeof address !== "string") return false;
  if (chainNamespace === "eip155" || !chainNamespace)
    return EVM_ADDR_RE.test(address);
  if (chainNamespace === "solana") return isValidSolanaAddress(address);
  if (chainNamespace === "xrpl") return isValidXrplAddress(address);
  return false;
}
