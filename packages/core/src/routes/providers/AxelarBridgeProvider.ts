/**
 * AxelarBridgeProvider
 *
 * Bridge provider implementation for Axelar.
 * Calls the Axelar API (GMP / Squid Router) for bridge quotes.
 */

import { CHAINS } from "../../chain-registry";
import { isValidAddress } from "../../address-validation";
import type { BridgeProvider, Route, RouteQuote, Token } from "../types";
import { RouteEngineError } from "../types";

function chainIdToAxelar(chainId: number): string {
  const name = CHAINS[chainId]?.axelarName;
  if (!name) {
    throw new RouteEngineError(
      "no_routes_available",
      `Unsupported Axelar chain ID: ${chainId}`,
    );
  }
  return name;
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
    if (
      !Number.isFinite(this.slippage) ||
      this.slippage < 0 ||
      this.slippage > 100
    ) {
      throw new RouteEngineError(
        "no_routes_available",
        "Axelar slippage must be between 0 and 100.",
      );
    }
  }

  async estimate(params: {
    amount: bigint;
    fromChain: { chainId: number };
    toChain: { chainId: number };
    fromToken: Token;
    toToken: Token;
  }): Promise<RouteQuote> {
    const { amount, fromChain, toChain, fromToken, toToken } = params;

    if (
      amount <= 0n ||
      fromToken.chainId !== fromChain.chainId ||
      toToken.chainId !== toChain.chainId ||
      !isValidAddress(fromToken.address, "eip155") ||
      !isValidAddress(toToken.address, "eip155")
    ) {
      throw new RouteEngineError(
        "no_routes_available",
        "Invalid Axelar route parameters.",
      );
    }

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

    // The public GMP fee endpoint returns fee components only. It does not
    // provide the destination amount, a source gateway transaction, or a
    // route identifier. Returning `outputAmount: amount` here would invent a
    // cross-chain conversion and could make a caller display or sign an
    // incorrect route. Require a trusted route builder (the modern
    // AxelarProvider backend path) for executable quotes instead.
    void axelarFrom;
    void axelarTo;
    throw new RouteEngineError(
      "no_routes_available",
      "Axelar GMP fee endpoint does not provide an authoritative route; use a trusted route backend.",
    );
  }

  async execute(_route: Route): Promise<{ txHash: string }> {
    // In production, construct and send the Axelar GMP deposit transaction
    throw new RouteEngineError(
      "execution_failed",
      "Axelar direct execution not yet implemented — use RouteEngine.executeRoute with an EVMRouteExecutor",
    );
  }
}
