/**
 * CAIP-2 and CAIP-10 reading, in one place.
 *
 * appkit had its own copy of this as `chainId.startsWith("eip155:")` followed
 * by `parseInt(chainId.split(":")[1])`. That answers 5 for
 * `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, because base58 begins with a
 * digit often enough. It was guarded by the `startsWith` in the two places it
 * was used, which made it incapable rather than wrong — but it is the third
 * hand-rolled CAIP parser in this codebase, and the reason to have one is that
 * the next caller does not get to write a fourth.
 */

import { WalletError } from "./errors";
import { parseChainId } from "./session-manager/types";

export interface Caip10Account {
  /** `eip155`, `solana`, `xrpl`, … */
  namespace: string;
  /** The CAIP-2 chain, e.g. `eip155:1`. */
  chainId: string;
  /** The address alone. */
  address: string;
}

/**
 * Read a CAIP-10 account string, or null when it is not one.
 *
 * Null rather than throwing: session account lists are data from a wallet, and
 * a malformed entry should not take down the account list around it.
 *
 * Split from the end, because a chain reference may itself contain a colon in
 * namespaces that allow it — taking index 2 would truncate the address.
 */
export function parseCaip10(value: string): Caip10Account | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length < 3) return null;
  const address = parts[parts.length - 1];
  const chainId = parts.slice(0, -1).join(":");
  if (!address) return null;
  try {
    const { namespace } = parseChainId(chainId);
    return { namespace, chainId, address };
  } catch {
    return null;
  }
}

/** The namespace of a CAIP-2 or CAIP-10 value, or null when unreadable. */
export function namespaceOf(value: string): string | null {
  const account = parseCaip10(value);
  if (account) return account.namespace;
  try {
    return parseChainId(value).namespace;
  } catch {
    return null;
  }
}

/**
 * The EIP-155 chain number, or null when this is not an EIP-155 chain.
 *
 * Null rather than NaN or a partial parse. A caller comparing a chain number
 * needs a wrong answer to be impossible, not merely unlikely.
 */
export function eip155Reference(chainId: string): number | null {
  let reference: string;
  try {
    const parsed = parseChainId(chainId);
    if (parsed.namespace !== "eip155") return null;
    reference = parsed.reference;
  } catch {
    return null;
  }
  if (!/^[1-9]\d*$/.test(reference)) return null;
  const value = Number(reference);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * A wallet-reported EIP-155 chain as canonical CAIP-2 (`eip155:<decimal>`),
 * or undefined. Accepts what wallets emit — `eip155:N`, `0x` hex or a decimal
 * string — and refuses 0 and anything beyond `Number.MAX_SAFE_INTEGER`, so a
 * malformed wallet event cannot become a chain the SDK acts on.
 *
 * The connectors and appkit each had a copy; one of them accepted chain 0.
 */
export function normalizeEip155ChainId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let raw: string;
  if (value.startsWith("eip155:")) {
    raw = value.slice("eip155:".length);
    if (!/^\d+$/.test(raw)) return undefined;
  } else if (/^0x[0-9a-f]+$/i.test(value) || /^\d+$/.test(value)) {
    raw = value;
  } else {
    return undefined;
  }
  let numeric: bigint;
  try {
    numeric = BigInt(raw);
  } catch {
    return undefined;
  }
  if (numeric <= 0n || numeric > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return `eip155:${numeric.toString(10)}`;
}

/**
 * A configured EIP-155 chain ID, checked: exactly `eip155:<decimal>` with no
 * leading zeros, from 1 to `Number.MAX_SAFE_INTEGER`. Throws otherwise.
 */
export function requireEip155ChainId(chainId: string): string {
  const reference = eip155Reference(chainId);
  if (reference === null) {
    throw new WalletError(
      "chain_unsupported",
      `Invalid EIP-155 chain ID: ${chainId}`,
    );
  }
  return `eip155:${reference}`;
}

/**
 * Whether an address is an EVM one, by shape.
 *
 * Only meaningful for EIP-155: a base58 Solana address is not distinguishable
 * from other base58 strings, so nothing here tries.
 */
export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
