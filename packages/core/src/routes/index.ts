/**
 * Routes — Cross-Chain Routing Engine
 *
 * Provider-agnostic swap and bridge providers with cost comparison,
 * USDC priority logic, and EVM route execution.
 */

export { isRouteEngineError, RouteEngineError } from "./errors";
export type { ViemWalletClient } from "./executor/EVMRouteExecutor";
// ─── Executor ──────────────────────────────────────────────────────────
export { EVMRouteExecutor } from "./executor/EVMRouteExecutor";
export type { AxelarBridgeProviderConfig } from "./providers/AxelarBridgeProvider";
export { AxelarBridgeProvider } from "./providers/AxelarBridgeProvider";
export type { LiFISwapProviderConfig } from "./providers/LiFISwapProvider";
// ─── Providers ─────────────────────────────────────────────────────────
export { LiFISwapProvider } from "./providers/LiFISwapProvider";
// ─── Route Engine ──────────────────────────────────────────────────────
export { RouteEngine } from "./RouteEngine";
// ─── Types ─────────────────────────────────────────────────────────────
export type {
  BridgeProvider,
  ChainInfo,
  Route,
  RouteEngineConfig,
  RouteErrorCode,
  RouteQuote,
  RouteStep,
  SwapProvider,
  Token,
} from "./types";
