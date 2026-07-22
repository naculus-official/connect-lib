/**
 * AxelarProvider — Axelar GMP integration for cross-chain transfers.
 *
 * Integrates with the Axelar network for General Message Passing (GMP),
 * enabling cross-chain token transfers and arbitrary contract calls.
 *
 * When configured with a backend URL, proxies through senderpay backend.
 * Otherwise attempts direct Axelar API interaction.
 *
 * @see https://docs.axelar.dev/dev/general-message-passing
 */

import { logger } from "../../logger";
import type {
  BridgeProvider,
  BridgeProviderId,
  ProviderTransaction,
  Route,
  RouteStatus,
} from "../types";

// ─── Axelar chain mapping ──────────────────────────────────────────────

const AXELAR_CHAIN_MAP: Record<string, string> = {
  "eip155:1": "ethereum",
  "eip155:137": "polygon",
  "eip155:10": "optimism",
  "eip155:42161": "arbitrum",
  "eip155:8453": "base",
  "eip155:43114": "avalanche",
  "eip155:56": "binance",
  "eip155:250": "fantom",
  "eip155:100": "gnosis",
  "eip155:1101": "polygon-zkevm",
};

const REVERSE_AXELAR_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(AXELAR_CHAIN_MAP).map(([k, v]) => [v, k]),
);

function toAxelarChain(chainId: string): string | undefined {
  return (
    AXELAR_CHAIN_MAP[chainId] ??
    (chainId.startsWith("eip155:") ? chainId.slice(7) : chainId)
  );
}

const SUPPORTED_AXELAR_CHAINS = new Set(Object.keys(AXELAR_CHAIN_MAP));

// ─── Known token addresses for Axelar-supported tokens ─────────────────

const KNOWN_TOKENS: Record<string, Record<string, string>> = {
  "eip155:1": {
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    aUSDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  "eip155:137": {
    USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    aUSDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  },
  "eip155:10": {
    USDC: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    aUSDC: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
  },
};

function resolveTokenAddress(chain: string, token: string): string {
  const chainTokens = KNOWN_TOKENS[chain];
  if (!chainTokens) return token;
  if (token.startsWith("0x") && token.length === 42) return token;
  return chainTokens[token.toUpperCase()] ?? token;
}

// ─── AxelarProvider ────────────────────────────────────────────────────

export interface AxelarProviderConfig {
  /** Axelar API base URL */
  apiUrl?: string;
  /** Backend proxy URL (alternative to direct API) */
  backendUrl?: string;
}

export class AxelarProvider implements BridgeProvider {
  readonly id: BridgeProviderId = "axelar";
  readonly name = "Axelar";
  private config: Required<Pick<AxelarProviderConfig, "apiUrl">> &
    AxelarProviderConfig;

  constructor(config?: AxelarProviderConfig) {
    this.config = {
      apiUrl: config?.apiUrl ?? "https://api.axelarscan.io",
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
        logger.warn("axelar-provider", "Backend proxy unavailable", error);
      }
    }

    // Attempt direct Axelar API for GMP fee estimation
    try {
      const directRoutes = await this.getRoutesViaDirectAPI(
        fromChain,
        toChain,
        resolvedFromToken,
        resolvedToToken,
        amount,
      );
      return directRoutes;
    } catch (error) {
      logger.warn("axelar-provider", "Direct API call failed", error);
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
        provider: "axelar",
      }),
    });

    if (!response.ok) throw new Error(`Backend returned ${response.status}`);
    const data = (await response.json()) as { routes?: Route[] };
    return data.routes ?? [];
  }

  private async getRoutesViaDirectAPI(
    fromChain: string,
    toChain: string,
    _fromToken: string,
    _toToken: string,
    amount: string,
  ): Promise<Route[]> {
    const axelarFrom = toAxelarChain(fromChain);
    const axelarTo = toAxelarChain(toChain);
    if (!axelarFrom || !axelarTo) return [];

    try {
      // Estimate GMP fee via Axelar API
      const gmpResponse = await fetch(`${this.config.apiUrl}/GMP/gmpFee`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChain: axelarFrom,
          destinationChain: axelarTo,
          amount,
          sourceContractAddress: _fromToken,
        }),
      });

      if (!gmpResponse.ok) {
        logger.warn(
          "axelar-provider",
          `GMP fee API returned ${gmpResponse.status}`,
        );
        return [];
      }

      const gmpData = (await gmpResponse.json()) as {
        baseFee?: string;
        sourceGasFee?: string;
        destinationGasFee?: string;
      };

      const baseFee = gmpData.baseFee ?? "0";
      const destGasFee = gmpData.destinationGasFee ?? "0";

      return [
        {
          id: `axelar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          provider: "axelar",
          fromChain,
          toChain,
          fromToken: _fromToken,
          toToken: _toToken,
          fromAmount: amount,
          toAmount: amount, // Axelar typically sends the same amount minus fees
          toAmountMin: (
            BigInt(amount) -
            BigInt(baseFee) -
            BigInt(destGasFee)
          ).toString(),
          gasCosts: {
            fromChain: {
              maxFeePerGas: "0",
              maxPriorityFeePerGas: "0",
              gasLimit: "250000",
              totalCostWei: "0",
              totalCostUsd: "0",
            },
            toChain: {
              maxFeePerGas: "0",
              maxPriorityFeePerGas: "0",
              gasLimit: destGasFee,
              totalCostWei: destGasFee,
              totalCostUsd: "0",
            },
            totalUsd: "0",
          },
          estimatedTime: 120, // Axelar GMP typically takes 1-2 minutes
          steps: [
            {
              type: "approve",
              chain: fromChain,
              token: _fromToken,
              contractAddress: this.getAxelarGateway(fromChain),
              estimatedGas: "150000",
            },
            {
              type: "cross-chain",
              chain: fromChain,
              token: _fromToken,
              contractAddress: this.getAxelarGateway(fromChain),
              estimatedGas: "250000",
            },
          ],
          fee: {
            protocolFee: baseFee,
            integrationFee: destGasFee,
          },
          summary: `Deposit via Axelar GMP: ${fromChain} → ${toChain}`,
        },
      ];
    } catch (error) {
      logger.warn("axelar-provider", "Failed to estimate GMP fee", error);
      return [];
    }
  }

  async getTransactionParams(
    _route: Route,
    _sender: string,
    _recipient: string,
  ): Promise<ProviderTransaction[]> {
    // Build approve + deposit transactions for Axelar GMP
    return [
      {
        type: "approve",
        chainId: _route.fromChain,
        to: _route.fromToken,
        data: "0x",
        value: "0",
      },
      {
        type: "cross-chain",
        chainId: _route.fromChain,
        to: this.getAxelarGateway(_route.fromChain),
        data: this.buildGMPData(_route, _recipient),
        value: _route.fromAmount,
      },
    ];
  }

  async getRouteStatus(bridgeReference: string): Promise<RouteStatus> {
    try {
      const response = await fetch(
        `${this.config.apiUrl}/GMP/search?txHash=${bridgeReference}`,
      );

      if (!response.ok) {
        return { status: "pending" };
      }

      const data = (await response.json()) as {
        status?: string;
        toTxHash?: string;
      };

      const axelarStatus = data.status ?? "pending";

      return {
        status: this.mapAxelarStatus(axelarStatus),
        toTxHash: data.toTxHash,
        currentStep: axelarStatus,
      };
    } catch {
      return { status: "pending" };
    }
  }

  supportsChainPair(fromChain: string, toChain: string): boolean {
    return (
      SUPPORTED_AXELAR_CHAINS.has(fromChain) &&
      SUPPORTED_AXELAR_CHAINS.has(toChain)
    );
  }

  supportsToken(chain: string, token: string): boolean {
    const chainTokens = KNOWN_TOKENS[chain];
    if (!chainTokens) return false;
    if (token.startsWith("0x") && token.length === 42) {
      return Object.values(chainTokens).includes(token.toLowerCase());
    }
    return Object.keys(chainTokens).includes(token.toUpperCase());
  }

  private getAxelarGateway(chainId: string): string {
    // Known Axelar gateway contract addresses per chain
    const GATEWAYS: Record<string, string> = {
      "eip155:1": "0x4F449524383f30E6fEeE5e11e6E65C89CDc3df8D",
      "eip155:137": "0x6f015F16De3fC12C9b5F8E1072e80E8Af7C5B0c4",
      "eip155:10": "0x7f0a0C7149a46Bf943cCd412da687144b49C8274",
      "eip155:42161": "0xe432150cce91c13a887f7D836923b4F32401c4DC",
      "eip155:8453": "0x5a913e3e5dAb48c1B0A5Bf1a31290f2d7eA3C0d4",
    };
    return GATEWAYS[chainId] ?? "0x0000000000000000000000000000000000000000";
  }

  private buildGMPData(route: Route, recipient: string): string {
    // Build Axelar GMP deposit data
    // In production, this would encode the full GMP payload
    // For now, return a minimal ABI-encoded representation
    const axelarTo = toAxelarChain(route.toChain) ?? route.toChain;
    const recipientPadded = recipient.padStart(66, "0x").slice(0, 66);

    // Simplified encoding: just encode the destination chain and recipient
    return `0x${Buffer.from(axelarTo).toString("hex")}${recipientPadded.slice(2)}`;
  }

  private mapAxelarStatus(
    axelarStatus: string,
  ): "pending" | "bridging" | "completed" | "failed" {
    switch (axelarStatus) {
      case "executed":
      case "confirmed":
        return "completed";
      case "failed":
        return "failed";
      case "approved":
      case "gateway_call":
        return "bridging";
      default:
        return "pending";
    }
  }
}
