/**
 * EIP-1559 Fee Estimation Module
 *
 * Provides fee estimation for EVM chains with automatic support detection,
 * fallback to legacy gas price, and chain-specific estimator registration.
 *
 * @see SRS-001 §6.1
 */

import { logger } from "../logger";
import { FEE_ERROR_MESSAGES, FeeEstimationError } from "./errors";
import type {
  ChainFeeEstimator,
  ChainFeeSupport,
  FeeEstimationConfig,
  FeeValues,
  FeeValuesEIP1559,
  FeeValuesLegacy,
} from "./types";

// ─── Registry for chain-specific estimators ────────────────────────────

const chainEstimators = new Map<string, ChainFeeEstimator>();

/**
 * Register a chain-specific fee estimator.
 * Registered estimators take priority over the built-in heuristic logic.
 */
export function registerChainFeeEstimator(estimator: ChainFeeEstimator): void {
  chainEstimators.set(estimator.chainId, estimator);
}

/**
 * Remove a previously registered chain-specific estimator.
 */
export function unregisterChainFeeEstimator(chainId: string): void {
  chainEstimators.delete(chainId);
}

/**
 * Clear all registered chain-specific estimators.
 */
export function clearChainFeeEstimators(): void {
  chainEstimators.clear();
}

// ─── Internal RPC helpers (exported for testing) ───────────────────────

/**
 * Make a JSON-RPC call to the given endpoint with a 10-second timeout.
 */
async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new FeeEstimationError(
        "fee_rpc_error",
        `RPC returned status ${response.status}`,
      );
    }

    const json = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };

    if (json.error) {
      throw new FeeEstimationError("fee_rpc_error", json.error.message, {
        code: json.error.code,
      });
    }

    return json.result as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch the suggested max priority fee via eth_maxPriorityFeePerGas.
 *
 * @param rpcUrl - RPC endpoint
 * @returns The suggested priority fee (in wei), or throws if the method is not supported
 */
export async function estimateMaxPriorityFeePerGas(
  rpcUrl: string,
): Promise<bigint> {
  const result = await rpcCall<string>(rpcUrl, "eth_maxPriorityFeePerGas", []);
  return BigInt(result);
}

/**
 * Fetch the base fee per gas from the latest block.
 *
 * @param rpcUrl - RPC endpoint
 * @returns Base fee per gas in wei, or null if not available (pre-London fork)
 */
export async function getLatestBaseFee(rpcUrl: string): Promise<bigint | null> {
  const block = await rpcCall<{ baseFeePerGas?: string }>(
    rpcUrl,
    "eth_getBlockByNumber",
    ["latest", false],
  );

  if (block && typeof block.baseFeePerGas === "string") {
    return BigInt(block.baseFeePerGas);
  }

  return null;
}

/**
 * Fetch legacy gas price via eth_gasPrice.
 *
 * @param rpcUrl - RPC endpoint
 * @returns Current gas price in wei
 */
export async function getGasPrice(rpcUrl: string): Promise<bigint> {
  const result = await rpcCall<string>(rpcUrl, "eth_gasPrice", []);
  return BigInt(result);
}

/**
 * Fetch chain ID via eth_chainId.
 *
 * @param rpcUrl - RPC endpoint
 * @returns Chain ID as a bigint (supports values beyond Number.MAX_SAFE_INTEGER)
 */
export async function getChainId(rpcUrl: string): Promise<bigint> {
  const result = await rpcCall<string>(rpcUrl, "eth_chainId", []);
  return BigInt(result);
}

// ─── Chain Support Detection ───────────────────────────────────────────

/**
 * Query the chain's EIP-1559 support status and recent base fee.
 *
 * Strategy:
 * 1. Fetch the latest block to check for baseFeePerGas
 * 2. If present, the chain supports EIP-1559
 * 3. If absent, the chain uses legacy gas model
 *
 * @param rpcUrl - RPC endpoint
 * @returns ChainFeeSupport with EIP-1559 support status and data
 */
export async function getFeeData(rpcUrl: string): Promise<ChainFeeSupport> {
  const baseFee = await getLatestBaseFee(rpcUrl);

  if (baseFee !== null) {
    try {
      const recommendedPriorityFee = await estimateMaxPriorityFeePerGas(rpcUrl);
      return {
        eip1559: true,
        latestBaseFee: baseFee,
        recommendedPriorityFee,
      };
    } catch {
      // eth_maxPriorityFeePerGas is not supported; EIP-1559 still works
      return {
        eip1559: true,
        latestBaseFee: baseFee,
      };
    }
  }

  return { eip1559: false };
}

// ─── Main Fee Estimation ───────────────────────────────────────────────

/**
 * Helper to check if a chain has a registered custom estimator.
 */
function findRegisteredEstimator(
  chainId?: string,
): ChainFeeEstimator | undefined {
  if (!chainId) return undefined;
  return chainEstimators.get(chainId);
}

/**
 * Determine the transaction type from config.
 * Returns "auto", "eip1559", or "legacy".
 */
function resolveType(
  config: FeeEstimationConfig,
): "auto" | "eip1559" | "legacy" {
  if (config.type === "eip1559" || config.type === "legacy") {
    return config.type;
  }
  // Default to auto-detection
  return "auto";
}

/**
 * Build EIP-1559 fee values from base fee and config.
 */
function buildEIP1559Fees(
  baseFee: bigint,
  priorityFee: bigint,
  config: FeeEstimationConfig,
): FeeValuesEIP1559 {
  const multiplier = config.baseFeeMultiplier ?? 2n;
  const maxPriorityFeePerGas = config.maxPriorityFeePerGas ?? priorityFee;
  const maxFeePerGas = baseFee * multiplier + maxPriorityFeePerGas;

  return {
    type: "eip1559",
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

/**
 * Estimate fees for a transaction on the given chain.
 *
 * The function follows this fallback strategy:
 * 1. If a chain-specific estimator is registered, use it
 * 2. Try EIP-1559 flow (eth_maxPriorityFeePerGas + base fee)
 * 3. Fall back to legacy gas price
 * 4. All strategies fail → throw FeeEstimationError
 *
 * @param config - Fee estimation configuration
 * @returns FeeValues (eip1559 | legacy)
 *
 * @example
 * ```ts
 * const fees = await estimateFees({
 *   rpcUrl: "https://eth.llamarpc.com",
 *   chainId: "eip155:1",
 * });
 * // => { type: "eip1559", maxFeePerGas: 15000000000n, maxPriorityFeePerGas: 1000000000n }
 * ```
 */
export async function estimateFees(
  config: FeeEstimationConfig,
): Promise<FeeValues> {
  const { rpcUrl, chainId } = config;

  // Step 1: Use chain-specific estimator if available
  const estimator = findRegisteredEstimator(chainId);
  if (estimator) {
    try {
      return await estimator.estimateFees(rpcUrl, config);
    } catch (error) {
      logger.warn(
        "fee-estimation",
        `Chain estimator failed for ${chainId}, falling back`,
        error,
      );
      // Fall through to built-in logic
    }
  }

  // Step 2: Try EIP-1559
  const resolvedType = resolveType(config);

  if (resolvedType === "eip1559") {
    // User explicitly wants EIP-1559
    const priorityFee =
      config.maxPriorityFeePerGas ??
      (await estimateMaxPriorityFeePerGas(rpcUrl));
    const baseFee = await getLatestBaseFee(rpcUrl);

    if (baseFee === null) {
      throw new FeeEstimationError(
        "fee_estimation_failed",
        "EIP-1559 forced but chain does not support base fee",
      );
    }

    return buildEIP1559Fees(baseFee, priorityFee, config);
  }

  // Default "auto" mode: detect and fall back
  try {
    const priorityFee = await estimateMaxPriorityFeePerGas(rpcUrl);
    const baseFee = await getLatestBaseFee(rpcUrl);

    if (baseFee !== null) {
      return buildEIP1559Fees(baseFee, priorityFee, config);
    }

    // eth_maxPriorityFeePerGas succeeded but no base fee
    // This is unusual but fall back to legacy
    logger.warn(
      "fee-estimation",
      "No base fee found despite priority fee support, falling back to legacy",
    );
  } catch {
    // eth_maxPriorityFeePerGas not supported → legacy chain
    logger.debug(
      "fee-estimation",
      "eth_maxPriorityFeePerGas not available, using legacy",
    );
  }

  // Step 3: Legacy fallback
  try {
    const gasPrice = await getGasPrice(rpcUrl);
    return { type: "legacy", gasPrice };
  } catch (error) {
    throw new FeeEstimationError(
      "fee_estimation_failed",
      FEE_ERROR_MESSAGES.ESTIMATION_FAILED,
      { error },
    );
  }
}
