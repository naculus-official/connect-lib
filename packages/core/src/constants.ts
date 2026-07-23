/**
 * CAIP-2 Chain Namespace Identifiers
 *
 * References:
 *   - CAIP-2: https://namespaces.chainagnostic.org/CAIP-2
 */
export const NAMESPACE_EIP155 = "eip155" as const;
export const NAMESPACE_SOLANA = "solana" as const;
export const NAMESPACE_XRPL = "xrpl" as const;

export const SUPPORTED_NAMESPACES = [
  NAMESPACE_EIP155,
  NAMESPACE_SOLANA,
  NAMESPACE_XRPL,
] as const;

/**
 * Common EVM Chain IDs (CAIP-2 format)
 */
export const EIP155_MAINNET = "eip155:1";
/** @deprecated Goerli testnet was deprecated in early 2023. Use HOLESKY instead. */
export const EIP155_GOERLI = "eip155:5";
export const EIP155_HOLESKY = "eip155:17000";
export const EIP155_SEPOLIA = "eip155:11155111";
export const EIP155_POLYGON = "eip155:137";
export const EIP155_MUMBAI = "eip155:80001";
export const EIP155_ARBITRUM = "eip155:42161";
export const EIP155_ARBITRUM_GOERLI = "eip155:421613";
export const EIP155_OPTIMISM = "eip155:10";
export const EIP155_OPTIMISM_GOERLI = "eip155:420";
export const EIP155_BASE = "eip155:8453";

/**
 * Common Solana Cluster IDs (CAIP-2 format)
 */
export const SOLANA_MAINNET = "solana:0";
export const SOLANA_DEVNET = "solana:1";
export const SOLANA_TESTNET = "solana:2";

/**
 * Common XRPL Network IDs (CAIP-2 format)
 */
export const XRPL_MAINNET = "xrpl:0";
export const XRPL_TESTNET = "xrpl:1";
export const XRPL_DEVNET = "xrpl:2";

/**
 * Default EVM chain (Ethereum Mainnet)
 */
export const DEFAULT_EVM_CHAIN = EIP155_MAINNET;

/**
 * Default Solana cluster (Mainnet)
 */
export const DEFAULT_SOLANA_CLUSTER = SOLANA_MAINNET;

/**
 * Default XRPL network (Mainnet)
 */
export const DEFAULT_XRPL_NETWORK = XRPL_MAINNET;

/**
 * WalletConnect v2 Disconnect Reason Codes
 *
 * Reference: WalletConnect v2 Protocol Specification
 */
export const WC_DISCONNECT_USER = 6000;
export const WC_DISCONNECT_TIMEOUT = 6001;
export const WC_DISCONNECT_SESSION_EXPIRED = 6002;

/**
 * Storage keys used across connectors
 */
export const STORAGE_KEYS = {
  SESSION: "naculus_web3_session",
  POCKET: "naculus_pocket",
  PASSKEYS_CREDENTIAL: "naculus_passkeys_credential",
} as const;

/**
 * Nonce configuration
 */
export const DEFAULT_NONCE_LENGTH = 16;

/**
 * Session timeout values (in milliseconds)
 */
export const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const AUTO_RECONNECT_TIMEOUT_MS = 30 * 1000; // 30 seconds
