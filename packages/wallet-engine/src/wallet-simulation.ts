/**
 * Wallet Simulation
 *
 * Standalone simulation functions extracted from wallet.ts.
 * Accepts a context object rather than relying on PocketWallet internals.
 */

import { WalletError } from "./errors";
import type { SimulationManager } from "./simulation/SimulationManager";
import type { SimulationResult } from "./simulation/types";

// ── Types ───────────────────────────────────────────────────────────

export interface WalletSimContext {
  address?: string | null;
  simManager: SimulationManager | null;
  customSimulate?: (
    tx: { to: string; data?: string; value?: string },
    from: string,
    options?: { chainId?: number; origin?: string; rpcUrl?: string },
  ) => Promise<any>;
  rpcUrl?: string;
  chainId: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

export function parseChainIdNumber(chainId: string): number {
  return parseInt(chainId.replace("eip155:", ""), 10);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Simulate a transaction before sending it.
 * Uses the built-in SimulationManager (eth_call) if available,
 * otherwise falls back to an externally provided simulateFn.
 */
export async function simulateTransaction(
  ctx: WalletSimContext,
  tx: { to: string; data?: string; value?: string; gas?: string },
  options?: { chainId?: number; origin?: string; rpcUrl?: string },
): Promise<SimulationResult> {
  if (!ctx.address) throw new WalletError("no_wallet", "No wallet loaded.");
  const from = ctx.address as `0x${string}`;
  const chainId = options?.chainId ?? parseChainIdNumber(ctx.chainId);

  if (ctx.simManager) {
    const result = await ctx.simManager.simulateTransaction(tx, from, {
      ...options,
      chainId,
      rpcUrl: options?.rpcUrl ?? ctx.rpcUrl,
    });
    return { ...result, provider: result.provider };
  }

  if (ctx.customSimulate) {
    return ctx.customSimulate(tx, from, options ?? { chainId });
  }

  throw new WalletError(
    "simulation_unavailable",
    "Simulation is not configured. Provide rpcUrl or a simulateFn in PocketConfig.",
  );
}

/**
 * Simulate an ERC-20 token transfer.
 * Builds transfer calldata automatically and runs simulation.
 * Requires a built-in SimulationManager with rpcUrl configured.
 */
export async function simulateERC20Transfer(
  ctx: WalletSimContext,
  tokenAddress: `0x${string}`,
  to: `0x${string}`,
  amount: string,
  options?: { chainId?: number; rpcUrl?: string; decimals?: number },
): Promise<SimulationResult> {
  if (!ctx.address) throw new WalletError("no_wallet", "No wallet loaded.");
  if (!ctx.simManager) {
    throw new WalletError(
      "simulation_unavailable",
      "SimulationManager not initialized. Provide rpcUrl in PocketConfig.",
    );
  }

  const from = ctx.address as `0x${string}`;
  const chainId = options?.chainId ?? parseChainIdNumber(ctx.chainId);

  const result = await ctx.simManager.simulateERC20Transfer(
    tokenAddress,
    from,
    to,
    amount,
    chainId,
    options?.decimals,
  );

  return { ...result, provider: result.provider };
}
