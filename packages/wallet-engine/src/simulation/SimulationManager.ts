/**
 * SimulationManager — Central orchestrator for transaction simulation
 *                     inside wallet-engine.
 *
 * Dispatches simulation requests to the appropriate provider based on
 * configuration and chain support. Handles:
 * - Provider selection (auto / eth_call)
 * - Graceful fallback when a provider is unavailable
 * - Convenience methods like simulateERC20Transfer
 *
 * Integration points:
 * - PocketWallet.sendTransaction() → pre-send auto simulation
 * - Token helper: builds calldata for ERC-20 transfers
 *
 * @see /docs/features/transaction-simulation.md §6.3
 */

import { EthCallProvider } from "./providers/eth-call";
import type { SimulationProvider } from "./providers/types";
import type {
  RiskAssessment,
  SimulationConfig,
  SimulationProviderName,
  SimulationResult,
  TransactionDescriptor,
} from "./types";

// ── Default Risk Assessment ───────────────────────────────────────

const DEFAULT_UNAVAILABLE_RISK: RiskAssessment = {
  level: "unknown",
  score: 0,
  warnings: [],
};

// ── TransactionRequest to TransactionDescriptor ───────────────────

/**
 * Convert a wallet-engine TransactionRequest to a TransactionDescriptor.
 */
function toTxDescriptor(tx: {
  to: string;
  data?: string;
  value?: string;
  gas?: string;
  from?: string;
}): TransactionDescriptor {
  return {
    to: tx.to as `0x${string}`,
    data: (tx.data ?? "0x") as `0x${string}`,
    value: tx.value ?? "0x0",
    from: tx.from as `0x${string}` | undefined,
    gas: tx.gas,
  };
}

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
   * Falls back to eth_call if the preferred provider is unavailable.
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

    const chainId = options?.chainId ?? 0;
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

    const rpcUrl = options?.rpcUrl;

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
   * Convenience wrapper: simulate a transaction using a raw TransactionRequest.
   */
  async simulateTransaction(
    tx: {
      to: string;
      data?: string;
      value?: string;
      gas?: string;
      from?: string;
    },
    from: `0x${string}`,
    options?: {
      chainId?: number;
      origin?: string;
      rpcUrl?: string;
    },
  ): Promise<SimulationResult> {
    return this.simulate(toTxDescriptor(tx), from, options);
  }

  /**
   * Convenience: simulate an ERC-20 token transfer.
   *
   * Builds the transfer calldata from ERC-20 ABI, then runs simulation.
   *
   * @param tokenAddress - ERC-20 token contract address
   * @param from - Sender
   * @param to - Recipient
   * @param amount - Amount in human-readable units (e.g. "1.50")
   * @param chainId - Chain ID
   */
  async simulateERC20Transfer(
    tokenAddress: `0x${string}`,
    from: `0x${string}`,
    to: `0x${string}`,
    amount: string,
    chainId: number,
    decimals?: number,
  ): Promise<SimulationResult> {
    try {
      // Fetch decimals if not provided
      const tokenDecimals =
        decimals ?? (await this._getERC20Decimals(tokenAddress, chainId));

      // Parse amount to raw units
      const rawAmount = this._parseUnits(amount, tokenDecimals);

      // Build transfer calldata: transfer(address,uint256)
      const selector = await this._getSelector("transfer(address,uint256)");
      const data =
        `${selector}${this._abiEncodeAddress(to)}${this._abiEncodeUint256(rawAmount)}` as `0x${string}`;

      return this.simulate(
        {
          to: tokenAddress,
          data,
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
    return this._selectProvider(chainId) !== undefined;
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

  /**
   * Enable or disable auto-simulation before sendTransaction.
   */
  setAutoSimulate(value: boolean): void {
    this._autoSimulate = value;
  }

  /**
   * Get whether auto-simulation is enabled.
   */
  get autoSimulate(): boolean {
    return this._autoSimulate;
  }

  // ── Provider Management ─────────────────────────────────────────

  /**
   * Register a custom provider.
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

  private _selectProvider(chainId: number): SimulationProvider | undefined {
    // Named provider mode: return the specific provider if registered
    if (this._defaultProvider !== "auto") {
      const specific = this.providers.get(this._defaultProvider);
      if (specific && specific.isAvailable(chainId)) {
        return specific;
      }
    }

    // "auto" mode: check blowfish first (if registered + chain supported), fall back to eth_call
    const blowfish = this.providers.get("blowfish");
    if (blowfish && blowfish.isAvailable(chainId)) {
      return blowfish;
    }

    // Fallback: eth_call is available on all EVM chains
    const ethCall = this.providers.get("eth_call");
    if (ethCall && ethCall.isAvailable(chainId)) {
      return ethCall;
    }

    return undefined;
  }

  // ── ABI Helpers ─────────────────────────────────────────────────

  private async _getSelector(signature: string): Promise<string> {
    const { keccak_256 } = await import("@noble/hashes/sha3");
    const { bytesToHex } = await import("@noble/hashes/utils");
    return `0x${bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8)}`;
  }

  private async _getERC20Decimals(
    tokenAddress: `0x${string}`,
    chainId: number,
    rpcUrl?: string,
  ): Promise<number> {
    const selector = await this._getSelector("decimals()");
    const result = await this._erc20StaticCall(
      tokenAddress,
      selector,
      "",
      chainId,
      rpcUrl,
    );
    return Number(BigInt(result));
  }

  private async _erc20StaticCall(
    to: `0x${string}`,
    selector: string,
    argsHex: string,
    _chainId: number,
    rpcUrl?: string,
  ): Promise<string> {
    // Use the first available eth_call provider's RPC URL, or the default
    const provider = this.providers.get("eth_call") as
      | EthCallProvider
      | undefined;
    const providerRpcUrl = rpcUrl; // caller provides rpcUrl; otherwise we need the provider's URL

    if (!providerRpcUrl) {
      throw new Error("No RPC URL available for ERC-20 decimals lookup");
    }

    const data = selector + argsHex.replace("0x", "");
    const res = await fetch(providerRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
    });
    const json: any = await res.json();
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);
    return json.result as string;
  }

  private _abiEncodeAddress(addr: `0x${string}`): string {
    return addr.toLowerCase().replace("0x", "").padStart(64, "0");
  }

  private _abiEncodeUint256(value: bigint): string {
    return value.toString(16).padStart(64, "0");
  }

  private _parseUnits(amount: string, decimals: number): bigint {
    if (typeof amount !== "string") {
      throw new Error("Amount must be a string");
    }
    const trimmed = amount.trim();
    if (
      !/^[0-9]*\.?[0-9]*$/.test(trimmed) ||
      trimmed === "" ||
      trimmed === "."
    ) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    const parts = trimmed.split(".");
    const integerPart = parts[0].replace(/^0+/, "") || "0";
    let fractionalPart = parts[1] || "";

    if (fractionalPart.length > decimals) {
      throw new Error(
        `Amount has ${fractionalPart.length} decimal places, max is ${decimals}`,
      );
    }
    fractionalPart = fractionalPart.padEnd(decimals, "0");

    return BigInt(integerPart + fractionalPart);
  }
}
