/**
 * Chain Abstraction — Cross-Chain Intent Routing
 *
 * Provides a unified interface for cross-chain token transfers and route
 * discovery across multiple bridge providers (LiFi, Axelar, etc.).
 *
 * @see docs/features/chain-abstraction.md
 */

// ─── Bridge Providers ──────────────────────────────────────────────────
export { AxelarProvider, LiFiProvider } from "./providers";
export type { AxelarProviderConfig } from "./providers/AxelarProvider";
export type { LiFiProviderConfig } from "./providers/LiFiProvider";
// ─── Route Engine ──────────────────────────────────────────────────────
export { createRouteEngine, RouteEngine } from "./route-engine";
// ─── Types ─────────────────────────────────────────────────────────────
export type {
  BridgeProvider,
  BridgeProviderId,
  ChainAbstractionConfig,
  ChainAbstractionErrorCode,
  CostComparison,
  CostComparisonOperation,
  CostComparisonOptions,
  ExecuteOptions,
  ExecuteRouteResult,
  GasEstimate,
  ProviderTransaction,
  Quote,
  QuoteOptions,
  QuoteSortBy,
  Route,
  RouteStatus,
  RouteStatusValue,
  RouteStep,
} from "./types";
export { ChainAbstractionError, isChainAbstractionError } from "./types";
