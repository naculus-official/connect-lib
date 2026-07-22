/**
 * SimulationProvider — Abstract interface for simulation backends.
 *
 * All simulation providers (eth_call, Blowfish, Tenderly) implement
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
   * @param options - Optional rpcUrl override, origin (dApp URL)
   */
  simulate(
    tx: TransactionDescriptor,
    from: `0x${string}`,
    options?: {
      origin?: string;
      rpcUrl?: string;
    },
  ): Promise<SimulationResult>;

  /**
   * Check whether this provider is available for the given chain.
   */
  isAvailable(chainId: number): boolean;
}
