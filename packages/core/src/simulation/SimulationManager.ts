/**
 * SimulationManager — Central orchestrator for transaction simulation.
 *
 * Dispatches simulation requests to the appropriate provider based on
 * configuration and chain support. Handles:
 * - Provider selection (auto / eth_call / blowfish)
 * - Graceful fallback when a provider is unavailable
 * - Convenience methods like simulateERC20Transfer
 *
 * Integration points:
 * - wallet-engine: PocketWallet.simulateTransaction()
 * - Token helper (SRS-007): Builds calldata for ERC-20 transfers
 * - TxMonitor (SRS-008): Compares simulation vs actual results
 *
 * @see /docs/features/transaction-simulation.md §6.3
 */

import { DEFAULT_RPC_URLS } from "../rpc";
import { ERC20TokenHelper } from "../token/ERC20TokenHelper";
import type { TokenConfig } from "../token/types";
import { BlowfishProvider } from "./providers/BlowfishProvider";
import { EthCallProvider } from "./providers/EthCallProvider";
import type { SimulationProvider } from "./providers/types";
import type {
  ApprovalChange,
  BalanceChange,
  GasInfo,
  RiskAssessment,
  SimulationConfig,
  SimulationProviderName,
  SimulationResult,
  TransactionDescriptor,
} from "./types";

// ── Default Risk Assessment for Unavailable State ─────────────────

const DEFAULT_UNAVAILABLE_RISK: RiskAssessment = {
  level: "unknown",
  score: 0,
  warnings: [],
};

// ── SimulationManager ─────────────────────────────────────────────

export class SimulationManager {
  private providers: Map<SimulationProviderName, SimulationProvider> =
    new Map();
  private _defaultProvider: SimulationProviderName;
  private _enabled: boolean;
  private blowfishApiKey?: string;

  constructor(config?: SimulationConfig) {
    this._enabled = config?.enabled ?? true;
    this._defaultProvider = config?.defaultProvider ?? "auto";
    this.blowfishApiKey = config?.blowfishApiKey;

    // Always register eth_call provider
    this.providers.set("eth_call", new EthCallProvider(config?.rpcUrl));

    // Register Blowfish if API key is provided
    if (this.blowfishApiKey) {
      this.providers.set("blowfish", new BlowfishProvider(this.blowfishApiKey));
    }
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Main simulation entry point.
   *
   * Routes to the best available provider based on config and chain support.
   * Falls back to eth_call if Blowfish is unavailable for the chain.
   *
   * @param tx - Transaction to simulate
   * @param from - Sender address
   * @param options - Optional chainId, rpcUrl, origin
   */
  async simulate(
    tx: TransactionDescriptor,
    from: `0x${string}`,
    options?: {
      chainId?: number;
      origin?: string;
      rpcUrl?: string;
    },
  ): Promise<SimulationResult> {
    if (!this._enabled) {
      return {
        status: "unavailable",
        balanceChanges: [],
        approvalChanges: [],
        riskAssessment: { ...DEFAULT_UNAVAILABLE_RISK },
        provider: "auto",
        summary: "Simulation is disabled",
        changesDetected: false,
      };
    }

    const chainId = options?.chainId ?? this._estimateChainId(from);
    const provider = this._selectProvider(chainId);

    if (!provider) {
      return {
        status: "unavailable",
        balanceChanges: [],
        approvalChanges: [],
        riskAssessment: {
          ...DEFAULT_UNAVAILABLE_RISK,
          warnings: [
            {
              category: "simulation_failed",
              severity: "low",
              message: "No simulation provider available for this chain",
            },
          ],
        },
        provider: "auto",
        summary: "No simulation provider available",
        changesDetected: false,
      };
    }

    const rpcUrl = options?.rpcUrl ?? this._resolveRpcUrl(chainId);

    // Try primary provider
    const result = await provider.simulate(tx, from, {
      origin: options?.origin,
      rpcUrl,
    });

    // If primary provider is unavailable and we have a fallback, retry
    if (result.status === "unavailable" && provider.name !== "eth_call") {
      const fallback = this.providers.get("eth_call");
      if (fallback) {
        const fallbackResult = await fallback.simulate(tx, from, { rpcUrl });
        return {
          ...fallbackResult,
          // Preserve the unavailable warnings from the primary provider
          riskAssessment: {
            ...fallbackResult.riskAssessment,
            warnings: [
              ...result.riskAssessment.warnings,
              ...fallbackResult.riskAssessment.warnings,
            ],
          },
        };
      }
    }

    return result;
  }

  /**
   * Convenience: simulate an ERC-20 token transfer.
   *
   * Builds the transfer calldata using ERC20TokenHelper (SRS-007),
   * then runs the simulation.
   *
   * @param token - Token to transfer
   * @param from - Sender address
   * @param to - Recipient address
   * @param amount - Amount in human-readable units (e.g. "1.50")
   * @param chainId - Chain ID
   */
  async simulateERC20Transfer(
    token: TokenConfig,
    from: `0x${string}`,
    to: `0x${string}`,
    amount: string,
    chainId: number,
  ): Promise<SimulationResult> {
    try {
      // Build transfer calldata using ERC20TokenHelper
      const decimals =
        token.decimals ?? (await ERC20TokenHelper.getDecimals(token));
      const tx = await ERC20TokenHelper.buildTransferTx(
        { token, from, to, amount },
        decimals,
      );

      // Simulate the transfer
      return this.simulate(
        {
          to: tx.to,
          data: tx.data,
          value: "0x0",
          from,
        },
        from,
        { chainId },
      );
    } catch (err) {
      return {
        status: "unavailable",
        balanceChanges: [],
        approvalChanges: [],
        riskAssessment: {
          ...DEFAULT_UNAVAILABLE_RISK,
          warnings: [
            {
              category: "simulation_failed",
              severity: "low",
              message: `Failed to build transfer calldata: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        },
        provider: "auto",
        summary: "Failed to prepare simulation",
        changesDetected: false,
      };
    }
  }

  /**
   * Check whether simulation is available for a given chain.
   */
  isAvailable(chainId: number): boolean {
    if (!this._enabled) return false;
    const provider = this._selectProvider(chainId);
    return provider !== undefined;
  }

  /**
   * Enable or disable simulation globally.
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /**
   * Get whether simulation is currently enabled.
   */
  get enabled(): boolean {
    return this._enabled;
  }

  // ── Provider Management ─────────────────────────────────────────

  /**
   * Register a custom provider.
   * Useful for testing or third-party providers.
   */
  registerProvider(
    name: SimulationProviderName,
    provider: SimulationProvider,
  ): void {
    this.providers.set(name, provider);
  }

  /**
   * Add or update a Blowfish API key at runtime.
   */
  setBlowfishApiKey(apiKey: string): void {
    this.blowfishApiKey = apiKey;
    this.providers.set("blowfish", new BlowfishProvider(apiKey));
  }

  /**
   * Remove a registered provider.
   */
  unregisterProvider(name: SimulationProviderName): void {
    this.providers.delete(name);
  }

  // ── Internal: Provider Selection ────────────────────────────────

  /**
   * Select the best provider for the given chain.
   *
   * Selection rules:
   * - "auto": Try blowfish first (if registered + chain supported),
   *           fall back to eth_call
   * - "blowfish": Use blowfish if available
   * - "eth_call": Always available on EVM
   */
  private _selectProvider(chainId: number): SimulationProvider | undefined {
    if (this._defaultProvider === "eth_call") {
      return this.providers.get("eth_call");
    }

    if (this._defaultProvider === "blowfish") {
      return this.providers.get("blowfish");
    }

    // "auto" mode: prefer Blowfish, fall back to eth_call
    const blowfish = this.providers.get("blowfish");
    if (blowfish && blowfish.isAvailable(chainId)) {
      return blowfish;
    }

    return this.providers.get("eth_call");
  }

  /**
   * Estimate chain ID from the from address or config.
   * Best-effort; returns 0 if unknown.
   */
  private _estimateChainId(_from: `0x${string}`): number {
    // In a full implementation, this would check the session manager
    // or chain registry. For now, return 0 to match "all chains".
    return 0;
  }

  /**
   * Resolve an RPC URL for the eth_call fallback provider.
   */
  private _resolveRpcUrl(chainId: number): string | undefined {
    if (chainId > 0) {
      return DEFAULT_RPC_URLS[`eip155:${chainId}`];
    }
    return undefined;
  }
}

// ── Simulation vs Actual Comparison (SRS-008 Integration) ─────────

/**
 * Compare simulation results with actual transaction receipt.
 *
 * Used by TxMonitor to detect discrepancies between simulated and
 * actual transaction outcomes.
 *
 * @param simulation - The simulation result
 * @param actualStatus - Actual tx receipt status ("success" | "reverted")
 * @returns Match result
 */
export function compareSimulationVsActual(
  simulation: SimulationResult,
  actualStatus: "success" | "reverted",
): { match: boolean; discrepancies?: string[] } {
  const discrepancies: string[] = [];

  if (simulation.status === "success" && actualStatus === "reverted") {
    discrepancies.push("Simulation predicted success but transaction reverted");
  }

  if (simulation.status === "reverted" && actualStatus === "success") {
    discrepancies.push("Simulation predicted revert but transaction succeeded");
  }

  return {
    match: discrepancies.length === 0,
    discrepancies: discrepancies.length > 0 ? discrepancies : undefined,
  };
}
