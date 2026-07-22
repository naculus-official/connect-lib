/**
 * CAIP-122 — Sign-In With X (SIWx)
 *
 * References:
 *   - CAIP-122: https://standards.chainagnostic.org/CAIPs/caip-122
 *   - EIP-4361 (SIWE): https://eips.ethereum.org/EIPS/eip-4361
 */

/**
 * Chain-agnostic SIWx message parameters.
 */
export interface SiwxParams {
  /** RFC 4501 URI identifying the originating domain */
  domain: string;
  /** Blockchain address performing the sign-in */
  address: string;
  /** Human-readable statement (optional) */
  statement?: string;
  /** RFC 3986 URI identifying the relying party */
  uri: string;
  /** Current version of the SIWx message (default: 1) */
  version?: number;
  /** CAIP-2 chain ID (e.g. eip155:1, solana:4sGjMW1s) */
  chainId: string;
  /** Randomly generated nonce (recommended 8+ chars alphanumeric) */
  nonce: string;
  /** ISO 8601 datetime string of issuance */
  issuedAt?: string;
  /** ISO 8601 datetime string of expiry (optional) */
  expirationTime?: string;
  /** Timestamp after which the message is no longer valid (optional) */
  notBefore?: string;
  /** Optional URIs for resources the identity wishes to access */
  resources?: string[];
  /** CAIP-74 request ID (optional, for linking to a specific RPC call) */
  requestId?: string;
  /** Optional blockchain display name (e.g. "Ethereum", "Solana") */
  blockchain?: string;
}

/**
 * Result of signing a SIWx message.
 */
export interface SiwxResult {
  /** The signed message */
  message: SiwxMessage;
  /** The cryptographic signature */
  signature: string;
}

/**
 * Parsed SIWx message after serialization/deserialization.
 */
export interface SiwxMessage {
  /** Raw original message text */
  raw: string;
  domain: string;
  address: string;
  statement: string | null;
  uri: string;
  version: number;
  chainId: string;
  nonce: string;
  issuedAt: string | null;
  expirationTime: string | null;
  notBefore: string | null;
  resources: string[];
  requestId: string | null;
  /** Blockchain display name parsed from the message */
  blockchain: string;
}

/**
 * Namespace identifiers for supported chains.
 */
export type ChainNamespace = "eip155" | "solana" | "xrpl";

/**
 * Verification result after recovering the signer from a SIWx message.
 */
export interface SiwxVerificationResult {
  /** The recovered address */
  address: string;
  /** Whether the signature is valid */
  isValid: boolean;
  /** Error message if verification failed */
  error?: string;
}
