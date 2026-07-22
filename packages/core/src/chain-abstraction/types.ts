/**
 * Chain Abstraction Types
 *
 * Core type definitions for cross-chain intent routing (Chain Abstraction).
 * Defines Quote, RouteExecution, CostComparison, and supporting types
 * for the Route Engine and Bridge Providers.
 *
 * @see docs/features/chain-abstraction.md
 */

// ─── Route Discovery ───────────────────────────────────────────────────

/** Bridge provider identifier */
export type BridgeProviderId = "lifi" | "axelar" | "socket" | "across";

/**
 * Route step within a cross-chain route.
 * Cross-chain routes typically decompose into:
 *   1. Approve (optional) on source chain
 *   2. Swap on source chain (optional)
 *   3. Cross-chain bridge transfer
 *   4. Swap on destination chain (optional)
 */
export interface RouteStep {
  type: "approve" | "swap" | "cross-chain";
  chain: string;
  token: string;
  contractAddress: string;
  data?: string;
  /** EIP-1559 formatted gas estimate (bigint serialized as string) */
  estimatedGas: string;
}

/** Gas cost estimate for a single chain in a cross-chain route */
export interface GasEstimate {
  /** Max fee per gas in wei (serialized bigint) */
  maxFeePerGas: string;
  /** Max priority fee in wei (serialized bigint) */
  maxPriorityFeePerGas: string;
  /** Estimated gas units */
  gasLimit: string;
  /** Total estimated gas cost in wei */
  totalCostWei: string;
  /** Total estimated gas cost in USD string */
  totalCostUsd: string;
}

/**
 * A discovered cross-chain route returned by a bridge provider.
 */
export interface Route {
  /** Unique route identifier */
  id: string;
  /** The bridge provider that discovered this route */
  provider: BridgeProviderId;
  /** Source chain CAIP-2 identifier */
  fromChain: string;
  /** Destination chain CAIP-2 identifier */
  toChain: string;
  /** Source token contract address (or native token symbol for ETH/MATIC/SOL) */
  fromToken: string;
  /** Destination token contract address */
  toToken: string;
  /** Input amount in raw form (smallest unit, e.g. wei) */
  fromAmount: string;
  /** Expected output amount in raw form */
  toAmount: string;
  /** Minimum guaranteed output amount (accounting for slippage) */
  toAmountMin: string;
  /** Gas cost breakdown for each chain involved */
  gasCosts: {
    fromChain: GasEstimate;
    toChain: GasEstimate;
    totalUsd: string;
  };
  /** Estimated time in seconds */
  estimatedTime: number;
  /** Decomposition of this route into individual steps */
  steps: RouteStep[];
  /** Fee breakdown */
  fee: {
    protocolFee: string;
    integrationFee?: string;
  };
  /** Human-readable summary of the route */
  summary: string;
}

// ─── Quote ─────────────────────────────────────────────────────────────

/** Sorting options for quote aggregation */
export type QuoteSortBy = "netReceive" | "fastest" | "cheapest";

export interface QuoteOptions {
  /** Slippage tolerance in percent (default 0.5) */
  slippage?: number;
  /** Preferred bridge providers */
  preferredBridges?: BridgeProviderId[];
  /** Bridge providers to exclude */
  excludeBridges?: BridgeProviderId[];
  /** Sort order for returned quotes */
  sortBy?: QuoteSortBy;
}

/**
 * A unified cross-chain quote ready for display and execution.
 * Aggregates data from a Route with formatting and cost metadata.
 */
export interface Quote {
  /** Reference to the originating route ID */
  routeId: string;
  /** Bridge provider */
  provider: BridgeProviderId;
  /** Source chain CAIP-2 */
  fromChain: string;
  /** Destination chain CAIP-2 */
  toChain: string;
  /** Source token symbol (e.g. "USDC") */
  fromTokenSymbol: string;
  /** Destination token symbol */
  toTokenSymbol: string;
  /** Source amount, formatted for display (e.g. "100.00") */
  fromAmountFormatted: string;
  /** Destination amount, formatted for display */
  toAmountFormatted: string;
  /** Minimum guaranteed output, formatted */
  toAmountMinFormatted: string;
  /** Effective exchange rate (1 fromToken = ? toToken) */
  exchangeRate: string;
  /** Price impact percentage */
  priceImpact: string;
  /** Total gas cost in USD */
  totalGasCostUsd: string;
  /** Total protocol and integration fees in USD */
  totalFeeUsd: string;
  /** Net receive amount after gas + fees, formatted */
  netReceiveFormatted: string;
  /** Estimated arrival time as human-readable string */
  estimatedArrival: string;
  /** Estimated arrival in seconds */
  estimatedArrivalSeconds: number;
  /** Human-readable step summary */
  summary: string;
  /** Whether this quote requires an approve transaction before execution */
  needsApprove: boolean;
  /** Approve target address (token contract to approve) */
  approveTarget?: string;
  /** Approve spender address (bridge contract) */
  approveSpender?: string;
  /** Approve amount in raw form */
  approveAmount?: string;
  /** Timestamp when this quote expires (ms) */
  expiresAt: number;
}

// ─── Route Status ─────────────────────────────────────────────────────

export type RouteStatusValue = "pending" | "bridging" | "completed" | "failed";

export interface RouteStatus {
  status: RouteStatusValue;
  fromTxHash?: string;
  toTxHash?: string;
  currentStep?: string;
  /** Progress percentage 0-100 */
  progress?: number;
  /** Estimated completion timestamp (epoch ms) */
  estimatedCompletionAt?: number;
  /** Error message if status === "failed" */
  error?: string;
}

// ─── Route Execution ───────────────────────────────────────────────────

export interface ExecuteOptions {
  /** Recipient address on the destination chain */
  recipient?: string;
  /** Whether to automatically handle approve transactions */
  autoApprove?: boolean;
  /** Custom approve amount in raw form (overrides default) */
  approveAmount?: string;
}

export interface ExecuteRouteResult {
  /** Source chain transaction hash */
  fromTxHash: string;
  /** Source chain CAIP-2 */
  fromChain: string;
  /** Destination chain transaction hash (populated once bridging completes) */
  toTxHash?: string;
  /** Destination chain CAIP-2 */
  toChain: string;
  /** Current execution status */
  status: RouteStatusValue;
  /** Bridge provider reference ID (for status polling) */
  bridgeReference?: string;
  /** Estimated completion timestamp (epoch ms) */
  estimatedCompletionAt?: number;
  /** Error message if status === "failed" */
  error?: string;
}

// ─── Cost Comparison ─────────────────────────────────────────────────

export type CostComparisonOperation =
  | "send_native"
  | "send_erc20"
  | "swap"
  | "cross_chain_transfer";

export interface CostComparisonOptions {
  /** Token contract address relevant to the operation */
  token?: string;
  /** Amount in raw form */
  amount?: string;
  /** Include cross-chain fees in comparison */
  includeCrossChain?: boolean;
}

export interface CostComparison {
  /** Chain CAIP-2 identifier */
  chain: string;
  /** Human-readable chain name */
  chainName: string;
  /** Gas cost in USD */
  gasCost: string;
  /** Protocol/bridge fees in USD */
  fee: string;
  /** Total cost (gas + fees) in USD */
  totalCost: string;
  /** Estimated time in seconds */
  time: number;
  /** Congestion level (optional) */
  congestionLevel?: "low" | "medium" | "high";
}

// ─── Chain Abstraction Config ──────────────────────────────────────────

export interface ChainAbstractionConfig {
  /** Senderpay backend URL (for proxy-based route discovery) */
  backendUrl?: string;
  /** Quote cache TTL in ms (default 30000) */
  quoteCacheTtl?: number;
  /** Status polling interval in ms (default 2000) */
  statusPollInterval?: number;
  /** Default slippage in percent (default 0.5) */
  defaultSlippage?: number;
  /** LiFi SDK API key (optional, for direct SDK usage) */
  lifiApiKey?: string;
  /** Axelar API key / config (optional, for direct SDK usage) */
  axelarConfig?: {
    apiUrl?: string;
  };
}

// ─── Bridge Provider Interface ─────────────────────────────────────────

/**
 * Abstract interface for a cross-chain bridge provider.
 * Each provider (LiFi, Axelar, Socket, Across) implements this
 * to be registered with the RouteEngine.
 */
export interface BridgeProvider {
  /** Unique provider identifier */
  readonly id: BridgeProviderId;
  /** Human-readable provider name */
  readonly name: string;

  /**
   * Discover available routes for a cross-chain transfer.
   *
   * @param fromChain - Source chain CAIP-2
   * @param toChain - Destination chain CAIP-2
   * @param fromToken - Source token address/symbol
   * @param toToken - Destination token address/symbol
   * @param amount - Amount in raw form (smallest unit)
   * @returns Array of discovered routes (empty if no routes found)
   */
  getRoutes(
    fromChain: string,
    toChain: string,
    fromToken: string,
    toToken: string,
    amount: string,
  ): Promise<Route[]>;

  /**
   * Build transaction parameters to execute a given route.
   *
   * @param route - The selected route to execute
   * @param sender - Sender address
   * @param recipient - Recipient address on destination chain
   * @returns Transaction parameters for the execution
   */
  getTransactionParams(
    route: Route,
    sender: string,
    recipient: string,
  ): Promise<ProviderTransaction[]>;

  /**
   * Query the current execution status of a cross-chain transfer.
   *
   * @param bridgeReference - Reference ID from the provider
   * @returns Current route status
   */
  getRouteStatus(bridgeReference: string): Promise<RouteStatus>;

  /**
   * Check whether this provider supports a given chain pair.
   *
   * @param fromChain - Source chain CAIP-2
   * @param toChain - Destination chain CAIP-2
   * @returns true if the chain pair is supported
   */
  supportsChainPair(fromChain: string, toChain: string): boolean;

  /**
   * Check whether this provider supports a given token on a chain.
   *
   * @param chain - Chain CAIP-2
   * @param token - Token contract address or symbol
   * @returns true if the token is supported
   */
  supportsToken(chain: string, token: string): boolean;
}

export interface ProviderTransaction {
  type: "approve" | "cross-chain";
  chainId: string;
  to: string;
  data: string;
  value: string;
}

// ─── Errors ────────────────────────────────────────────────────────────

export type ChainAbstractionErrorCode =
  | "chain_pair_not_supported"
  | "token_not_supported"
  | "route_expired"
  | "insufficient_balance"
  | "approve_needed"
  | "approve_rejected"
  | "transaction_failed"
  | "backend_unavailable"
  | "invalid_config"
  | "no_routes_available"
  | "provider_unavailable"
  | "execution_failed";

export class ChainAbstractionError extends Error {
  code: ChainAbstractionErrorCode;
  details?: Record<string, unknown>;

  constructor(
    code: ChainAbstractionErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "ChainAbstractionError";
    this.code = code;
    this.details = details;
  }
}

export function isChainAbstractionError(
  e: unknown,
  code?: ChainAbstractionErrorCode,
): e is ChainAbstractionError {
  if (!e || typeof e !== "object") return false;
  const candidate = e as ChainAbstractionError;
  if (
    candidate.name !== "ChainAbstractionError" ||
    typeof candidate.code !== "string"
  )
    return false;
  return code ? candidate.code === code : true;
}
