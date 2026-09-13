/**
 * EIP-5792 wire format, normalized once.
 *
 * `wallet_getCapabilities` returns a record keyed by hex chain ID whose values
 * changed shape between the draft and 2.0.0. Three connectors each decoded it
 * inline and each got it wrong in a different direction — one invented a "no"
 * when the wallet was never asked, one read `Boolean({ supported: false })` as
 * true and so invented a "yes", one accepted only `status: "supported"` and
 * dropped `"ready"`. Decoding lives here so there is one thing to be right.
 */
import type { WalletCapabilities } from "./connector";

/**
 * Hex chain ID to CAIP-2.
 *
 * Returns undefined for anything that is not a positive hex quantity rather
 * than coercing it: a key the wallet sent that we cannot interpret is a chain
 * we know nothing about, not chain zero.
 */
export function hexChainToCaip2(key: string): string | undefined {
  if (!/^0x[0-9a-fA-F]+$/.test(key)) return undefined;
  const value = BigInt(key);
  if (value <= 0n) return undefined;
  return `eip155:${value.toString(10)}`;
}

/** CAIP-2 EVM chain ID to the hex quantity EIP-5792 expects. */
export function caip2ToHexChain(chainId: string): string | undefined {
  const match = /^eip155:([1-9][0-9]*)$/.exec(chainId);
  if (!match) return undefined;
  return `0x${BigInt(match[1]).toString(16)}`;
}

/**
 * Atomic-batch support from either shape wallets ship in the wild.
 *
 * EIP-5792 2.0.0 reports `atomic: { status }`. Both "supported" (the wallet
 * always executes atomically) and "ready" (it will after a user action) are a
 * yes; only "unsupported" is a no. Earlier drafts, still deployed, report
 * `atomicBatch: { supported }` — read as a boolean, never as object truthiness,
 * because `{ supported: false }` is itself truthy.
 */
export function readAtomicSupport(entry: Record<string, unknown>): {
  supported: boolean;
  maxBatchSize?: number;
} {
  const atomic = entry.atomic as { status?: unknown } | undefined;
  if (atomic && typeof atomic === "object" && typeof atomic.status === "string") {
    return {
      supported: atomic.status === "supported" || atomic.status === "ready",
    };
  }
  const legacy = entry.atomicBatch as
    | { supported?: unknown; maxBatchSize?: unknown }
    | undefined;
  if (legacy && typeof legacy === "object") {
    return {
      supported: legacy.supported === true,
      maxBatchSize:
        typeof legacy.maxBatchSize === "number" && legacy.maxBatchSize > 0
          ? legacy.maxBatchSize
          : undefined,
    };
  }
  return { supported: false };
}

/**
 * Normalize a `wallet_getCapabilities` result into CAIP-2-keyed capabilities.
 *
 * Only chains the wallet actually reported appear. A caller that finds its
 * chain missing learns the wallet said nothing about it, which is a fact it
 * can act on; filling the gap with `supported: false` would not be.
 */
export function normalizeEip5792Capabilities(
  raw: unknown,
): Record<string, WalletCapabilities> {
  const capabilities: Record<string, WalletCapabilities> = {};
  if (!raw || typeof raw !== "object") return capabilities;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const chain = hexChainToCaip2(key);
    if (!chain || !value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const atomic = readAtomicSupport(entry);
    const paymaster = entry.paymasterService as
      | { supported?: unknown }
      | undefined;
    capabilities[chain] = {
      atomicBatch:
        atomic.maxBatchSize !== undefined
          ? { supported: atomic.supported, maxBatchSize: atomic.maxBatchSize }
          : { supported: atomic.supported },
      paymasterService:
        paymaster?.supported === true ? { supported: true } : undefined,
    };
  }
  return capabilities;
}
