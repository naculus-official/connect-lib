/**
 * RouteEngine Types
 *
 * Core type definitions for the cross-chain routing engine with
 * provider-agnostic swap and bridge providers.
 *
 * @see docs/features/routes.md
 */

// ─── Token & Chain ─────────────────────────────────────────────────────

export interface Token {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
}

export interface ChainInfo {
  chainId: number;
  name: string;
}

// ─── Route Step ────────────────────────────────────────────────────────

export interface RouteStep {
  type: "swap" | "bridge" | "transfer";
  fromToken: Token;
  toToken: Token;
  amount: bigint;
  estimatedGas: bigint;
  description: string;
}

// ─── Route Quote ──────────────────────────────────────────────────────

export interface RouteQuote {
  totalCost: bigint; // total cost in gas token wei
  estimatedTimeMs: number; // estimated time in ms
  slippage: number; // slippage percentage (0-100)
  steps: RouteStep[];
  provider: string;
}

// ─── Route ────────────────────────────────────────────────────────────

export interface Route {
  fromChain: ChainInfo;
  toChain: ChainInfo;
  inputToken: Token;
  outputToken: Token;
  inputAmount: bigint;
  outputAmount: bigint;
  steps: RouteStep[];
  totalCost: bigint;
  slippage: number;
}

// ─── Provider Interfaces ─────────────────────────────────────────────

export interface SwapProvider {
  name: string;
  estimate(params: {
    amount: bigint;
    fromToken: Token;
    toToken: Token;
  }): Promise<RouteQuote>;
  execute(route: Route): Promise<{ txHash: string }>;
}

export interface BridgeProvider {
  name: string;
  estimate(params: {
    amount: bigint;
    fromChain: { chainId: number };
    toChain: { chainId: number };
    fromToken: Token;
    toToken: Token;
  }): Promise<RouteQuote>;
  execute(route: Route): Promise<{ txHash: string }>;
}

// ─── RouteEngine Config ────────────────────────────────────────────────

export interface RouteEngineConfig {
  /** Default slippage tolerance in percent (default 0.5) */
  defaultSlippage?: number;
  /** USDC priority threshold — if slippage > this, also check USDT (default 0.5) */
  usdcPriorityThreshold?: number;
  /** Optional RPC URL map: chainId → RPC URL */
  chainRpcs?: Record<number, string>;
}

// ─── RouteEngine Errors (re-exported from errors.ts for backward compat) ──

export {
  isRouteEngineError,
  RouteEngineError,
  type RouteErrorCode,
} from "./errors";
