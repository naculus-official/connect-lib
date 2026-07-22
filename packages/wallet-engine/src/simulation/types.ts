/**
 * Transaction Simulation — Core Type Definitions
 *
 * Defines the shapes for:
 * - SimulationResult: what a simulation yields
 * - BalanceChange / ApprovalChange: predicted state changes
 * - RiskAssessment / RiskWarning: security scoring
 * - GasInfo: fee estimation from simulation
 * - TransactionDescriptor: minimal tx input for simulation
 *
 * These types mirror @naculus/connect-core's simulation types but
 * are defined here to keep wallet-engine dependency-free.
 *
 * @see /docs/features/transaction-simulation.md
 */

// ── Provider ──────────────────────────────────────────────────────

export type SimulationProviderName =
  | "eth_call"
  | "blowfish"
  | "tenderly"
  | "auto";

// ── Core Result ───────────────────────────────────────────────────

export type SimulationStatus = "success" | "reverted" | "unavailable";

export interface SimulationResult {
  /** Whether the simulation completed, reverted, or was unavailable */
  status: SimulationStatus;
  /** Revert reason (when status === "reverted") */
  revertReason?: string;
  /** Predicted balance changes */
  balanceChanges: BalanceChange[];
  /** Predicted approval changes */
  approvalChanges: ApprovalChange[];
  /** Risk assessment */
  riskAssessment: RiskAssessment;
  /** Gas estimation details */
  gasInfo?: GasInfo;
  /** Which provider produced this result */
  provider: SimulationProviderName;
  /** Human-readable summary */
  summary?: string;
  /** Whether any state changes were detected */
  changesDetected: boolean;
  /** Raw provider response (debugging / transparency) */
  raw?: unknown;
}

// ── Balance & Approval Changes ────────────────────────────────────

export interface BalanceChange {
  /** Token contract address (zero address for native gas token) */
  tokenAddress: `0x${string}`;
  /** Token symbol (e.g. "USDC", "ETH") */
  tokenSymbol: string;
  /** Number of decimals */
  tokenDecimals: number;
  /** Raw change amount in smallest unit (stringified bigint) */
  amount: string;
  /** Direction of the balance change */
  direction: "in" | "out";
  /** Source address */
  from: `0x${string}`;
  /** Destination address */
  to: `0x${string}`;
  /** Human-readable representation (e.g. "-1.5 USDC") */
  humanReadable: string;
}

export interface ApprovalChange {
  /** Token contract address */
  tokenAddress: `0x${string}`;
  /** Token symbol */
  tokenSymbol: string;
  /** Owner (usually user) */
  owner: `0x${string}`;
  /** Spender (contract being approved) */
  spender: `0x${string}`;
  /** Approval amount in smallest unit (stringified bigint) */
  amount: string;
  /** Whether this is type(uint256).max */
  isUnlimited: boolean;
  /** Human-readable description */
  humanReadable: string;
}

// ── Risk Assessment ───────────────────────────────────────────────

export type RiskLevel = "safe" | "warning" | "malicious" | "unknown";

export type RiskWarningCategory =
  | "phishing"
  | "unlimited_approval"
  | "high_value"
  | "unknown_contract"
  | "malicious_domain"
  | "simulation_failed"
  | "other";

export type RiskWarningSeverity = "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  /** Aggregated risk level */
  level: RiskLevel;
  /** Numeric score 0–100 (higher = more dangerous) */
  score: number;
  /** Individual warnings */
  warnings: RiskWarning[];
}

export interface RiskWarning {
  /** Classification category */
  category: RiskWarningCategory;
  /** Severity level */
  severity: RiskWarningSeverity;
  /** Human-readable warning message */
  message: string;
}

// ── Gas Info ──────────────────────────────────────────────────────

export interface GasInfo {
  /** Estimated gas limit */
  gasLimit: bigint;
  /** Estimated gas price in wei */
  gasPrice?: bigint;
  /** Predicted total gas fee in ETH (stringified) */
  estimatedFeeEth?: string;
  /** Predicted total gas fee in USD */
  estimatedFeeUsd?: string;
}

// ── Transaction Descriptor for Simulation ─────────────────────────

export interface TransactionDescriptor {
  /** Target contract / recipient address */
  to: `0x${string}`;
  /** Call data (ABI-encoded function call) */
  data: `0x${string}`;
  /** Value in wei (hex string with 0x prefix) */
  value: string;
  /** Sender address */
  from?: `0x${string}`;
  /** Gas limit override (optional) */
  gas?: string;
}

// ── Configuration ─────────────────────────────────────────────────

export interface SimulationConfig {
  /** Blowfish API key (optional; enables Blowfish provider) */
  blowfishApiKey?: string;
  /** Default provider to use (default: "auto") */
  defaultProvider?: SimulationProviderName;
  /** Whether simulation is enabled globally (default: true) */
  enabled?: boolean;
  /** Custom RPC URL for eth_call provider */
  rpcUrl?: string;
  /** Whether to auto-simulate before each sendTransaction (default: false) */
  autoSimulate?: boolean;
}
