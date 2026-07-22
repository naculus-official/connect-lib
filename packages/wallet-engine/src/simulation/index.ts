/**
 * Simulation Module — wallet-engine Transaction Simulation (P0)
 *
 * Provides simulation infrastructure for previewing transaction outcomes
 * before signing/submission. Self-contained within wallet-engine with
 * zero external dependencies.
 *
 * @see /docs/features/transaction-simulation.md
 */

export { EthCallProvider } from "./providers/eth-call";
export type { SimulationProvider } from "./providers/types";
export { SimulationManager } from "./SimulationManager";

export type {
  ApprovalChange,
  BalanceChange,
  GasInfo,
  RiskAssessment,
  RiskLevel,
  RiskWarning,
  RiskWarningCategory,
  RiskWarningSeverity,
  SimulationConfig,
  SimulationProviderName,
  SimulationResult,
  SimulationStatus,
  TransactionDescriptor,
} from "./types";
