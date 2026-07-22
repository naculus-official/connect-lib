/**
 * Chain Route Engine
 *
 * Core engine for cross-chain intent routing. Discovers routes across
 * multiple bridge providers, aggregates quotes, and handles execution.
 *
 * Supports a pluggable provider registration mechanism so new bridges
 * (Socket, Across, etc.) can be added without modifying this engine.
 *
 * @see docs/features/chain-abstraction.md §3
 */

import { logger } from "../logger";
import { formatUnits } from "../token/units";
import type {
  BridgeProvider,
  BridgeProviderId,
  ChainAbstractionConfig,
  ChainAbstractionErrorCode,
  CostComparison,
  CostComparisonOperation,
  CostComparisonOptions,
  ExecuteOptions,
  ExecuteRouteResult,
  Quote,
  QuoteOptions,
  QuoteSortBy,
  Route,
  RouteStatus,
} from "./types";
import { ChainAbstractionError } from "./types";

// ─── Default provider configuration ────────────────────────────────────

const DEFAULT_QUOTE_CACHE_TTL = 30_000; // 30 seconds
const DEFAULT_STATUS_POLL_INTERVAL = 2_000; // 2 seconds
const DEFAULT_SLIPPAGE = 0.5; // 0.5%

// ─── Known native token symbols per chain ──────────────────────────────

const NATIVE_TOKEN_SYMBOLS: Record<string, string> = {
  "eip155:1": "ETH",
  "eip155:10": "ETH",
  "eip155:42161": "ETH",
  "eip155:8453": "ETH",
  "eip155:137": "MATIC",
  "eip155:43114": "AVAX",
  "eip155:56": "BNB",
  "eip155:250": "FTM",
  "eip155:324": "ETH",
  "eip155:59144": "ETH",
  "eip155:534352": "ETH",
  "eip155:100": "xDai",
  "eip155:1101": "ETH",
};

const NATIVE_TOKEN_DECIMALS: Record<string, number> = {
  "eip155:1": 18,
  "eip155:10": 18,
  "eip155:42161": 18,
  "eip155:8453": 18,
  "eip155:137": 18,
  "eip155:43114": 18,
  "eip155:56": 18,
  "eip155:250": 18,
  "eip155:324": 18,
  "eip155:59144": 18,
  "eip155:534352": 18,
  "eip155:100": 18,
  "eip155:1101": 18,
};

// ─── Cache entry for quotes ────────────────────────────────────────────

interface CachedQuote {
  routes: Route[];
  cachedAt: number;
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  amount: string;
}

// ─── RouteEngine ───────────────────────────────────────────────────────

export class RouteEngine {
  private providers: Map<BridgeProviderId, BridgeProvider> = new Map();
  private config: Required<
    Pick<
      ChainAbstractionConfig,
      "quoteCacheTtl" | "statusPollInterval" | "defaultSlippage"
    >
  > &
    ChainAbstractionConfig;

  /** Simple in-memory quote cache (route-level, before formatting) */
  private quoteCache: Map<string, CachedQuote> = new Map();

  /** Route store: maps routeId → Route for execution lookup */
  private routeStore: Map<string, Route> = new Map();

  constructor(config?: ChainAbstractionConfig) {
    this.config = {
      quoteCacheTtl: config?.quoteCacheTtl ?? DEFAULT_QUOTE_CACHE_TTL,
      statusPollInterval:
        config?.statusPollInterval ?? DEFAULT_STATUS_POLL_INTERVAL,
      defaultSlippage: config?.defaultSlippage ?? DEFAULT_SLIPPAGE,
      backendUrl: config?.backendUrl,
      lifiApiKey: config?.lifiApiKey,
      axelarConfig: config?.axelarConfig,
    };
  }

  // ── Provider Registration ───────────────────────────────────────────

  /**
   * Register a bridge provider with the route engine.
   * Providers can be added at any time; they are discovered
   * on each getQuote() call.
   */
  registerProvider(provider: BridgeProvider): void {
    if (this.providers.has(provider.id)) {
      logger.warn(
        "route-engine",
        `Overwriting existing provider: ${provider.id}`,
      );
    }
    this.providers.set(provider.id, provider);
    logger.debug("route-engine", `Registered provider: ${provider.id}`);
  }

  /**
   * Unregister a previously registered provider.
   */
  unregisterProvider(providerId: BridgeProviderId): void {
    this.providers.delete(providerId);
  }

  /**
   * Get a registered provider by ID.
   */
  getProvider(providerId: BridgeProviderId): BridgeProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * List all registered providers.
   */
  listProviders(): BridgeProvider[] {
    return Array.from(this.providers.values());
  }

  // ── Quote Discovery ─────────────────────────────────────────────────

  /**
   * Get cross-chain quotes for a given transfer.
   *
   * Discovers routes from all registered providers that support the
   * requested chain pair and token, then formats them into unified
   * Quote objects sorted by the specified strategy.
   *
   * @param fromChain - Source chain CAIP-2 (e.g. "eip155:1" for Ethereum)
   * @param toChain - Destination chain CAIP-2
   * @param token - Token to transfer (symbol or contract address)
   * @param amount - Amount in raw form (smallest unit)
   * @param options - Optional quote options (slippage, sort, provider filters)
   * @returns Sorted array of Quote objects
   *
   * @throws {ChainAbstractionError} if no routes are found or providers
   *         are unavailable
   */
  async getQuote(
    fromChain: string,
    toChain: string,
    token: string,
    amount: string,
    options?: QuoteOptions,
  ): Promise<Quote[]> {
    if (BigInt(amount) <= 0n) {
      throw new ChainAbstractionError(
        "invalid_config",
        "Amount must be positive",
      );
    }

    // Check cache
    const cacheKey = this.buildCacheKey(fromChain, toChain, token, amount);
    const cached = this.quoteCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.config.quoteCacheTtl) {
      logger.debug("route-engine", "Returning cached quotes");
      return this.formatAndSortQuotes(cached.routes, options);
    }

    // Discover routes from all registered providers that support this pair
    const allRoutes: Route[] = [];
    const errors: Array<{ provider: BridgeProviderId; error: string }> = [];

    const activeProviders = this.getActiveProviders(
      fromChain,
      toChain,
      token,
      options,
    );

    if (activeProviders.length === 0) {
      throw new ChainAbstractionError(
        "no_routes_available",
        `No providers available for chain pair ${fromChain} → ${toChain} with token ${token}`,
      );
    }

    // Query all providers in parallel
    const results = await Promise.allSettled(
      activeProviders.map((provider) =>
        provider
          .getRoutes(fromChain, toChain, token, token, amount)
          .catch((err: Error) => {
            errors.push({ provider: provider.id, error: err.message });
            return [] as Route[];
          }),
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        allRoutes.push(...result.value);
      }
    }

    if (allRoutes.length === 0) {
      // If there were errors, throw with details
      if (errors.length > 0) {
        throw new ChainAbstractionError(
          "no_routes_available",
          `No routes found from ${fromChain} to ${toChain}. Provider errors: ${errors.map((e) => `${e.provider}: ${e.error}`).join("; ")}`,
          { errors },
        );
      }
      throw new ChainAbstractionError(
        "no_routes_available",
        `No routes available from ${fromChain} to ${toChain} for token ${token}`,
      );
    }

    // Store in route store and cache the raw routes
    for (const route of allRoutes) {
      this.routeStore.set(route.id, route);
    }

    this.quoteCache.set(cacheKey, {
      routes: allRoutes,
      cachedAt: Date.now(),
      fromChain,
      toChain,
      fromToken: token,
      toToken: token,
      amount,
    });

    // Clean stale cache entries
    this.cleanCache();

    return this.formatAndSortQuotes(allRoutes, options);
  }

  // ── Route Execution ─────────────────────────────────────────────────

  /**
   * Execute a cross-chain route from a selected quote.
   *
   * Returns transaction hashes and a bridge reference for status tracking.
   * Actual transaction sending is handled by the caller (e.g., ConnectorManager).
   *
   * @param quote - The selected Quote to execute
   * @param recipient - Recipient address on the destination chain
   * @param options - Execution options (autoApprove, recipient)
   * @returns ExecuteRouteResult with transaction tracking info
   *
   * @throws {ChainAbstractionError} if the route is expired, provider
   *         is unavailable, or execution fails
   */
  async executeRoute(
    quote: Quote,
    recipient: string,
    options?: ExecuteOptions,
  ): Promise<ExecuteRouteResult> {
    // Validate quote expiry
    if (Date.now() > quote.expiresAt) {
      throw new ChainAbstractionError(
        "route_expired",
        "This quote has expired. Please fetch a new quote.",
      );
    }

    // Find the route from route store
    const route = this.routeStore.get(quote.routeId);
    if (!route) {
      throw new ChainAbstractionError(
        "no_routes_available",
        `Route ${quote.routeId} not found. It may have expired.`,
      );
    }

    const provider = this.providers.get(quote.provider);
    if (!provider) {
      throw new ChainAbstractionError(
        "provider_unavailable",
        `Provider ${quote.provider} is not registered`,
      );
    }

    const resolvedRecipient = options?.recipient ?? recipient;

    try {
      // Get transaction parameters from the provider
      const txParams = await provider.getTransactionParams(
        route,
        "sender",
        resolvedRecipient,
      );

      // Check if approve is needed
      const approveTx = txParams.find((tx) => tx.type === "approve");
      const crossChainTx = txParams.find((tx) => tx.type === "cross-chain");

      if (!crossChainTx) {
        throw new ChainAbstractionError(
          "execution_failed",
          "No cross-chain transaction parameters returned by provider",
        );
      }

      if (approveTx && options?.autoApprove !== false) {
        // Signal that approve is needed
        throw new ChainAbstractionError(
          "approve_needed",
          `Token approval required for ${quote.fromTokenSymbol} on ${quote.fromChain}`,
          {
            approveParams: approveTx,
          },
        );
      }

      return {
        fromTxHash: "pending", // Will be populated after actual sending
        fromChain: quote.fromChain,
        toChain: quote.toChain,
        status: "pending",
        bridgeReference: quote.routeId,
        estimatedCompletionAt:
          Date.now() + quote.estimatedArrivalSeconds * 1000,
      };
    } catch (error) {
      if (error instanceof ChainAbstractionError) throw error;
      throw new ChainAbstractionError(
        "execution_failed",
        `Failed to execute route: ${(error as Error).message}`,
      );
    }
  }

  // ── Cost Comparison ─────────────────────────────────────────────────

  /**
   * Compare costs of performing an operation across multiple chains.
   *
   * Useful for helping users decide which chain is cheapest for
   * a given operation (send, swap, cross-chain transfer).
   *
   * @param operation - The operation type to compare
   * @param chains - Array of CAIP-2 chain IDs to compare
   * @param options - Optional comparison parameters
   * @returns Array of CostComparison sorted by total cost ascending
   */
  async compareCosts(
    operation: CostComparisonOperation,
    chains: string[],
    options?: CostComparisonOptions,
  ): Promise<CostComparison[]> {
    if (chains.length === 0) {
      return [];
    }

    const results: CostComparison[] = [];
    const errors: Array<{ chain: string; error: string }> = [];

    const comparisons = await Promise.allSettled(
      chains.map(async (chain) => {
        return this.evaluateChainCost(chain, operation, options);
      }),
    );

    for (let i = 0; i < comparisons.length; i++) {
      const result = comparisons[i];
      const chain = chains[i];
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        errors.push({
          chain,
          error: result.reason?.message ?? "Unknown error",
        });
      }
    }

    if (results.length === 0 && errors.length > 0) {
      throw new ChainAbstractionError(
        "backend_unavailable",
        `Failed to evaluate costs for any chain: ${errors.map((e) => `${e.chain}: ${e.error}`).join("; ")}`,
      );
    }

    // Sort by total cost ascending
    return results.sort(
      (a, b) => parseFloat(a.totalCost) - parseFloat(b.totalCost),
    );
  }

  // ── Route Status ────────────────────────────────────────────────────

  /**
   * Poll the current status of a cross-chain route execution.
   *
   * @param bridgeReference - The reference ID returned from executeRoute
   * @returns Current RouteStatus
   */
  async getRouteStatus(bridgeReference: string): Promise<RouteStatus> {
    // Try to find the provider by scanning route IDs
    // In production, store the provider mapping at execution time
    for (const [, provider] of this.providers) {
      try {
        const status = await provider.getRouteStatus(bridgeReference);
        return status;
      } catch {}
    }

    return { status: "pending" };
  }

  // ── Internal Helpers ────────────────────────────────────────────────

  /**
   * Get the subset of providers that support the given chain pair and token.
   * Filters by preferred/excluded bridges if configured.
   */
  private getActiveProviders(
    fromChain: string,
    toChain: string,
    token: string,
    options?: QuoteOptions,
  ): BridgeProvider[] {
    let candidates = Array.from(this.providers.values());

    // Filter by provider support
    candidates = candidates.filter((p) =>
      p.supportsChainPair(fromChain, toChain),
    );

    // Apply preferred bridges filter
    if (options?.preferredBridges && options.preferredBridges.length > 0) {
      const preferredSet = new Set(options.preferredBridges);
      candidates = candidates.filter((p) => preferredSet.has(p.id));
    }

    // Apply exclude bridges filter
    if (options?.excludeBridges && options.excludeBridges.length > 0) {
      const excludeSet = new Set(options.excludeBridges);
      candidates = candidates.filter((p) => !excludeSet.has(p.id));
    }

    return candidates;
  }

  /**
   * Format raw routes into display-ready Quote objects and sort them.
   */
  private formatAndSortQuotes(
    routes: Route[],
    options?: QuoteOptions,
  ): Quote[] {
    const fromDecimals =
      NATIVE_TOKEN_DECIMALS[routes[0]?.fromChain ?? "eip155:1"] ?? 18;
    const toDecimals =
      NATIVE_TOKEN_DECIMALS[routes[0]?.toChain ?? "eip155:1"] ?? 18;

    const quotes: Quote[] = routes.map((route) => {
      const toAmount = BigInt(route.toAmount);
      const toAmountMin = BigInt(route.toAmountMin);
      const fromAmount = BigInt(route.fromAmount);

      const expiry = this.config.quoteCacheTtl;

      let exchangeRate = "0";
      if (fromAmount > 0n) {
        // Calculate exchange rate: toAmount / fromAmount
        // Scale to fixed precision using bigint arithmetic to avoid precision loss
        const scaled = (toAmount * 10_000n) / fromAmount;
        const whole = scaled / 10_000n;
        const remainder = scaled % 10_000n;
        exchangeRate = `${whole}.${remainder.toString().padStart(4, "0")}`;
      }

      const priceImpact = "0";
      const fromFormatted = formatUnits(fromAmount, fromDecimals);
      const toFormatted = formatUnits(toAmount, toDecimals);
      const toMinFormatted = formatUnits(toAmountMin, toDecimals);

      return {
        routeId: route.id,
        provider: route.provider,
        fromChain: route.fromChain,
        toChain: route.toChain,
        fromTokenSymbol: this.resolveTokenSymbol(
          route.fromChain,
          route.fromToken,
        ),
        toTokenSymbol: this.resolveTokenSymbol(route.toChain, route.toToken),
        fromAmountFormatted: fromFormatted,
        toAmountFormatted: toFormatted,
        toAmountMinFormatted: toMinFormatted,
        exchangeRate,
        priceImpact,
        totalGasCostUsd: route.gasCosts.totalUsd,
        totalFeeUsd: this.formatFeeUsd(route),
        netReceiveFormatted: toFormatted,
        estimatedArrival: this.formatEstimatedTime(route.estimatedTime),
        estimatedArrivalSeconds: route.estimatedTime,
        summary: route.summary,
        needsApprove: route.steps.some((s) => s.type === "approve"),
        expiresAt: Date.now() + expiry,
      };
    });

    // Sort by the requested strategy
    const sortBy = options?.sortBy ?? "netReceive";
    return this.sortQuotes(quotes, sortBy);
  }

  /**
   * Sort quotes by the specified strategy.
   */
  private sortQuotes(quotes: Quote[], sortBy: QuoteSortBy): Quote[] {
    const sorted = [...quotes];

    switch (sortBy) {
      case "fastest":
        sorted.sort(
          (a, b) => a.estimatedArrivalSeconds - b.estimatedArrivalSeconds,
        );
        break;
      case "cheapest":
        sorted.sort((a, b) => {
          const gasDiff =
            parseFloat(a.totalGasCostUsd) - parseFloat(b.totalGasCostUsd);
          if (gasDiff !== 0) return gasDiff;
          return parseFloat(a.totalFeeUsd) - parseFloat(b.totalFeeUsd);
        });
        break;
      case "netReceive":
      default:
        sorted.sort((a, b) => {
          const aNet = parseFloat(a.netReceiveFormatted);
          const bNet = parseFloat(b.netReceiveFormatted);
          return bNet - aNet; // descending: most received first
        });
        break;
    }

    return sorted;
  }

  /**
   * Resolve a token symbol from a chain and token address.
   */
  private resolveTokenSymbol(chain: string, token: string): string {
    // Check if it's a native token
    if (token === "0x0000000000000000000000000000000000000000") {
      return NATIVE_TOKEN_SYMBOLS[chain] ?? "UNKNOWN";
    }

    // Check known tokens
    for (const [chainId, tokens] of Object.entries(KNOWN_TOKEN_LIST)) {
      if (chainId === chain) {
        for (const [symbol, address] of Object.entries(tokens)) {
          if (address.toLowerCase() === token.toLowerCase()) {
            return symbol;
          }
        }
      }
    }

    // Fall back to the token address abbreviation
    return token.startsWith("0x") ? token.slice(0, 10) : token;
  }

  /**
   * Format the total fee (protocol + integration) as a USD string.
   */
  private formatFeeUsd(route: Route): string {
    const protocolFee = BigInt(route.fee.protocolFee);
    const integrationFee = route.fee.integrationFee
      ? BigInt(route.fee.integrationFee)
      : 0n;
    const total = protocolFee + integrationFee;

    if (total === 0n) return "0";
    return formatUnits(total, 18);
  }

  /**
   * Format estimated time as human-readable string.
   */
  private formatEstimatedTime(seconds: number): string {
    if (seconds < 60) {
      return `~${seconds} seconds`;
    } else if (seconds < 3600) {
      return `~${Math.floor(seconds / 60)} minutes`;
    } else {
      return `~${(seconds / 3600).toFixed(1)} hours`;
    }
  }

  /**
   * Build a cache key from quote parameters.
   */
  private buildCacheKey(
    fromChain: string,
    toChain: string,
    token: string,
    amount: string,
  ): string {
    return `${fromChain}:${toChain}:${token}:${amount}`;
  }

  /**
   * Get cached routes by route ID.
   */
  /**
   * Clean stale cache entries.
   */
  private cleanCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.quoteCache.entries()) {
      if (now - entry.cachedAt > this.config.quoteCacheTtl * 2) {
        this.quoteCache.delete(key);
      }
    }
  }

  /**
   * Evaluate the cost of an operation on a single chain.
   */
  private async evaluateChainCost(
    chain: string,
    operation: CostComparisonOperation,
    options?: CostComparisonOptions,
  ): Promise<CostComparison> {
    const chainName = this.getChainName(chain);
    const nativeSymbol = NATIVE_TOKEN_SYMBOLS[chain] ?? "ETH";

    // Simulate gas cost estimation based on operation type
    const gasUnits = this.getEstimatedGasUnits(operation);
    const GAS_PRICE_WEI = 50_000_000_000n;
    const ETH_DECIMALS = 1_000_000_000_000_000_000n; // 10^18
    const gasCostEthNum = Number((gasUnits * GAS_PRICE_WEI) / ETH_DECIMALS);
    const gasCost = gasCostEthNum.toFixed(6);
    const nativePriceUsd = this.getNativeTokenPriceUsd(chain);

    const gasCostUsd = (parseFloat(gasCost) * nativePriceUsd).toFixed(2);
    let fee = "0";

    if (operation === "cross_chain_transfer" && options?.includeCrossChain) {
      // Simulate bridge fee for cross-chain operations
      fee = (0.5 * nativePriceUsd).toFixed(2);
    }

    const totalCost = (parseFloat(gasCostUsd) + parseFloat(fee)).toFixed(2);

    return {
      chain,
      chainName,
      gasCost: gasCostUsd,
      fee,
      totalCost,
      time: this.getEstimatedTime(chain, operation),
      congestionLevel: this.getCongestionLevel(chain),
    };
  }

  /**
   * Get estimated gas units for a given operation type.
   */
  private getEstimatedGasUnits(operation: CostComparisonOperation): bigint {
    switch (operation) {
      case "send_native":
        return 21_000n;
      case "send_erc20":
        return 65_000n;
      case "swap":
        return 150_000n;
      case "cross_chain_transfer":
        return 300_000n;
    }
  }

  /**
   * Get estimated time in seconds for an operation on a chain.
   */
  private getEstimatedTime(
    chain: string,
    _operation: CostComparisonOperation,
  ): number {
    // Simplified: based on chain block time
    const blockTimes: Record<string, number> = {
      "eip155:1": 12,
      "eip155:10": 2,
      "eip155:42161": 0.25,
      "eip155:8453": 2,
      "eip155:137": 2,
    };

    const blocksNeeded = 2;
    const blockTime = blockTimes[chain] ?? 12;
    return Math.round(blockTime * blocksNeeded);
  }

  /**
   * Get a human-readable chain name.
   */
  private getChainName(chain: string): string {
    const names: Record<string, string> = {
      "eip155:1": "Ethereum",
      "eip155:137": "Polygon",
      "eip155:10": "Optimism",
      "eip155:42161": "Arbitrum",
      "eip155:8453": "Base",
      "eip155:43114": "Avalanche",
      "eip155:56": "BNB Chain",
      "eip155:250": "Fantom",
      "eip155:324": "zkSync Era",
      "eip155:59144": "Linea",
      "eip155:534352": "Scroll",
      "eip155:100": "Gnosis",
      "eip155:1101": "Polygon zkEVM",
    };
    return names[chain] ?? chain;
  }

  /**
   * Get native token price in USD (simplified).
   */
  private getNativeTokenPriceUsd(chain: string): number {
    const prices: Record<string, number> = {
      "eip155:1": 3500,
      "eip155:10": 3500,
      "eip155:42161": 3500,
      "eip155:8453": 3500,
      "eip155:137": 0.7,
      "eip155:43114": 35,
      "eip155:56": 580,
      "eip155:250": 0.5,
      "eip155:324": 3500,
      "eip155:59144": 3500,
      "eip155:534352": 3500,
      "eip155:100": 1,
      "eip155:1101": 3500,
    };
    return prices[chain] ?? 100;
  }

  /**
   * Get congestion level for a chain.
   */
  private getCongestionLevel(chain: string): "low" | "medium" | "high" {
    const congestion: Record<string, "low" | "medium" | "high"> = {
      "eip155:1": "high",
      "eip155:10": "medium",
      "eip155:42161": "medium",
      "eip155:8453": "low",
      "eip155:137": "medium",
    };
    return congestion[chain] ?? "low";
  }
}

// ─── Known token list for symbol resolution ────────────────────────────

const KNOWN_TOKEN_LIST: Record<string, Record<string, string>> = {
  "eip155:1": {
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  "eip155:137": {
    USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  },
  "eip155:10": {
    USDC: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    WETH: "0x4200000000000000000000000000000000000006",
  },
  "eip155:42161": {
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  },
  "eip155:8453": {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
  },
};

// ─── Factory function ──────────────────────────────────────────────────

export function createRouteEngine(
  config?: ChainAbstractionConfig,
): RouteEngine {
  return new RouteEngine(config);
}
