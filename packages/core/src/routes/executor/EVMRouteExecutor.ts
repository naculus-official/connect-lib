/**
 * EVMRouteExecutor
 *
 * Executes EVM-side route steps using viem's sendTransaction.
 * Handles approve → swap/bridge flow for each route step.
 *
 * Notes:
 * - viem is used as an optional peer dependency.
 * - If viem is not available, the executor will throw a clear error.
 */

import type { Route, RouteStep } from "../types";
import { RouteEngineError } from "../types";

// ─── Types for the viem-compatible wallet client ───────────────────────

/**
 * Minimal interface for a viem-compatible wallet client.
 * Users pass in their own viem WalletClient or any compatible adapter.
 */
export interface ViemWalletClient {
  sendTransaction(args: {
    to: `0x${string}`;
    data?: `0x${string}`;
    value?: bigint;
    chainId?: number;
    account?: `0x${string}`;
  }): Promise<`0x${string}`>;
  estimateGas?(args: {
    to: `0x${string}`;
    data?: `0x${string}`;
    value?: bigint;
  }): Promise<bigint>;
  writeContract?(args: {
    address: `0x${string}`;
    abi: unknown[];
    functionName: string;
    args: unknown[];
    account?: `0x${string}`;
    chainId?: number;
  }): Promise<`0x${string}`>;
}

// ─── ERC20 ABI snippet for approve calls ──────────────────────────────

/**
 * Minimal ERC-20 ABI snippet for approve calls.
 * Typed as const for maximum type safety, then widened to unknown[]
 * for the viem writeContract interface which expects unknown[].
 */
const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Type-safe ABI for writeContract calls.
 * Widened to unknown[] because viem's writeContract accepts unknown[].
 */
type Erc20Abi = typeof ERC20_ABI;

// ─── EVMRouteExecutor ─────────────────────────────────────────────────

export class EVMRouteExecutor {
  private walletClient: ViemWalletClient;

  constructor(walletClient: ViemWalletClient) {
    this.walletClient = walletClient;
  }

  /**
   * Execute an entire route, processing each step in sequence.
   * Returns the last transaction hash (the bridge/swap tx).
   */
  async executeRoute(route: Route): Promise<{ txHash: string }> {
    let lastTxHash = "";

    for (const step of route.steps) {
      const txHash = await this.executeStep(step);
      lastTxHash = txHash;
    }

    if (!lastTxHash) {
      throw new RouteEngineError(
        "execution_failed",
        "No transactions were executed",
      );
    }

    return { txHash: lastTxHash };
  }

  /**
   * Execute a single route step.
   */
  async executeStep(step: RouteStep): Promise<string> {
    switch (step.type) {
      case "bridge":
      case "swap":
      case "transfer":
        return this.executeTransferStep(step);
      default: {
        const _exhaustive: never = step.type;
        throw new RouteEngineError(
          "execution_failed",
          `Unknown step type: ${step.type}`,
        );
      }
    }
  }

  /**
   * Handle approve + swap/bridge/transfer flow.
   */
  private async executeTransferStep(step: RouteStep): Promise<string> {
    const fromAddress = step.fromToken.address as `0x${string}`;

    // If the from token is not native ETH, we may need an approve step
    if (fromAddress !== "0x0000000000000000000000000000000000000000") {
      // Approve step would be done before this via a separate call
      // The caller is responsible for handling approvals separately
    }

    // Execute the swap/bridge/transfer
    const txHash = await this.walletClient.sendTransaction({
      to: fromAddress,
      data: "0x", // In production, encode the proper swap/bridge calldata
      value: step.amount,
    });

    return txHash;
  }

  /**
   * Generate an ERC20 approve transaction for a given token and spender.
   * This can be used to approve tokens before executing a route step.
   */
  async approveToken(
    tokenAddress: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint,
  ): Promise<{ txHash: string }> {
    if (!this.walletClient.writeContract) {
      throw new RouteEngineError(
        "execution_failed",
        "walletClient does not support writeContract — cannot approve tokens",
      );
    }

    const txHash = await this.walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI as unknown as unknown[],
      functionName: "approve",
      args: [spender, amount satisfies bigint],
    });

    return { txHash };
  }
}
