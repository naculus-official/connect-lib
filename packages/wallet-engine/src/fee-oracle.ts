/**
 * Fee Oracle Provider
 *
 * Bridges wallet-engine with the core fee-estimation module.
 * Provides fee estimation, resolved fee options, fee validation,
 * and fee bumping (RBF) utilities.
 *
 * All fee values are represented as hex strings throughout wallet-engine,
 * matching the existing RPC layer conventions.
 */

import type { FeeEstimationConfig, FeeValues } from "@naculus/connect-core";
import { estimateFees } from "@naculus/connect-core";
import { WalletError } from "./errors";

// ─── Public interfaces ────────────────────────────────────────────────

/** Fee estimation options for sendTransaction */
export interface FeeOptions {
  /** Force transaction type strategy */
  type?: "auto" | "eip1559" | "legacy";

  /** Override maxPriorityFeePerGas (in hex wei, e.g. "0x59682f00") */
  maxPriorityFeePerGas?: string;

  /** Base fee multiplier for maxFeePerGas calculation (default: 2n) */
  baseFeeMultiplier?: bigint;

  /** Maximum time to wait for fee estimation (ms, default: 5000) */
  timeoutMs?: number;
}

/** Resolved fee options ready to be applied to a transaction request */
export type ResolvedFeeOptions =
  | { type: "eip1559"; maxFeePerGas: string; maxPriorityFeePerGas: string }
  | { type: "legacy"; gasPrice: string };

/** Fee bumping strategy */
export type FeeBumpStrategy = "percentage" | "absolute" | "reestimate";

/** Options for bumping a transaction's fee */
export interface FeeBumpOptions {
  strategy: FeeBumpStrategy;
  /** For "percentage" strategy: multiplier (e.g., 1.1 = +10%) */
  multiplier?: number;
  /** For "absolute" strategy: new fee values */
  absolute?: {
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    gasPrice?: string;
  };
}

/** Result from estimateFee() helper */
export interface EstimatedFeeResult {
  type: "eip1559" | "legacy";
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  raw: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  };
}

// ─── Fee Oracle ───────────────────────────────────────────────────────

/**
 * Determine if a transaction should use EIP-1559 fee mechanism.
 *
 * Priority:
 * 1. `tx.type === "eip1559"` → true
 * 2. `tx.type === "legacy"` → false
 * 3. Has `maxFeePerGas` or `maxPriorityFeePerGas` → true
 * 4. Has `gasPrice` but no EIP-1559 fields → false
 * 5. Neither → auto-detect (return true, letting estimateFees decide)
 */
export function shouldUseEIP1559(tx: {
  type?: "legacy" | "eip1559";
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}): boolean {
  if (tx.type === "eip1559") return true;
  if (tx.type === "legacy") return false;
  if (tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined)
    return true;
  if (tx.gasPrice !== undefined) return false;
  // Auto-detect: fee estimation module will decide
  return true;
}

/**
 * Resolve fee options for a transaction.
 *
 * Logic:
 * 1. If user provided EIP-1559 or legacy fee fields → use them directly
 * 2. If feeOptions provides config → use fee estimation module
 * 3. If neither → auto-estimate from fee estimation module
 *
 * @param tx - Transaction request with optional user-specified fee fields
 * @param rpcUrl - RPC endpoint
 * @param chainId - Chain ID in CAIP-2 format
 * @param feeOptions - Optional fee estimation configuration
 * @returns Resolved fee options
 */
export async function resolveFeeOptions(
  tx: {
    type?: "legacy" | "eip1559";
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    gasPrice?: string;
  },
  rpcUrl: string,
  chainId?: string,
  feeOptions?: FeeOptions,
): Promise<ResolvedFeeOptions> {
  const useEIP1559 = shouldUseEIP1559(tx);

  // User already provided complete fee fields
  if (useEIP1559 && tx.maxFeePerGas && tx.maxPriorityFeePerGas) {
    return {
      type: "eip1559",
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    };
  }
  if (!useEIP1559 && tx.gasPrice) {
    return { type: "legacy", gasPrice: tx.gasPrice };
  }

  // Need to estimate — build config
  const config: FeeEstimationConfig = {
    rpcUrl,
    chainId,
    type: feeOptions?.type ?? "auto",
    maxPriorityFeePerGas: feeOptions?.maxPriorityFeePerGas
      ? BigInt(feeOptions.maxPriorityFeePerGas)
      : undefined,
    baseFeeMultiplier: feeOptions?.baseFeeMultiplier,
  };

  try {
    const fees = await estimateFees(config);
    return convertFeeValues(fees);
  } catch (error) {
    // Fallback to legacy eth_gasPrice
    return await legacyFallback(rpcUrl);
  }
}

/**
 * Convert FeeValues from core module to ResolvedFeeOptions (hex strings).
 */
function convertFeeValues(fees: FeeValues): ResolvedFeeOptions {
  if (fees.type === "eip1559") {
    return {
      type: "eip1559",
      maxFeePerGas: "0x" + fees.maxFeePerGas.toString(16),
      maxPriorityFeePerGas: "0x" + fees.maxPriorityFeePerGas.toString(16),
    };
  }
  return {
    type: "legacy",
    gasPrice: "0x" + fees.gasPrice.toString(16),
  };
}

/**
 * Fallback: fetch gas price via eth_gasPrice RPC.
 * Preserves the original wallet behavior when estimation module fails.
 */
async function legacyFallback(rpcUrl: string): Promise<ResolvedFeeOptions> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_gasPrice",
        params: [],
      }),
    });
    const json = (await response.json()) as {
      result?: string;
      error?: { message: string };
    };
    if (json.error) {
      throw new WalletError("rpc_error", `RPC error: ${json.error.message}`);
    }
    return { type: "legacy", gasPrice: json.result! };
  } catch (error) {
    throw new WalletError(
      "fee_estimation_failed",
      "Failed to estimate gas fees. Check RPC connection and chain support.",
      error,
    );
  }
}

/**
 * Validate resolved fee parameters before signing.
 * Throws WalletError on invalid values.
 */
export function validateFeeParams(fees: ResolvedFeeOptions): void {
  if (fees.type === "eip1559") {
    const maxFee = BigInt(fees.maxFeePerGas);
    const maxPriority = BigInt(fees.maxPriorityFeePerGas);

    if (maxFee <= 0n) {
      throw new WalletError(
        "invalid_fee",
        "maxFeePerGas must be greater than zero.",
      );
    }
    if (maxPriority <= 0n) {
      throw new WalletError(
        "invalid_fee",
        "maxPriorityFeePerGas must be greater than zero.",
      );
    }
    if (maxFee < maxPriority) {
      throw new WalletError(
        "invalid_fee",
        "maxFeePerGas must be greater than or equal to maxPriorityFeePerGas.",
        {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        },
      );
    }
  } else {
    const gasPrice = BigInt(fees.gasPrice);
    if (gasPrice <= 0n) {
      throw new WalletError(
        "invalid_fee",
        "gasPrice must be greater than zero.",
      );
    }
  }
}

/**
 * Apply a multiplier to a hex string gas value.
 * Used for fee bumping (RBF).
 */
export function applyMultiplier(hexValue: string, multiplier: number): string {
  const value = BigInt(hexValue);
  const scaled = (value * BigInt(Math.round(multiplier * 100))) / 100n;
  return "0x" + scaled.toString(16);
}

/**
 * Estimate current chain fees (query only, no transaction).
 *
 * @param rpcUrl - RPC endpoint
 * @param chainId - Chain ID in CAIP-2 format
 * @param feeOptions - Optional estimation config
 * @returns Estimated fee result
 */
export async function estimateFee(
  rpcUrl: string,
  chainId?: string,
  feeOptions?: Partial<FeeOptions>,
): Promise<EstimatedFeeResult> {
  const config: FeeEstimationConfig = {
    rpcUrl,
    chainId,
    type: feeOptions?.type ?? "auto",
    maxPriorityFeePerGas: feeOptions?.maxPriorityFeePerGas
      ? BigInt(feeOptions.maxPriorityFeePerGas)
      : undefined,
    baseFeeMultiplier: feeOptions?.baseFeeMultiplier,
  };

  const fees = await estimateFees(config);

  if (fees.type === "eip1559") {
    return {
      type: "eip1559",
      maxFeePerGas: "0x" + fees.maxFeePerGas.toString(16),
      maxPriorityFeePerGas: "0x" + fees.maxPriorityFeePerGas.toString(16),
      raw: {
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      },
    };
  }

  return {
    type: "legacy",
    gasPrice: "0x" + fees.gasPrice.toString(16),
    raw: { gasPrice: fees.gasPrice },
  };
}
