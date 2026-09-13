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

export type SimulationProviderName = "eth_call" | "tenderly" | "auto";

// ── Core Result ───────────────────────────────────────────────────

export type SimulationStatus = "success" | "reverted" | "unavailable";

/**
 * What a provider actually examined.
 *
 * Without this, an empty `balanceChanges` means two incompatible things: the
 * provider looked and the transaction moves no tokens, or the provider cannot
 * look at all. A UI cannot tell them apart, and renders the second as the
 * first — "no balance changes" beside a Sign button reads as reassurance when
 * it means nothing was inspected.
 *
 * The built-in `eth_call` provider reports false for all three: executing a
 * call tells you whether it reverts, not what moved. Populating them needs
 * state-diff tracing or a third-party service.
 */
export interface SimulationCoverage {
  /** Token movement was examined. */
  balanceChanges: boolean;
  /** Approval grants were examined. */
  approvalChanges: boolean;
  /** A risk judgement was produced, rather than defaulted to "unknown". */
  risk: boolean;
}

export interface SimulationResult {
  /** Whether the simulation completed, reverted, or was unavailable */
  status: SimulationStatus;
  /** Revert reason (when status === "reverted") */
  revertReason?: string;
  /**
   * Predicted balance changes.
   *
   * Empty does not mean "none" unless `coverage.balanceChanges` is true. Check
   * coverage before presenting this as a finding.
   */
  balanceChanges: BalanceChange[];
  /**
   * Predicted approval changes.
   *
   * Same contract as `balanceChanges`: check `coverage.approvalChanges`.
   */
  approvalChanges: ApprovalChange[];
  /**
   * What the provider examined.
   *
   * Optional so existing providers keep compiling; absent should be read as
   * "unknown coverage", which a UI must treat as conservatively as false.
   */
  coverage?: SimulationCoverage;
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
  /**
   * Token precision, or undefined when it could not be determined.
   *
   * Not narrowed to `number`. A caller that cannot tell "unknown" from a real
   * value has no choice but to guess one, and guessing 18 for a 6-decimal
   * token understates an amount by a factor of a trillion. The core copy of
   * this type already admitted undefined; this one did not, so the same value
   * was optional on one side of the workspace and guaranteed on the other.
   */
  tokenDecimals: number | undefined;
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
  /** Default provider to use (default: "auto") */
  defaultProvider?: SimulationProviderName;
  /** Whether simulation is enabled globally (default: true) */
  enabled?: boolean;
  /** Custom RPC URL for eth_call provider */
  rpcUrl?: string;
  /** Whether to auto-simulate before each sendTransaction (default: false) */
  autoSimulate?: boolean;
}
