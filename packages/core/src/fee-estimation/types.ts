/**
 * EIP-1559 Fee Estimation Types
 *
 * Defines the type hierarchy for gas fee estimation following the
 * viem-style union return type pattern.
 *
 * @see SRS-001 §5.1
 */

// ─── Fee Values ────────────────────────────────────────────────────────

/** EIP-1559 (type 2) fee values */
export interface FeeValuesEIP1559 {
  type: "eip1559";
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Legacy (type 0) fee values */
export interface FeeValuesLegacy {
  type: "legacy";
  gasPrice: bigint;
}

/** Union type for fee estimation return values */
export type FeeValues = FeeValuesEIP1559 | FeeValuesLegacy;

// ─── Configuration ─────────────────────────────────────────────────────

/** Force a specific fee type strategy */
export type FeeTypeStrategy = "auto" | "eip1559" | "legacy";

/** Configuration for the fee estimation */
export interface FeeEstimationConfig {
  /** Chain ID in CAIP-2 format (e.g., "eip155:1" for Ethereum mainnet) */
  chainId?: string;

  /** Force a specific transaction type strategy */
  type?: FeeTypeStrategy;

  /** Override maxPriorityFeePerGas (only used for eip1559) */
  maxPriorityFeePerGas?: bigint;

  /** Multiplier applied to base fee for maxFeePerGas (default: 2n) */
  baseFeeMultiplier?: bigint;

  /** RPC endpoint URL */
  rpcUrl: string;
}

// ─── Chain Support ─────────────────────────────────────────────────────

/** Result of checking a chain's EIP-1559 support */
export interface ChainFeeSupport {
  /** Whether the chain supports EIP-1559 */
  eip1559: boolean;
  /** Latest block's base fee per gas (available when eip1559 is true) */
  latestBaseFee?: bigint;
  /** Recommended priority fee (available when eip1559 is true) */
  recommendedPriorityFee?: bigint;
}

/** Chain-specific fee estimator override for L2s with custom fee models */
export interface ChainFeeEstimator {
  /** CAIP-2 chain identifier (e.g., "eip155:10" for Optimism) */
  chainId: string;
  /**
   * Estimate fees for the chain.
   * Called before the built-in heuristic logic.
   */
  estimateFees(
    rpcUrl: string,
    config?: Partial<FeeEstimationConfig>,
  ): Promise<FeeValues>;
}
