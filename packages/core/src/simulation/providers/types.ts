/**
 * SimulationProvider — Abstract interface for simulation backends.
 *
 * All simulation providers implement
 * this interface so they can be swapped transparently by SimulationManager.
 *
 * @see /docs/features/transaction-simulation.md §6.4
 */

import type {
  SimulationProviderName,
  SimulationResult,
  TransactionDescriptor,
} from "../types";

export interface SimulationProvider {
  /** Human-readable provider name */
  readonly name: SimulationProviderName;

  /** Chain IDs this provider supports (empty = all EVM) */
  readonly supportedChains: number[];

  /**
   * Simulate a transaction and return the result.
   *
   * @param tx - The transaction to simulate
   * @param from - The sender address
   * @param options.chainId - The chain the transaction targets. A provider
   *   backed by a per-chain API needs it, and it must not be inferred from
   *   the dApp origin: the origin identifies the site, not the network, and a
   *   dApp serving several chains from one URL would be mis-simulated.
   * @param options.origin - dApp URL, for phishing detection
   * @param options.rpcUrl - override for the eth_call provider
   */
  simulate(
    tx: TransactionDescriptor,
    from: `0x${string}`,
    options?: {
      chainId?: number;
      origin?: string;
      rpcUrl?: string;
    },
  ): Promise<SimulationResult>;

  /**
   * Check whether this provider is available for the given chain.
   */
  isAvailable(chainId: number): boolean;
}
