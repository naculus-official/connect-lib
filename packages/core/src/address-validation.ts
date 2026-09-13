import { sha256 } from "@noble/hashes/sha256";

/** Address validation helpers used at transfer/route boundaries. */

const BURN_PREFIXES = ["dead", "deaf", "deed", "deec", "deed"];
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const XRPL_BASE58 =
  "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const SOLANA_BASE58 =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

/** True if the address contains known burn-indicating hex prefixes */
export function isBurnAddress(address: string): boolean {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return (
    BURN_PREFIXES.some((p) => clean.startsWith(p)) ||
    clean === "0000000000000000000000000000000000000000"
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
