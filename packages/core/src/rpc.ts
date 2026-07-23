export const DEFAULT_RPC_URLS: Record<string, string> = {
  "eip155:1": process.env.DEFAULT_RPC_ETH ?? "https://eth.llamarpc.com",
  "eip155:17000": process.env.DEFAULT_RPC_HOLESKY ?? "https://holesky.llamarpc.com",
  "eip155:11155111": process.env.DEFAULT_RPC_SEPOLIA ?? "https://sepolia.llamarpc.com",
  "eip155:137": process.env.DEFAULT_RPC_POLYGON ?? "https://polygon.llamarpc.com",
  "eip155:10": process.env.DEFAULT_RPC_OPTIMISM ?? "https://optimism.llamarpc.com",
  "eip155:42161": process.env.DEFAULT_RPC_ARBITRUM ?? "https://arbitrum.llamarpc.com",
  "eip155:8453": process.env.DEFAULT_RPC_BASE ?? "https://base.llamarpc.com",
  "solana:0": "https://api.mainnet-beta.solana.com",
  "solana:1": "https://api.devnet.solana.com",
  "solana:2": "https://api.testnet.solana.com",
};

/**
 * Get the default RPC URL for a given CAIP-2 chainId.
 * Returns undefined if no default is configured.
 */
export function getRpcUrl(
  chainId: string,
  fallback?: string,
): string | undefined {
  return DEFAULT_RPC_URLS[chainId] ?? fallback;
}
