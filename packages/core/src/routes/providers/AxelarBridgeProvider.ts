/**
 * AxelarBridgeProvider
 *
 * Bridge provider implementation for Axelar.
 * Calls the Axelar API (GMP / Squid Router) for bridge quotes.
 */

import { CHAINS } from "../../chain-registry";
import type {
  BridgeProvider,
  Route,
  RouteQuote,
  RouteStep,
  Token,
} from "../types";
import { RouteEngineError } from "../types";

function chainIdToAxelar(chainId: number): string {
  return CHAINS[chainId]?.axelarName ?? String(chainId);
}

// ─── AxelarBridgeProvider ──────────────────────────────────────────────

export interface AxelarBridgeProviderConfig {
  /** Axelar API base URL */
  apiUrl?: string;
  /** Estimated time in ms (default 120000) */
  estimatedTimeMs?: number;
  /** Slippage tolerance percent (default 0) */
  slippage?: number;
}

export class AxelarBridgeProvider implements BridgeProvider {
  name = "Axelar";
  private apiUrl: string;
  private estimatedTimeMs: number;
  private slippage: number;

  constructor(config?: AxelarBridgeProviderConfig) {
    this.apiUrl = config?.apiUrl ?? "https://api.axelarscan.io";
    this.estimatedTimeMs = config?.estimatedTimeMs ?? 120_000;
    this.slippage = config?.slippage ?? 0;
  }

  async estimate(params: {
    amount: bigint;
    fromChain: { chainId: number };
    toChain: { chainId: number };
    fromToken: Token;
    toToken: Token;
  }): Promise<RouteQuote> {
    const { amount, fromChain, toChain, fromToken, toToken } = params;

    const axelarFrom = chainIdToAxelar(fromChain.chainId);
    const axelarTo = chainIdToAxelar(toChain.chainId);

    // Estimate GMP fee via Axelar API
    const gmpResponse = await fetch(`${this.apiUrl}/GMP/gmpFee`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChain: axelarFrom,
        destinationChain: axelarTo,
        amount: String(amount),
        sourceContractAddress: fromToken.address,
      }),
    });

    if (!gmpResponse.ok) {
      throw new RouteEngineError(
        "no_routes_available",
        `Axelar GMP fee API returned ${gmpResponse.status}`,
      );
    }

    const gmpData = (await gmpResponse.json()) as {
      baseFee?: string;
      sourceGasFee?: string;
      destinationGasFee?: string;
    };

    const baseFee = BigInt(gmpData.baseFee ?? "0");
    const sourceGasFee = BigInt(gmpData.sourceGasFee ?? "0");
    const destGasFee = BigInt(gmpData.destinationGasFee ?? "0");
    const totalCost = baseFee + sourceGasFee + destGasFee;

    const steps: RouteStep[] = [
      {
        type: "bridge",
        fromToken,
        toToken,
        amount,
        estimatedGas: sourceGasFee,
        description: `Bridge ${fromToken.symbol} from ${axelarFrom} → ${axelarTo} via Axelar GMP`,
      },
    ];

    return {
      totalCost,
      estimatedTimeMs: this.estimatedTimeMs,
      slippage: this.slippage,
      steps,
      provider: this.name,
    };
  }

  async execute(_route: Route): Promise<{ txHash: string }> {
    // In production, construct and send the Axelar GMP deposit transaction
    throw new RouteEngineError(
      "execution_failed",
      "Axelar direct execution not yet implemented — use RouteEngine.executeRoute with an EVMRouteExecutor",
    );
  }
}
