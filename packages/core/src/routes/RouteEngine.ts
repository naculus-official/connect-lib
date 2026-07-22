/**
 * RouteEngine
 *
 * Cross-chain routing engine with provider-agnostic swap and bridge providers.
 *
 * Features:
 * - Pluggable swap and bridge provider registration
 * - Multi-provider quote aggregation and cost comparison
 * - USDC priority logic with configurable threshold
 * - Route execution via pluggable executor
 *
 * @see docs/features/routes.md
 */

import { CHAINS, getChainInfo } from "../chain-registry";
import type { EVMRouteExecutor } from "./executor/EVMRouteExecutor";
import type {
  BridgeProvider,
  Route,
  RouteEngineConfig,
  RouteQuote,
  RouteStep,
  SwapProvider,
  Token,
} from "./types";
import { RouteEngineError } from "./types";

// ─── RouteEngine ───────────────────────────────────────────────────────

export class RouteEngine {
  private swapProviders: Map<string, SwapProvider> = new Map();
  private bridgeProviders: Map<string, BridgeProvider> = new Map();
  private executor: EVMRouteExecutor | null = null;
  private config: Required<
    Pick<RouteEngineConfig, "defaultSlippage" | "usdcPriorityThreshold">
  > & {
    chainRpcs: Record<number, string> | undefined;
  };

  constructor(config?: RouteEngineConfig) {
    this.config = {
      defaultSlippage: config?.defaultSlippage ?? 0.5,
      usdcPriorityThreshold: config?.usdcPriorityThreshold ?? 0.5,
      chainRpcs: config?.chainRpcs,
    };
  }

  // ── Executor Registration ──────────────────────────────────────────

  /**
   * Register an EVM route executor for route execution.
   */
  setExecutor(executor: EVMRouteExecutor): void {
    this.executor = executor;
  }

  // ── Provider Registration ──────────────────────────────────────────

  /**
   * Register a swap provider.
   */
  registerSwapProvider(provider: SwapProvider): void {
    this.swapProviders.set(provider.name, provider);
  }

  /**
   * Register a bridge provider.
   */
  registerBridgeProvider(provider: BridgeProvider): void {
    this.bridgeProviders.set(provider.name, provider);
  }

  /**
   * Get a registered swap provider by name.
   */
  getSwapProvider(name: string): SwapProvider | undefined {
    return this.swapProviders.get(name);
  }

  /**
   * Get a registered bridge provider by name.
   */
  getBridgeProvider(name: string): BridgeProvider | undefined {
    return this.bridgeProviders.get(name);
  }

  /**
   * List all registered swap providers.
   */
  listSwapProviders(): SwapProvider[] {
    return Array.from(this.swapProviders.values());
  }

  /**
   * List all registered bridge providers.
   */
  listBridgeProviders(): BridgeProvider[] {
    return Array.from(this.bridgeProviders.values());
  }

  // ── Quote Discovery ───────────────────────────────────────────────

  /**
   * Collect quotes from all registered providers and return the best
   * route based on total cost (gas + fees).
   *
   * For same-chain swaps, only swap providers are queried.
   * For cross-chain routes, both swap and bridge providers are queried.
   */
  async getBestRoute(params: {
    inputToken: Token;
    outputToken: Token;
    amount: bigint;
    fromChain: { chainId: number };
    toChain: { chainId: number };
  }): Promise<Route | null> {
    const quotes: RouteQuote[] = [];

    // Collect swap provider quotes
    const swapQuotes = await this.collectSwapQuotes(params);
    quotes.push(...swapQuotes);

    // For cross-chain routes, also collect bridge provider quotes
    if (params.fromChain.chainId !== params.toChain.chainId) {
      const bridgeQuotes = await this.collectBridgeQuotes(params);
      quotes.push(...bridgeQuotes);
    }

    if (quotes.length === 0) {
      return null;
    }

    // Find the cheapest quote
    const bestQuote = quotes.reduce((best, q) =>
      q.totalCost < best.totalCost ? q : best,
    );

    return this.buildRouteFromQuote(params, bestQuote);
  }

  /**
   * Get the best route with USDC priority logic.
   *
   * 1. Look for USDC paths first (same-chain transfer or bridge)
   * 2. If USDC slippage > threshold, also compute USDT paths
   * 3. Compare total costs and return cheapest
   */
  async getBestRouteWithUSDCPriority(params: {
    inputToken: Token;
    outputToken: Token;
    amount: bigint;
    fromChain: { chainId: number };
    toChain: { chainId: number };
  }): Promise<Route | null> {
    const usdcToken: Token = this.buildUSDCToken(params.fromChain.chainId);
    const usdtToken: Token = this.buildUSDTToken(params.fromChain.chainId);

    // Step 1: Compute USDC path
    const usdcRoute = await this.getBestRoute({
      ...params,
      outputToken: usdcToken,
    });

    if (!usdcRoute) {
      // Fall back to direct path if USDC not available
      return this.getBestRoute(params);
    }

    // Step 2: If USDC slippage > threshold, also compute USDT path
    if (usdcRoute.slippage > this.config.usdcPriorityThreshold) {
      const usdtRoute = await this.getBestRoute({
        ...params,
        outputToken: usdtToken,
      });

      if (usdtRoute && usdtRoute.totalCost < usdcRoute.totalCost) {
        return usdtRoute;
      }
    }

    return usdcRoute;
  }

  // ── Route Execution ───────────────────────────────────────────────

  /**
   * Execute a given route using the registered executor.
   */
  async executeRoute(route: Route): Promise<{ txHash: string }> {
    if (!this.executor) {
      throw new RouteEngineError(
        "execution_failed",
        "No executor registered. Call setExecutor() with an EVMRouteExecutor first.",
      );
    }

    return this.executor.executeRoute(route);
  }

  /**
   * Get status of a route execution given a transaction hash.
   * Polls the chain for transaction receipt via RPC.
   *
   * Uses chainRpcs from the config to determine which RPC URL to use.
   * If no RPC URLs are configured, returns a placeholder status.
   */
  async getRouteStatus(
    txHash: string,
    chainId?: number,
  ): Promise<{ status: string; confirmations: number }> {
    const chainRpcs = this.config.chainRpcs;
    if (!chainRpcs || !chainId || !chainRpcs[chainId]) {
      // No RPC configured, return placeholder
      return { status: "pending", confirmations: 0 };
    }

    const rpcUrl = chainRpcs[chainId];
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [txHash],
        }),
      });

      if (!response.ok) {
        return { status: "pending", confirmations: 0 };
      }

      const data = (await response.json()) as {
        result?: {
          status?: string;
          blockNumber?: string;
          transactionHash?: string;
        } | null;
      };

      if (!data.result) {
        return { status: "pending", confirmations: 0 };
      }

      if (data.result.status === "0x0") {
        return { status: "failed", confirmations: 0 };
      }

      // Get current block number to calculate confirmations
      const blockResponse = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "eth_blockNumber",
          params: [],
        }),
      });

      let confirmations = 0;
      if (blockResponse.ok) {
        const blockData = (await blockResponse.json()) as { result?: string };
        if (blockData.result && data.result.blockNumber) {
          const currentBlock = BigInt(blockData.result);
          const txBlock = BigInt(data.result.blockNumber);
          confirmations = Number(currentBlock - txBlock);
          if (confirmations < 0) confirmations = 0;
        }
      }

      return { status: "confirmed", confirmations };
    } catch {
      return { status: "pending", confirmations: 0 };
    }
  }

  // ── Internal Helpers ──────────────────────────────────────────────

  private async collectSwapQuotes(params: {
    inputToken: Token;
    outputToken: Token;
    amount: bigint;
  }): Promise<RouteQuote[]> {
    const results = await Promise.allSettled(
      Array.from(this.swapProviders.values()).map((provider) =>
        provider.estimate({
          amount: params.amount,
          fromToken: params.inputToken,
          toToken: params.outputToken,
        }),
      ),
    );

    const quotes: RouteQuote[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        quotes.push(result.value);
      }
    }

    return quotes;
  }

  private async collectBridgeQuotes(params: {
    inputToken: Token;
    outputToken: Token;
    amount: bigint;
    fromChain: { chainId: number };
    toChain: { chainId: number };
  }): Promise<RouteQuote[]> {
    const results = await Promise.allSettled(
      Array.from(this.bridgeProviders.values()).map((provider) =>
        provider.estimate({
          amount: params.amount,
          fromChain: params.fromChain,
          toChain: params.toChain,
          fromToken: params.inputToken,
          toToken: params.outputToken,
        }),
      ),
    );

    const quotes: RouteQuote[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        quotes.push(result.value);
      }
    }

    return quotes;
  }

  private buildRouteFromQuote(
    params: {
      inputToken: Token;
      outputToken: Token;
      amount: bigint;
      fromChain: { chainId: number };
      toChain: { chainId: number };
    },
    quote: RouteQuote,
  ): Route {
    // Estimate output amount based on quote cost
    // For same-chain swaps: output ≈ input - cost
    // For bridges: output ≈ input - bridge fee
    const adjustedOutput =
      params.amount > quote.totalCost ? params.amount - quote.totalCost : 0n;

    const fromName =
      CHAINS[params.fromChain.chainId]?.name ??
      `Chain ${params.fromChain.chainId}`;
    const toName =
      CHAINS[params.toChain.chainId]?.name ?? `Chain ${params.toChain.chainId}`;

    return {
      fromChain: {
        chainId: params.fromChain.chainId,
        name: fromName,
      },
      toChain: {
        chainId: params.toChain.chainId,
        name: toName,
      },
      inputToken: params.inputToken,
      outputToken: params.outputToken,
      inputAmount: params.amount,
      outputAmount: adjustedOutput,
      steps: quote.steps,
      totalCost: quote.totalCost,
      slippage: quote.slippage,
    };
  }

  private buildUSDCToken(chainId: number): Token {
    const info = CHAINS[chainId];
    if (!info?.usdcAddress) {
      throw new RouteEngineError(
        "no_routes_available",
        `USDC not available on chain ${chainId}`,
      );
    }

    return {
      chainId,
      address: info.usdcAddress,
      decimals: info.usdcDecimals ?? 6,
      symbol: "USDC",
    };
  }

  private buildUSDTToken(chainId: number): Token {
    const info = CHAINS[chainId];
    if (!info?.usdtAddress) {
      throw new RouteEngineError(
        "no_routes_available",
        `USDT not available on chain ${chainId}`,
      );
    }

    return {
      chainId,
      address: info.usdtAddress,
      decimals: info.usdtDecimals ?? 6,
      symbol: "USDT",
    };
  }
}
