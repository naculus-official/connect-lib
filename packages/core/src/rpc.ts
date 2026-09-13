import { SOLANA_DEVNET, SOLANA_MAINNET, SOLANA_TESTNET } from "./constants";
/**
 * Public fallback RPC endpoints used only when a caller has not supplied its
 * own transport. This distributable package intentionally does not read
 * process.env: environment values are often injected by a PaaS at build time
 * and may contain provider API keys, which would leak into browser bundles.
 * SenderPay and other production apps should pass a public, quota-limited RPC
 * URL or use a backend proxy/workload identity for provider credentials.
 */
export const DEFAULT_RPC_URLS: Record<string, string> = {
  "eip155:1": "https://eth.llamarpc.com",
  "eip155:17000": "https://holesky.llamarpc.com",
  "eip155:11155111": "https://sepolia.llamarpc.com",
  "eip155:137": "https://polygon.llamarpc.com",
  "eip155:10": "https://optimism.llamarpc.com",
  "eip155:42161": "https://arbitrum.llamarpc.com",
  "eip155:8453": "https://base.llamarpc.com",
  [SOLANA_MAINNET]: "https://api.mainnet-beta.solana.com",
  [SOLANA_DEVNET]: "https://api.devnet.solana.com",
  [SOLANA_TESTNET]: "https://api.testnet.solana.com",
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
