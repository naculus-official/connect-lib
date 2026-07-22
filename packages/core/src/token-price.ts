/**
 * Chainlink price feed decimals for ETH/USD and similar pairs.
 * Feeds return the price as an integer scaled by 10^8 (e.g., 30000000000 = 3000.00 USD).
 *
 * Precision limit: uint256 answer is converted via Number() for the return type.
 * Number.MAX_SAFE_INTEGER (2^53) / 10^8 ≈ 90,039,254 — well above realistic crypto prices.
 * If prices ever exceed ~$90M per unit, this will need a BigInt-based decimal division.
 */
const CHAINLINK_DECIMALS = 8;

import { CHAINS } from "./chain-registry";

function caip2ToChainId(caip2: string): number {
  return parseInt(caip2.split(":")[1] ?? "0", 10);
}

/**
 * Get the USD price of a native token (e.g. ETH, MATIC) by chain ID.
 *
 * This function was missing from the source but exists in the dist build.
 * It was added to the Ladle Vite bridge to unblock storybook-based testing.
 *
 * @param chain - EIP-155 chain ID (e.g. "eip155:1")
 * @param rpcUrl - Optional RPC URL for on-chain price lookup
 * @returns USD price as a number, or null if unavailable
 */
export async function getNativeTokenPriceUsd(
  chain: string,
  _rpcUrl?: string,
): Promise<number | null> {
  const chainId = caip2ToChainId(chain);
  const info = CHAINS[chainId];
  const feedAddress = info?.chainlinkEthUsdFeed;
  if (!feedAddress || !_rpcUrl) return null;

  // Use Chainlink price feed ABI to get latest price
  const abi = [
    {
      inputs: [],
      name: "latestRoundData",
      outputs: [
        { name: "roundId", type: "uint80" },
        { name: "answer", type: "int256" },
        { name: "startedAt", type: "uint256" },
        { name: "updatedAt", type: "uint256" },
        { name: "answeredInRound", type: "uint80" },
      ],
      stateMutability: "view",
      type: "function",
    },
  ];

  try {
    const response = await fetch(_rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          {
            to: feedAddress,
            data: "0xfeaf968c", // latestRoundData function selector
          },
          "latest",
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return null;

    const json = await response.json();
    if (json.error) return null;

    // Parse the result: the price comes back as a 256-bit value
    // (typically with 8 decimals for Chainlink ETH/USD price feeds)
    const result = json.result;
    if (!result) return null;

    // Decode the hex result — answer is the 2nd 32-byte word
    const hex = result.startsWith("0x") ? result.slice(2) : result;
    const answer = BigInt("0x" + hex.slice(64, 128));

    // Chainlink feeds use 8 decimals for price
    // Number() is safe here: MAX_SAFE_INTEGER / 10^8 ≈ 90M, well above realistic prices
    return Number(answer) / 10 ** CHAINLINK_DECIMALS;
  } catch {
    return null;
  }
}
