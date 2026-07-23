export const DEFAULT_RPC_URLS: Record<string, string> = {
  "eip155:1": "https://eth.llamarpc.com",
  "eip155:17000": "https://holesky.llamarpc.com",
  "eip155:11155111": "https://sepolia.llamarpc.com",
  "eip155:137": "https://polygon.llamarpc.com",
  "eip155:10": "https://optimism.llamarpc.com",
  "eip155:42161": "https://arbitrum.llamarpc.com",
  "eip155:8453": "https://base.llamarpc.com",
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
