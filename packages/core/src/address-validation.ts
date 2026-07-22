/**
 * Address validation helpers.
 *
 * Minimal set — enough to prevent blackhole transfers.
 */

const BURN_PREFIXES = ["dead", "deaf", "deed", "deec", "deed"];
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

/** True for `0x0000…0000` (zero/burn address on all EVM chains) */
export function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDR;
}

/** True if the address contains known burn-indicating hex prefixes */
export function isBurnAddress(address: string): boolean {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return BURN_PREFIXES.some((p) => clean.startsWith(p)) || clean === "0000000000000000000000000000000000000000";
}

/**
 * Returns true if the string is a valid address for the given chain namespace.
 * For EVM chains: 0x + 40 hex chars (checksum optional).
 * Solana / XRPL: basic format check (length & prefix).
 */
export function isValidAddress(address: string, chainNamespace?: string): boolean {
  if (!address || typeof address !== "string") return false;
  if (chainNamespace === "eip155" || !chainNamespace) return EVM_ADDR_RE.test(address);
  if (chainNamespace === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (chainNamespace === "xrpl") return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
  return true; // unknown namespace — accept optimistically
}
