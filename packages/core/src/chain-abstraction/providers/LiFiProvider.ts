/**
 * LiFiProvider — LI.FI SDK integration for cross-chain swaps.
 *
 * Integrates with the LI.FI API to discover routes and build
 * transaction data for hop-based cross-chain transfers.
 *
 * When a LI.FI API key is configured, queries the LI.FI API directly.
 * Otherwise falls back to a senderpay backend proxy if configured.
 *
 * @see https://apidocs.li.fi/reference
 */

import { resolveTokenAddress } from "../../chain-registry";
import { logger } from "../../logger";
import type {
  BridgeProvider,
  BridgeProviderId,
  GasEstimate,
  ProviderTransaction,
  Route,
  RouteStatus,
  RouteStep,
} from "../types";

// ─── Known chain ID mapping (LI.FI chain names → CAIP-2) ──────────────

const LIFI_CHAIN_MAP: Record<string, string> = {
  "1": "eip155:1", // Ethereum
  "137": "eip155:137", // Polygon
  "10": "eip155:10", // Optimism
  "42161": "eip155:42161", // Arbitrum
  "8453": "eip155:8453", // Base
  "43114": "eip155:43114", // Avalanche
  "56": "eip155:56", // BNB Chain
  "250": "eip155:250", // Fantom
  "324": "eip155:324", // zkSync Era
  "59144": "eip155:59144", // Linea
  "534352": "eip155:534352", // Scroll
  "100": "eip155:100", // Gnosis
  "1101": "eip155:1101", // Polygon zkEVM
};

const REVERSE_LIFI_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(LIFI_CHAIN_MAP).map(([k, v]) => [v, k]),
);

function toLiFiChainId(chainId: string): string {
  // Accept CAIP-2 or raw numeric
  const match = REVERSE_LIFI_MAP[chainId];
  if (match) return match;
  if (chainId.startsWith("eip155:")) return chainId.slice(7);
  return chainId;
}

function fromLiFiChainId(chainId: string): string {
  return LIFI_CHAIN_MAP[chainId] ?? `eip155:${chainId}`;
}

// ─── Default supported chain pairs (EVM ↔ EVM) ────────────────────────

const SUPPORTED_CHAINS = new Set([
  "eip155:1",
  "eip155:137",
  "eip155:10",
  "eip155:42161",
  "eip155:8453",
  "eip155:43114",
  "eip155:56",
  "eip155:250",
  "eip155:324",
  "eip155:59144",
  "eip155:534352",
  "eip155:100",
  "eip155:1101",
]);

// ─── Tokens LI.FI can route (symbols; addresses resolve via chain-registry) ──

const SUPPORTED_TOKENS: Record<string, string[]> = {
  "eip155:1": ["USDC", "USDT", "DAI", "WETH", "ETH"],
  "eip155:137": ["USDC", "USDT", "DAI", "WMATIC", "MATIC"],
  "eip155:10": ["USDC", "USDT", "DAI", "WETH", "ETH"],
  "eip155:42161": ["USDC", "USDT", "DAI", "WETH", "ETH"],
  "eip155:8453": ["USDC", "WETH", "ETH"],
};

// ─── LiFiProvider ──────────────────────────────────────────────────────

export interface LiFiProviderConfig {
  /** LI.FI API key (optional) */
  apiKey?: string;
  /** LI.FI API base URL */
  apiUrl?: string;
  /** Backend proxy URL (alternative to direct API) */
  backendUrl?: string;
}

export class LiFiProvider implements BridgeProvider {
  readonly id: BridgeProviderId = "lifi";
  readonly name = "LI.FI";
  private config: Required<Pick<LiFiProviderConfig, "apiUrl">> &
    LiFiProviderConfig;

  constructor(config?: LiFiProviderConfig) {
    this.config = {
      apiUrl: config?.apiUrl ?? "https://li.quest/v1",
      apiKey: config?.apiKey,
      backendUrl: config?.backendUrl,
    };
  }

  async getRoutes(
    fromChain: string,
    toChain: string,
    fromToken: string,
    toToken: string,
    amount: string,
  ): Promise<Route[]> {
    if (!this.supportsChainPair(fromChain, toChain)) {
      return [];
    }

    const lifiFromChain = toLiFiChainId(fromChain);
    const lifiToChain = toLiFiChainId(toChain);
    const resolvedFromToken = resolveTokenAddress(fromChain, fromToken);
    const resolvedToToken = resolveTokenAddress(toChain, toToken);

    // Try backend proxy first
    if (this.config.backendUrl) {
      try {
        const routes = await this.getRoutesViaBackend(
          fromChain,
          toChain,
          resolvedFromToken,
          resolvedToToken,
          amount,
        );
        if (routes.length > 0) return routes;
      } catch (error) {
        logger.warn(
          "lifi-provider",
          "Backend proxy unavailable, falling back to direct API",
          error,
        );
      }
    }

    // Fall through to direct LI.FI API
    try {
      const directRoutes = await this.getRoutesViaDirectAPI(
        lifiFromChain,
        lifiToChain,
        resolvedFromToken,
        resolvedToToken,
        amount,
      );
      return directRoutes;
    } catch (error) {
      logger.warn("lifi-provider", "Direct LI.FI API call failed", error);
      return [];
    }
  }

  private async getRoutesViaBackend(
    fromChain: string,
    toChain: string,
    fromToken: string,
    toToken: string,
    amount: string,
  ): Promise<Route[]> {
    if (!this.config.backendUrl) return [];

    const response = await fetch(`${this.config.backendUrl}/api/routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromChain,
        toChain,
        fromToken,
        toToken,
        amount,
        provider: "lifi",
      }),
    });

    if (!response.ok) throw new Error(`Backend returned ${response.status}`);

    const data = (await response.json()) as { routes?: Route[] };
    return data.routes ?? [];
  }

  private async getRoutesViaDirectAPI(
    fromChain: string,
    toChain: string,
    fromToken: string,
    toToken: string,
    amount: string,
  ): Promise<Route[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["x-lifi-api-key"] = this.config.apiKey;
    }

    const params = new URLSearchParams({
      fromChain: fromChain.toString(),
      toChain: toChain.toString(),
      fromToken,
      toToken,
      fromAmount: amount,
      slippage: "0.5",
    });

    const response = await fetch(
      `${this.config.apiUrl}/advanced/stepTransaction?${params}`,
      { headers },
    );

    if (!response.ok) {
      logger.warn("lifi-provider", `LI.FI API returned ${response.status}`);
      return [];
    }

    const data = (await response.json()) as {
      transactionRequest?: {
        data: string;
        to: string;
        value: string;
        chainId: number;
        gasLimit: string;
      };
      estimate?: {
        fromAmount: string;
        toAmount: string;
        toAmountMin: string;
        approvalAddress: string;
        fees?: Array<{ amount: string; token: string }>;
      };
      id?: string;
    };

    if (!data.transactionRequest || !data.estimate) {
      return [];
    }

    // Map LI.FI response to our Route format
    const routes: Route[] = [
      {
        id:
          data.id ??
          `lifi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        provider: "lifi",
        fromChain,
        toChain,
        fromToken,
        toToken,
        fromAmount: amount,
        toAmount: data.estimate.toAmount,
        toAmountMin: data.estimate.toAmountMin,
        gasCosts: {
          fromChain: {
            maxFeePerGas: "0",
            maxPriorityFeePerGas: "0",
            gasLimit: data.transactionRequest.gasLimit ?? "0",
            totalCostWei: "0",
            totalCostUsd: "0",
          },
          toChain: {
            maxFeePerGas: "0",
            maxPriorityFeePerGas: "0",
            gasLimit: "0",
            totalCostWei: "0",
            totalCostUsd: "0",
          },
          totalUsd: "0",
        },
        estimatedTime: 30,
        steps: [
          {
            type: "approve",
            chain: fromChain,
            token: fromToken,
            contractAddress: data.transactionRequest.to,
            estimatedGas: data.transactionRequest.gasLimit ?? "0",
          },
          {
            type: "cross-chain",
            chain: fromChain,
            token: fromToken,
            contractAddress: data.transactionRequest.to,
            data: data.transactionRequest.data,
            estimatedGas: data.transactionRequest.gasLimit ?? "0",
          },
        ],
        fee: {
          protocolFee: "0",
        },
        summary: `Bridge via LI.FI: ${fromChain} → ${toChain}`,
      },
    ];

    return routes;
  }

  async getTransactionParams(
    route: Route,
    sender: string,
    recipient: string,
  ): Promise<ProviderTransaction[]> {
    // Build from the route steps
    const txs: ProviderTransaction[] = [];
    const crossChainStep = route.steps.find((s) => s.type === "cross-chain");

    // Add approve transaction if needed
    const approveStep = route.steps.find((s) => s.type === "approve");
    if (approveStep) {
      txs.push({
        type: "approve",
        chainId: route.fromChain,
        to: route.fromToken,
        data: approveStep.data ?? "0x",
        value: "0",
      });
    }

    if (crossChainStep?.data) {
      txs.push({
        type: "cross-chain",
        chainId: route.fromChain,
        to: crossChainStep.contractAddress,
        data: crossChainStep.data,
        value: route.fromAmount,
      });
    }

    // If no explicit data is available, we need the API to build it
    if (txs.length === 0) {
      try {
        const params = new URLSearchParams({
          fromChain: toLiFiChainId(route.fromChain),
          toChain: toLiFiChainId(route.toChain),
          fromToken: route.fromToken,
          toToken: route.toToken,
          fromAmount: route.fromAmount,
          fromAddress: sender,
          toAddress: recipient,
          slippage: "0.5",
        });

        const response = await fetch(
          `${this.config.apiUrl}/advanced/stepTransaction?${params}`,
          {
            headers: this.config.apiKey
              ? { "x-lifi-api-key": this.config.apiKey }
              : {},
          },
        );

        if (response.ok) {
          const data = (await response.json()) as {
            transactionRequest?: {
              data: string;
              to: string;
              value: string;
              chainId: number;
            };
          };
          if (data.transactionRequest) {
            txs.push({
              type: "cross-chain",
              chainId: route.fromChain,
              to: data.transactionRequest.to,
              data: data.transactionRequest.data,
              value: data.transactionRequest.value,
            });
          }
        }
      } catch (error) {
        logger.warn(
          "lifi-provider",
          "Failed to fetch transaction params from API",
          error,
        );
        throw new Error(
          "Unable to build transaction parameters for LI.FI route",
        );
      }
    }

    return txs;
  }

  async getRouteStatus(bridgeReference: string): Promise<RouteStatus> {
    try {
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers["x-lifi-api-key"] = this.config.apiKey;
      }

      const response = await fetch(
        `${this.config.apiUrl}/status?txHash=${bridgeReference}`,
        { headers },
      );

      if (!response.ok) {
        return { status: "pending" };
      }

      const data = (await response.json()) as {
        status?: string;
        receiving?: { txHash?: string };
      };

      const lifiStatus = data.status ?? "pending";

      return {
        status: this.mapLiFiStatus(lifiStatus),
        toTxHash: data.receiving?.txHash,
        currentStep: lifiStatus,
      };
    } catch {
      return { status: "pending" };
    }
  }

  supportsChainPair(fromChain: string, toChain: string): boolean {
    return SUPPORTED_CHAINS.has(fromChain) && SUPPORTED_CHAINS.has(toChain);
  }

  supportsToken(chain: string, token: string): boolean {
    const supported = SUPPORTED_TOKENS[chain];
    if (!supported) return false;
    if (token.startsWith("0x") && token.length === 42) {
      const addr = token.toLowerCase();
      return supported.some(
        (s) => resolveTokenAddress(chain, s).toLowerCase() === addr,
      );
    }
    return supported.some((s) => s.toUpperCase() === token.toUpperCase());
  }

  private mapLiFiStatus(
    lifiStatus: string,
  ): "pending" | "bridging" | "completed" | "failed" {
    switch (lifiStatus) {
      case "DONE":
      case "COMPLETED":
        return "completed";
      case "FAILED":
        return "failed";
      case "BRIDGE":
      case "RECEIVED":
        return "bridging";
      default:
        return "pending";
    }
  }
}
