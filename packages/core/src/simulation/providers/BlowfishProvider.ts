/**
 * BlowfishProvider — Blowfish API integration for transaction simulation
 *                    and security scanning.
 *
 * This is an **adapter stub** (Layer 2 / P1). When configured with an
 * API key, it provides:
 * - Full balance change detection
 * - Human-readable simulation summaries
 * - Risk scoring (suggestedAction: NONE / WARN / BLOCK)
 * - Phishing detection
 *
 * Implementation notes:
 * - API key is provided by the wallet host (not end-user)
 * - Falls back to basic simulation on rate-limit / 500
 * - Sensitive transaction data is sent to Blowfish servers
 *
 * @see https://docs.blowfish.xyz
 * @see /docs/features/transaction-simulation.md §5.2
 */

import type {
  ApprovalChange,
  BalanceChange,
  GasInfo,
  RiskLevel,
  RiskWarning,
  SimulationProviderName,
  SimulationResult,
  TransactionDescriptor,
} from "../types";
import type { SimulationProvider } from "./types";

// ── Supported EVM chains (per Blowfish docs) ──────────────────────

const SUPPORTED_CHAINS = [1, 137, 42161, 10, 56, 43114, 8453, 250, 25, 324];

const CHAIN_NAMES: Record<number, string> = {
  1: "ethereum",
  137: "polygon",
  42161: "arbitrum",
  10: "optimism",
  56: "bsc",
  43114: "avalanche",
  8453: "base",
  250: "fantom",
  25: "cronos",
  324: "zksync",
};

const BLOWFISH_API_BASE = "https://api.blowfish.xyz";

function getChainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `eip155:${chainId}`;
}

// ── Helper: Map Blowfish suggestedAction to RiskLevel ─────────────

function mapSuggestedAction(action: string | undefined | null): RiskLevel {
  switch (action) {
    case "NONE":
      return "safe";
    case "WARN":
      return "warning";
    case "BLOCK":
      return "malicious";
    default:
      return "unknown";
  }
}

// ── Helper: Build warnings from Blowfish scan results ────────────

function buildWarnings(scanResults: any[] | undefined): RiskWarning[] {
  if (!scanResults || !Array.isArray(scanResults)) return [];

  const warnings: RiskWarning[] = [];

  for (const scan of scanResults) {
    if (scan?.kind === "APPROVAL_TO_EOA") {
      warnings.push({
        category: "phishing",
        severity: "critical",
        message:
          scan.description ?? "Approval to an Externally Owned Account (EOA)",
      });
    }

    if (scan?.kind === "UNLIMITED_ALLOWANCE") {
      warnings.push({
        category: "unlimited_approval",
        severity: "high",
        message: scan.description ?? "Unlimited token approval requested",
      });
    }

    if (scan?.kind === "MALICIOUS_DOMAIN") {
      warnings.push({
        category: "malicious_domain",
        severity: "critical",
        message: scan.description ?? "Suspicious domain detected",
      });
    }

    if (scan?.kind === "KNOWN_MALICIOUS") {
      warnings.push({
        category: "phishing",
        severity: "critical",
        message: scan.description ?? "Known malicious contract detected",
      });
    }

    if (scan?.kind === "SIMULATION_ERROR") {
      warnings.push({
        category: "simulation_failed",
        severity: "medium",
        message: scan.description ?? "Simulation encountered an error",
      });
    }

    if (
      scan?.kind &&
      ![
        "APPROVAL_TO_EOA",
        "UNLIMITED_ALLOWANCE",
        "MALICIOUS_DOMAIN",
        "KNOWN_MALICIOUS",
        "SIMULATION_ERROR",
      ].includes(scan.kind)
    ) {
      warnings.push({
        category: "other",
        severity:
          scan.severity === "CRITICAL"
            ? "critical"
            : scan.severity === "HIGH"
              ? "high"
              : scan.severity === "MEDIUM"
                ? "medium"
                : "low",
        message: scan.description ?? `Unexpected scan result: ${scan.kind}`,
      });
    }
  }

  return warnings;
}

// ── Helper: Parse Blowfish state changes into BalanceChanges ──────

function parseBalanceChanges(changes: any[] | undefined): BalanceChange[] {
  if (!changes || !Array.isArray(changes)) return [];

  const results: BalanceChange[] = [];

  for (const change of changes) {
    if (!change?.contractInfo) continue;

    // Blowfish can return humanReadableDiff like "Send 1.5 USDC"
    // Raw amount info comes in rawInfo or amount fields
    const match = change.humanReadableDiff?.match(
      /^(Send|Receive|Approve|Revoke)\s+(.+?)(?:\s+\(([^)]+)\))?\s*(.+)?$/i,
    );

    let direction: "in" | "out" = "out";
    const humanReadable = change.humanReadableDiff ?? "";
    if (/^Receive/i.test(humanReadable)) {
      direction = "in";
    }

    const rawAmount = change.rawInfo?.amount ?? change.amount ?? "0";

    const tokenSymbol = change.contractInfo.name ?? "";
    const tokenAddress = (change.contractInfo.address ??
      "0x0000000000000000000000000000000000000000") as `0x${string}`;
    const tokenDecimals = change.contractInfo.decimals ?? 18;

    results.push({
      tokenAddress,
      tokenSymbol,
      tokenDecimals,
      amount:
        typeof rawAmount === "bigint"
          ? rawAmount.toString()
          : String(rawAmount),
      direction,
      from: (change.from ??
        "0x0000000000000000000000000000000000000000") as `0x${string}`,
      to: (change.to ??
        "0x0000000000000000000000000000000000000000") as `0x${string}`,
      humanReadable,
    });
  }

  return results;
}

// ── Helper: Parse Approval changes ────────────────────────────────

function parseApprovalChanges(changes: any[] | undefined): ApprovalChange[] {
  if (!changes || !Array.isArray(changes)) return [];

  const results: ApprovalChange[] = [];

  for (const change of changes) {
    if (!change?.humanReadableDiff) continue;

    // Detect approval patterns
    const isApproval = /^Approve/i.test(change.humanReadableDiff);
    if (!isApproval) continue;

    const rawAmount = change.rawInfo?.amount ?? change.amount ?? "0";
    const isUnlimited =
      rawAmount ===
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" ||
      rawAmount ===
        "115792089237316195423570985008687907853269984665640564039457584007913129639935";

    results.push({
      tokenAddress: (change.contractInfo?.address ??
        "0x0000000000000000000000000000000000000000") as `0x${string}`,
      tokenSymbol: change.contractInfo?.name ?? "",
      owner: (change.from ??
        "0x0000000000000000000000000000000000000000") as `0x${string}`,
      spender: (change.to ??
        "0x0000000000000000000000000000000000000000") as `0x${string}`,
      amount: String(rawAmount),
      isUnlimited,
      humanReadable: change.humanReadableDiff,
    });
  }

  return results;
}

// ── Helper: Parse gas info ────────────────────────────────────────

function parseGasInfo(gasInfo: any | undefined): GasInfo | undefined {
  if (!gasInfo) return undefined;

  return {
    gasLimit: gasInfo.gasLimit ? BigInt(gasInfo.gasLimit) : 0n,
    gasPrice: gasInfo.gasPrice ? BigInt(gasInfo.gasPrice) : undefined,
    estimatedFeeEth: gasInfo.estimatedFeeEth,
    estimatedFeeUsd: gasInfo.estimatedFeeUsd,
  };
}

// ── Helper: Build summary from simulation result description ─────

function buildSummary(
  simulationResult: any | undefined,
  balanceChanges: BalanceChange[],
): string {
  if (simulationResult?.description) {
    return simulationResult.description;
  }

  if (balanceChanges.length > 0) {
    const changes = balanceChanges
      .slice(0, 3)
      .map((c) => c.humanReadable)
      .join(", ");
    return changes.length > 0 ? changes : "State changes detected";
  }

  return "No significant state changes detected";
}

// ── BlowfishProvider ──────────────────────────────────────────────

export class BlowfishProvider implements SimulationProvider {
  readonly name: SimulationProviderName = "blowfish";
  readonly supportedChains: number[] = SUPPORTED_CHAINS;

  private apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "BlowfishProvider requires an API key. Get one at https://blowfish.xyz",
      );
    }
    this.apiKey = apiKey;
  }

  async simulate(
    tx: TransactionDescriptor,
    from: `0x${string}`,
    options?: {
      origin?: string;
      rpcUrl?: string;
    },
  ): Promise<SimulationResult> {
    // Note: This is an adapter stub. The actual Blowfish API integration
    // requires a specific API endpoint + request format per version.
    // The structure below follows the documented Blowfish API format.
    //
    // When implementing, replace the fetch call with the actual
    // endpoint and request body from Blowfish docs.

    try {
      const chainName = options?.origin
        ? getChainName(this._inferChainId(options.origin))
        : "ethereum";

      const response = await fetch(
        `${BLOWFISH_API_BASE}/v1/solana/mainnet/transaction/simulate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            transactions: [tx.data],
            userAccount: from,
            metadata: {
              origin: options?.origin ?? "",
            },
          }),
        },
      );

      if (!response.ok) {
        if (response.status === 429) {
          // Rate limited — return unavailable, caller can fall back
          return {
            status: "unavailable",
            balanceChanges: [],
            approvalChanges: [],
            riskAssessment: {
              level: "unknown",
              score: 0,
              warnings: [
                {
                  category: "simulation_failed",
                  severity: "low",
                  message:
                    "Blowfish: Rate limited. Falling back to basic simulation.",
                },
              ],
            },
            provider: this.name,
            summary: "Simulation unavailable (rate limited)",
            changesDetected: false,
          };
        }

        if (response.status >= 500) {
          return {
            status: "unavailable",
            balanceChanges: [],
            approvalChanges: [],
            riskAssessment: {
              level: "unknown",
              score: 0,
              warnings: [
                {
                  category: "simulation_failed",
                  severity: "medium",
                  message: `Blowfish: Server error (${response.status}). Falling back to basic simulation.`,
                },
              ],
            },
            provider: this.name,
            summary: "Simulation unavailable (server error)",
            changesDetected: false,
          };
        }

        return {
          status: "unavailable",
          balanceChanges: [],
          approvalChanges: [],
          riskAssessment: {
            level: "unknown",
            score: 0,
            warnings: [
              {
                category: "simulation_failed",
                severity: "medium",
                message: `Blowfish: HTTP ${response.status}. Falling back.`,
              },
            ],
          },
          provider: this.name,
          summary: "Simulation unavailable",
          changesDetected: false,
        };
      }

      const json: any = await response.json();
      const simResult = json.simulationResult ?? json;

      const balanceChanges = parseBalanceChanges(
        simResult.expectedStateChanges,
      );
      const approvalChanges = parseApprovalChanges(
        simResult.expectedStateChanges,
      );
      const suggestedAction = simResult.suggestedAction ?? "NONE";
      const riskLevel = mapSuggestedAction(suggestedAction);

      const scanResults = simResult.scanResults ?? [];
      const warnings = buildWarnings(scanResults);

      // Compute risk score
      let score = 0;
      if (riskLevel === "warning") score = 40;
      if (riskLevel === "malicious") score = 80;
      for (const w of warnings) {
        if (w.severity === "critical") score += 20;
        else if (w.severity === "high") score += 10;
        else if (w.severity === "medium") score += 5;
      }
      score = Math.min(score, 100);

      return {
        status: simResult.status === "REVERTED" ? "reverted" : "success",
        revertReason: simResult.error?.message,
        balanceChanges,
        approvalChanges,
        riskAssessment: {
          level: riskLevel,
          score,
          warnings,
        },
        gasInfo: parseGasInfo(simResult.gasInfo),
        provider: this.name,
        summary: buildSummary(simResult, balanceChanges),
        changesDetected:
          simResult.status === "CHANGES_DETECTED" || balanceChanges.length > 0,
        raw: simResult,
      };
    } catch (err) {
      return {
        status: "unavailable",
        balanceChanges: [],
        approvalChanges: [],
        riskAssessment: {
          level: "unknown",
          score: 0,
          warnings: [
            {
              category: "simulation_failed",
              severity: "medium",
              message: `Blowfish: Network error: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
        },
        provider: this.name,
        summary: "Simulation unavailable (network error)",
        changesDetected: false,
      };
    }
  }

  isAvailable(chainId: number): boolean {
    return SUPPORTED_CHAINS.includes(chainId);
  }

  /**
   * Best-effort infer chain ID from origin or other context.
   * Defaults to 1 (Ethereum mainnet).
   */
  private _inferChainId(_origin: string): number {
    return 1;
  }
}
