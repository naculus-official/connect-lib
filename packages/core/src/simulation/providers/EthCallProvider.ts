/**
 * EthCallProvider — Basic simulation using the eth_call RPC method.
 *
 * Provides Layer 1 (P0) simulation: checks for revert, returns revert
 * reason if the transaction would fail. Cannot resolve balance changes,
 * approval changes, or risk scores since eth_call only returns the
 * function output, not state diffs.
 *
 * Uses raw fetch to call JSON-RPC (no ethers/viem dependency).
 *
 * @see /docs/features/transaction-simulation.md §5.1
 */

import type {
  SimulationProviderName,
  SimulationResult,
  TransactionDescriptor,
} from "../types";
import type { SimulationProvider } from "./types";

// ── Constants ─────────────────────────────────────────────────────

const NATIVE_ASSET = {
  address: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  symbol: "ETH",
  decimals: 18,
};

const ETH_NATIVE_CHAINS = [1, 5, 11155111, 10, 42161, 421614, 8453, 84532];
const MATIC_NATIVE_CHAINS = [137, 80002];
const BNB_NATIVE_CHAINS = [56, 97];

// ── Helper: Parse revert reason from error data ───────────────────

/**
 * Attempt to extract a human-readable revert reason from eth_call error data.
 *
 * Solidity errors follow: Error(string) → 4 byte selector + offset(32B) + length(32B) + data
 * Panic follows: Panic(uint256) → 4 byte selector + code(32B)
 */
function parseRevertReason(errorData: string): string | undefined {
  const clean = errorData.startsWith("0x") ? errorData.slice(2) : errorData;

  // Check for Error(string) selector: 08c379a0
  if (clean.length >= 10 && clean.startsWith("08c379a0")) {
    try {
      const dataHex = clean.slice(8);
      // ABI-encoded Error(string): offset(32B), length(32B), data
      const lengthHex = dataHex.slice(64, 128);
      const length = parseInt(lengthHex, 16);
      if (length > 0 && length * 2 <= dataHex.length - 128) {
        const msgHex = dataHex.slice(128, 128 + length * 2);
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
          bytes[i] = parseInt(msgHex.slice(i * 2, i * 2 + 2), 16);
        }
        return new TextDecoder().decode(bytes);
      }
    } catch {
      // Fall through to raw hex
    }
  }

  // Check for Panic(uint256) selector: 4e487b71
  if (clean.length >= 10 && clean.startsWith("4e487b71")) {
    const codeHex = clean.slice(8, 72);
    const code = BigInt(`0x${codeHex}`);
    const panicMessages: Record<string, string> = {
      "0": "Generic panic",
      "1": "Assert failed",
      "17": "Arithmetic overflow/underflow",
      "18": "Division by zero",
      "33": "Enum conversion out of bounds",
      "34": "Storage array access out of bounds",
      "49": "pop() on empty array",
      "50": "Index out of bounds",
      "65": "Allocate too much memory",
      "81": "Call to non-existent function",
    };
    return panicMessages[code.toString()] ?? `Panic code ${code}`;
  }

  // Raw hex (no known selector)
  if (clean.length > 0) return clean;

  return undefined;
}

/**
 * Determine the native gas token symbol for a given chain.
 */
function getNativeSymbol(chainId: number): string {
  if (ETH_NATIVE_CHAINS.includes(chainId)) return "ETH";
  if (MATIC_NATIVE_CHAINS.includes(chainId)) return "MATIC";
  if (BNB_NATIVE_CHAINS.includes(chainId)) return "BNB";
  return "ETH";
}

/**
 * Build a basic safe SimulationResult when eth_call does not revert.
 */
function buildSuccessResult(
  providerName: SimulationProviderName,
  from: `0x${string}`,
  chainId: number,
): SimulationResult {
  const nativeSymbol = getNativeSymbol(chainId);
  return {
    status: "success",
    balanceChanges: [],
    approvalChanges: [],
    riskAssessment: {
      level: "unknown",
      score: 0,
      warnings: [],
    },
    provider: providerName,
    summary: "Transaction simulation succeeded (basic revert check only)",
    changesDetected: true,
  };
}

/**
 * Build a SimulationResult for a reverted transaction.
 */
function buildRevertedResult(
  revertReason: string | undefined,
  providerName: SimulationProviderName,
): SimulationResult {
  return {
    status: "reverted",
    revertReason,
    balanceChanges: [],
    approvalChanges: [],
    riskAssessment: {
      level: "unknown",
      score: 0,
      warnings: [
        {
          category: "simulation_failed",
          severity: "high",
          message: revertReason
            ? `Transaction would revert: ${revertReason}`
            : "Transaction would revert (no reason provided)",
        },
      ],
    },
    provider: providerName,
    summary: revertReason
      ? `Transaction reverted: ${revertReason}`
      : "Transaction reverted",
    changesDetected: false,
  };
}

// ── EthCallProvider ───────────────────────────────────────────────

export class EthCallProvider implements SimulationProvider {
  readonly name: SimulationProviderName = "eth_call";
  readonly supportedChains: number[] = []; // empty = all EVM chains

  private defaultRpcUrl?: string;

  constructor(defaultRpcUrl?: string) {
    this.defaultRpcUrl = defaultRpcUrl;
  }

  /**
   * Simulate a transaction via eth_call.
   *
   * eth_call returns only the function return data — it does not expose
   * state diffs. Therefore this provider can only determine:
   * - Is the transaction going to revert?
   * - What is the revert reason?
   *
   * It CANNOT resolve balance changes or approval changes.
   */
  async simulate(
    tx: TransactionDescriptor,
    from: `0x${string}`,
    options?: {
      origin?: string;
      rpcUrl?: string;
    },
  ): Promise<SimulationResult> {
    const rpcUrl = options?.rpcUrl ?? this.defaultRpcUrl;
    if (!rpcUrl) {
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
              message: "EthCallProvider: No RPC URL configured",
            },
          ],
        },
        provider: this.name,
        summary: "Simulation unavailable: no RPC URL",
        changesDetected: false,
      };
    }

    const callParams: Record<string, string> = {
      to: tx.to,
      from: from,
      data: tx.data,
      value: tx.value || "0x0",
    };

    if (tx.gas) {
      callParams.gas = tx.gas;
    }

    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "eth_call",
          params: [callParams, "latest"],
        }),
      });

      const json: any = await response.json();

      if (json.error) {
        const revertReason = parseRevertReason(
          json.error.data ?? json.error.message,
        );
        return buildRevertedResult(revertReason, this.name);
      }

      // eth_call succeeded
      return buildSuccessResult(
        this.name,
        from,
        this._extractChainId(options?.rpcUrl ?? this.defaultRpcUrl),
      );
    } catch (err) {
      // Network error or unexpected failure
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
              message: `EthCallProvider: Network error during simulation: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
        },
        provider: this.name,
        summary: "Simulation unavailable due to network error",
        changesDetected: false,
      };
    }
  }

  isAvailable(_chainId: number): boolean {
    return true; // eth_call is available on all EVM chains
  }

  /**
   * Attempt to infer chain ID from the RPC URL (best-effort).
   * Returns 0 if unknown.
   */
  private _extractChainId(rpcUrl?: string): number {
    if (!rpcUrl) return 0;
    // This is intentionally simplistic — chain detection via net_version
    // would add an extra RPC call. We default to 0 since eth_call provider
    // doesn't deeply depend on chain ID.
    return 0;
  }
}
