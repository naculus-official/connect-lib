/**
 * Simulation Module — Transaction Simulation (P0)
 *
 * Provides simulation infrastructure for previewing transaction outcomes
 * before signing/submission.
 *
 * @see /docs/features/transaction-simulation.md
 */

export { BlowfishProvider } from "./providers/BlowfishProvider";
export { EthCallProvider } from "./providers/EthCallProvider";
export type { SimulationProvider } from "./providers/types";
export {
  compareSimulationVsActual,
  SimulationManager,
} from "./SimulationManager";

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
