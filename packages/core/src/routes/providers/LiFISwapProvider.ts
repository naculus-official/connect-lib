/**
 * LiFISwapProvider
 *
 * Swap provider implementation for LI.FI.
 * Calls the LiFi API for swap quotes and execution.
 */

import { isValidAddress } from "../../address-validation";
import { getChainInfo } from "../../chain-registry";
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
  // Keep provider requests constrained to the SDK's canonical registry.
  // Sending arbitrary numeric IDs to a provider would make chain support
  // dependent on an undocumented external fallback.
  getChainInfo(chainId);
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
  if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
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
  /** Optional caller-supplied gas price (wei) fallback when LiFi omits gasPrice. */
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
  private defaultGasPrice: bigint | undefined;
  private slippage: number;
  private estimatedTimeMs: number;

  constructor(config?: LiFISwapProviderConfig) {
    this.apiUrl = config?.apiUrl ?? "https://li.quest/v1";
    this.apiKey = config?.apiKey;
    // Never invent a market gas price. A fallback is accepted only when the
    // integrator explicitly supplies one; otherwise a quote without an
    // authoritative gas price is rejected below.
    this.defaultGasPrice = config?.defaultGasPrice;
    if (this.defaultGasPrice !== undefined && this.defaultGasPrice < 0n) {
      throw new RouteEngineError(
        "provider_unavailable",
        "LiFi default gas price cannot be negative.",
      );
    }
    this.slippage = config?.slippage ?? 0.5;
    this.estimatedTimeMs = config?.estimatedTimeMs ?? 30_000;
    if (
      !Number.isFinite(this.slippage) ||
      this.slippage < 0 ||
      this.slippage > 100
    ) {
      throw new RouteEngineError(
        "provider_unavailable",
        "LiFi slippage must be between 0 and 100.",
      );
    }
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

    if (
      !data?.estimate?.toAmount ||
      !data?.estimate?.toAmountMin ||
      !data?.estimate?.fromAmount ||
      !data?.transactionRequest
    ) {
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
    const fromAmount = parseBigIntSafe(
      data.estimate.fromAmount,
      "estimate.fromAmount",
    );
    if (fromAmount !== amount || toAmountMin > toAmount) {
      throw new RouteEngineError(
        "provider_unavailable",
        "LiFi returned an inconsistent quote amount.",
      );
    }

    const request = data.transactionRequest;
    if (
      !isValidAddress(request.to, "eip155") ||
      !/^0x[0-9a-fA-F]*$/.test(request.data) ||
      request.data.length % 2 !== 0
    ) {
      throw new RouteEngineError(
        "provider_unavailable",
        "LiFi returned invalid EVM transaction calldata.",
      );
    }
    if (
      !Number.isSafeInteger(request.chainId) ||
      request.chainId <= 0 ||
      request.chainId !== fromToken.chainId
    ) {
      throw new RouteEngineError(
        "provider_unavailable",
        "LiFi returned a transaction for the wrong chain.",
      );
    }
    const txValue = parseBigIntSafe(request.value, "transactionRequest.value");

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
    if (gasPrice === undefined) {
      throw new RouteEngineError(
        "provider_unavailable",
        "LiFi omitted transactionRequest.gasPrice; provide an authoritative gas price or an explicit fallback.",
      );
    }
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
        transaction: {
          to: request.to as `0x${string}`,
          data: request.data as `0x${string}`,
          value: txValue,
          chainId: request.chainId,
        },
      },
    ];

    return {
      totalCost: totalGas + totalFees,
      outputAmount: toAmount,
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
