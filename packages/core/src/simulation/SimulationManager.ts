/**
 * SimulationManager — Central orchestrator for transaction simulation.
 *
 * Dispatches simulation requests to the appropriate provider based on
 * configuration and chain support. Handles:
 * - Provider selection (auto / eth_call)
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
  private _autoSimulate: boolean;

  constructor(config?: SimulationConfig) {
    this._enabled = config?.enabled ?? true;
    this._defaultProvider = config?.defaultProvider ?? "auto";
    this._autoSimulate = config?.autoSimulate ?? false;

    // Always register eth_call provider
    this.providers.set("eth_call", new EthCallProvider(config?.rpcUrl));
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Main simulation entry point.
   *
   * Routes to the best available provider based on config and chain support.
   * Falls back to eth_call when no other provider supports the chain.
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
        coverage: {
          balanceChanges: false,
          approvalChanges: false,
          risk: false,
        },
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
        coverage: {
          balanceChanges: false,
          approvalChanges: false,
          risk: false,
        },
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
      chainId,
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

  /** Accept a wallet-engine TransactionRequest without changing its call site. */
  async simulateTransaction(
    tx: {
      to: string;
      data?: string;
      value?: string;
      gas?: string;
      from?: string;
    },
    from: `0x${string}`,
    options?: { chainId?: number; origin?: string; rpcUrl?: string },
  ): Promise<SimulationResult> {
    return this.simulate(
      {
        to: tx.to as `0x${string}`,
        data: (tx.data ?? "0x") as `0x${string}`,
        value: tx.value ?? "0x0",
        gas: tx.gas,
        from: tx.from as `0x${string}` | undefined,
      },
      from,
      options,
    );
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
    token: TokenConfig | `0x${string}`,
    from: `0x${string}`,
    to: `0x${string}`,
    amount: string,
    chainId: number,
    decimals?: number,
    rpcUrl?: string,
  ): Promise<SimulationResult> {
    try {
      const tokenConfig: TokenConfig =
        typeof token === "string"
          ? { address: token, chainId, decimals }
          : token;
      const endpoint =
        rpcUrl ??
        (this.providers.get("eth_call") as EthCallProvider | undefined)?.rpcUrl;
      // The wallet-engine address form historically requires an explicit or
      // configured endpoint for decimals. Do not silently use a public default.
      if (typeof token === "string" && decimals === undefined && !endpoint) {
        throw new Error("No RPC URL available for ERC-20 decimals lookup");
      }
      const precision =
        decimals ??
        tokenConfig.decimals ??
        (await ERC20TokenHelper.getDecimals(
          tokenConfig,
          endpoint ? { rpcUrl: endpoint } : undefined,
        ));
      const tx = await ERC20TokenHelper.buildTransferTx(
        { token: tokenConfig, from, to, amount },
        precision,
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
        { chainId, rpcUrl },
      );
    } catch (err) {
      return {
        status: "unavailable",
        coverage: {
          balanceChanges: false,
          approvalChanges: false,
          risk: false,
        },
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

  setAutoSimulate(value: boolean): void {
    this._autoSimulate = value;
  }

  get autoSimulate(): boolean {
    return this._autoSimulate;
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
   * - "auto": Use the best registered provider for the chain,
   *           fall back to eth_call
   * - "eth_call": Always available on EVM
   */
  private _selectProvider(chainId: number): SimulationProvider | undefined {
    if (this._defaultProvider !== "auto") {
      const specific = this.providers.get(this._defaultProvider);
      if (specific?.isAvailable(chainId)) return specific;
    }

    // "auto": use a registered provider that supports this chain, otherwise
    // eth_call. Consumers can registerProvider() their own; the only built-in
    // one is eth_call, which needs no third-party account and no per-request
    // fee.
    for (const [name, provider] of this.providers) {
      if (name !== "eth_call" && provider.isAvailable(chainId)) return provider;
    }

    const ethCall = this.providers.get("eth_call");
    return ethCall?.isAvailable(chainId) ? ethCall : undefined;
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
