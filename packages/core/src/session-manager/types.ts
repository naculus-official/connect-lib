/**
 * Chain Session Model for Multi-Chain Session Management
 *
 * @see SRS-009 §3
 */

import type { FeeEstimationConfig, FeeValues } from "../fee-estimation";
import type { UniversalWalletSession } from "../session";

// ─── Chain Session ──────────────────────────────────────────────────────

/**
 * Chain-specific session data.
 *
 * Defines the state of a session on one specific chain.
 * A single UniversalWalletSession can contain multiple ChainSessions
 * across different namespaces (e.g., EVM + Solana).
 */
export interface ChainSession {
  /** Chain ID in CAIP-2 format (e.g., "eip155:1", "solana:0") */
  chainId: string;

  /** The connector instance ID that manages this chain */
  connectorId: string;

  /** RPC endpoint for this chain */
  rpcUrl: string;

  /** Native currency metadata */
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };

  /** Block explorer URL (optional) */
  blockExplorer?: string;

  /** Last known fee values (cached) */
  lastKnownFees?: FeeValues;

  /** Timestamp of last successful fee estimation */
  lastFeeUpdatedAt?: string;
}

// ─── Active Session Bundle ──────────────────────────────────────────────

/**
 * Active session bundle: wraps a UniversalWalletSession with
 * its constituent ChainSessions for multi-chain visibility.
 */
export interface ActiveSessionBundle {
  /** The persistent UniversalWalletSession */
  walletSession: UniversalWalletSession;

  /** Chain-specific sessions derived from namespaces */
  chainSessions: Map<string, ChainSession>;

  /** The currently "active" chain ID (the chain being transacted on) */
  activeChainId: string;

  /** When this session was last used */
  lastActiveAt: string;
}

// ─── Persistence ───────────────────────────────────────────────────────

/**
 * Serialized format for session persistence.
 * Map is serialized as Record for JSON compatibility.
 */
export interface PersistedSessionData {
  walletSession: UniversalWalletSession;
  lastActiveChainId: string;
  chainSessions: Record<string, ChainSession>;
  lastConnectedAt: string;
}

// ─── User Fee Overrides ────────────────────────────────────────────────

/**
 * User-configured fee overrides, preserved across chain switches.
 * Keyed by CAIP-2 chainId.
 */
export interface UserFeeOverrides {
  [chainId: string]: {
    type?: "eip1559" | "legacy";
    maxPriorityFeePerGas?: bigint;
    baseFeeMultiplier?: bigint;
  };
}

// ─── Session Manager Config ────────────────────────────────────────────

export interface SessionManagerConfig {
  /** Default RPC URLs keyed by chainId */
  defaultRpcUrls?: Record<string, string>;
  /** Default native currency metadata keyed by chainId */
  defaultCurrencies?: Record<
    string,
    { name: string; symbol: string; decimals: number }
  >;
  /** Default block explorers keyed by chainId */
  defaultExplorers?: Record<string, string>;
  /** Whether to auto-refresh fee estimation on chain switch (default: true) */
  autoRefreshFeeOnSwitch?: boolean;
  /** Maximum active session bundles (default: 10) */
  maxActiveSessions?: number;
  /** Optional AES-GCM encryption key for session persistence */
  encryptionKey?: string;
}

// ─── Refresh Fees Options ──────────────────────────────────────────────

export interface RefreshFeesOptions {
  force?: boolean;
  userOverrides?: Partial<FeeEstimationConfig>;
}

// ─── Constructor Helpers ───────────────────────────────────────────────

/**
 * Parse a CAIP-2 chain ID into namespace and reference parts.
 * e.g., "eip155:1" → { namespace: "eip155", reference: "1" }
 * e.g., "solana:0" → { namespace: "solana", reference: "0" }
 */
export function parseChainId(chainId: string): {
  namespace: string;
  reference: string;
} {
  const parts = chainId.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid CAIP-2 chain ID: "${chainId}". Expected format: "namespace:reference"`,
    );
  }
  return { namespace: parts[0], reference: parts[1] };
}

/**
 * Validate a CAIP-2 chain ID format.
 * Supported namespaces: eip155, solana, xrpl
 */
export function validateChainId(chainId: string): void {
  const { namespace, reference } = parseChainId(chainId);
  const supported = ["eip155", "solana", "xrpl"];
  if (!supported.includes(namespace)) {
    throw new Error(
      `Unsupported namespace "${namespace}" in chain ID "${chainId}". Supported: ${supported.join(", ")}`,
    );
  }
  if (!/^\d+$/.test(reference)) {
    throw new Error(
      `Invalid reference "${reference}" in chain ID "${chainId}". Reference must be numeric.`,
    );
  }
}
