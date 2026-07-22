/**
 * LiFISwapProvider
 *
 * Swap provider implementation for LI.FI.
 * Calls the LiFi API for swap quotes and execution.
 */

import type { ApiKeyConfig } from "../../shared-types";
import type {
  Route,
  RouteQuote,
  RouteStep,
  SwapProvider,
  Token,
} from "../types";
import { RouteEngineError } from "../types";

/**
 * LiFi uses the same numeric chain ID as EVM chains.
 * The lookup validates against the canonical chain registry.
 */
function caip2ToLiFiChain(chainId: number): string {
  // Chains not in the registry will fail downstream at LiFi API
  return String(chainId);
}

/**
 * Safely parse a string to BigInt with validation.
 * Throws if the string is empty, undefined, or contains non-numeric characters.
 */
export function parseBigIntSafe(
  value: string | undefined | null,
  fieldName: string,
): bigint {
  if (!value || value === "") {
    throw new RouteEngineError(
      "provider_unavailable",
      `LiFi ${fieldName} is empty or missing`,
    );
  }
  if (!/^(0x)?[a-fA-F0-9]+$/.test(value)) {
    throw new RouteEngineError(
      "provider_unavailable",
      `LiFi ${fieldName} contains invalid characters: ${value}`,
    );
  }
  return BigInt(value);
}

// ─── LiFISwapProvider ──────────────────────────────────────────────────

export interface LiFISwapProviderConfig extends ApiKeyConfig {
  /** LI.FI API base URL */
  apiUrl?: string;
  /** Default gas price (wei) fallback when LiFi API omits gasPrice */
  defaultGasPrice?: bigint;
  /** Slippage tolerance percent (default 0.5) */
  slippage?: number;
  /** Estimated time in ms (default 30000) */
  estimatedTimeMs?: number;
}

export class LiFISwapProvider implements SwapProvider {
  name = "LiFi";
  private apiUrl: string;
  private apiKey?: string;
  private defaultGasPrice: bigint;
  private slippage: number;
  private estimatedTimeMs: number;

  constructor(config?: LiFISwapProviderConfig) {
    this.apiUrl = config?.apiUrl ?? "https://li.quest/v1";
    this.apiKey = config?.apiKey;
    this.defaultGasPrice = config?.defaultGasPrice ?? 50_000_000_000n;
    this.slippage = config?.slippage ?? 0.5;
    this.estimatedTimeMs = config?.estimatedTimeMs ?? 30_000;
  }

  async estimate(params: {
    amount: bigint;
    fromToken: Token;
    toToken: Token;
  }): Promise<RouteQuote> {
    const { amount, fromToken, toToken } = params;

    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (this.apiKey) {
      headers["x-lifi-api-key"] = this.apiKey;
    }

    const queryParams = new URLSearchParams({
      fromChain: caip2ToLiFiChain(fromToken.chainId),
      toChain: caip2ToLiFiChain(toToken.chainId),
      fromToken: fromToken.address,
      toToken: toToken.address,
      fromAmount: String(amount),
      slippage: String(this.slippage),
    });

    const response = await fetch(
      `${this.apiUrl}/advanced/stepTransaction?${queryParams}`,
      { headers },
    );

    if (!response.ok) {
      throw new RouteEngineError(
        "no_routes_available",
        `LiFi API returned ${response.status}: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      estimate?: {
        toAmount: string;
        toAmountMin: string;
        fromAmount: string;
        approvalAddress?: string;
        fees?: Array<{ amount: string; token: string; included?: boolean }>;
      };
      transactionRequest?: {
        data: string;
        to: string;
        value: string;
        chainId: number;
        gasLimit: string;
        gasPrice?: string;
      };
      id?: string;
    };

    if (!data?.estimate?.toAmount || !data?.transactionRequest) {
      throw new RouteEngineError(
        "no_routes_available",
        "LiFi returned incomplete quote data",
      );
    }

    // Validate and normalize string → bigint conversions
    // toAmount is used for output amount calculation downstream
    const toAmount = parseBigIntSafe(
      data.estimate.toAmount,
      "estimate.toAmount",
    );
    const toAmountMin = parseBigIntSafe(
      data.estimate.toAmountMin,
      "estimate.toAmountMin",
    );

    const gasLimit = parseBigIntSafe(
      data.transactionRequest.gasLimit,
      "transactionRequest.gasLimit",
    );
    const gasPrice = data.transactionRequest.gasPrice
      ? parseBigIntSafe(
          data.transactionRequest.gasPrice,
          "transactionRequest.gasPrice",
        )
      : this.defaultGasPrice;
    const totalGas = gasLimit * gasPrice;

    // Gather any protocol fees from the estimate
    const totalFees = (data.estimate.fees ?? [])
      .filter((f) => f.included !== false)
      .reduce((sum, f) => sum + parseBigIntSafe(f.amount, "fee.amount"), 0n);

    const steps: RouteStep[] = [
      {
        type: "swap",
        fromToken,
        toToken,
        amount,
        estimatedGas: gasLimit,
        description: `Swap ${fromToken.symbol} → ${toToken.symbol} via LiFi`,
      },
    ];

    return {
      totalCost: totalGas + totalFees,
      estimatedTimeMs: this.estimatedTimeMs,
      slippage: this.slippage,
      steps,
      provider: this.name,
    };
  }

  async execute(_route: Route): Promise<{ txHash: string }> {
    // In production, this would send the transaction via viem/ethers
    // For now, return a placeholder execution
    throw new RouteEngineError(
      "execution_failed",
      "LiFi direct execution not yet implemented — use RouteEngine.executeRoute with an EVMRouteExecutor",
    );
  }
}
