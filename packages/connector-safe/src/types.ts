/**
 * Safe Wallet Connector — Type Definitions
 *
 * Types specific to Safe Wallet integration via @safe-global/safe-apps-sdk.
 * These types extend the core @naculus/connect-core types with Safe-specific
 * transaction and environment data.
 */

/** Configuration for the SafeConnector */
export interface SafeConnectorConfig {
  /** Safe Apps SDK options */
  sdkOptions?: {
    /** Allowed Safe domains for iframe communication */
    allowedDomains?: RegExp[];
    /** Enable debug logging in the SDK */
    debug?: boolean;
  };
}

/** Safe environment information returned by sdk.safe.getInfo() */
export interface SafeEnvironment {
  /** Whether the current page is inside a Safe App iframe */
  isSafeApp: boolean;
  /** Safe contract address */
  safeAddress?: `0x${string}`;
  /** Chain ID (numeric, e.g. 1 for Ethereum mainnet) */
  chainId?: number;
  /** Owner addresses of the Safe */
  owners?: `0x${string}`[];
  /** Required number of signatures */
  threshold?: number;
  /** Safe contract version */
  version?: string;
  /** Safe implementation address */
  implementation?: `0x${string}`;
}

/**
 * Safe transaction request parameters.
 *
 * Extends the base transaction with Safe-specific gas and operation fields.
 * All fields are optional beyond the standard to/value/data — the Safe SDK
 * will fill sensible defaults for omitted fields.
 */
export interface SafeTransactionRequest {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  /** Operation type: 0 = CALL, 1 = DELEGATE_CALL */
  operation?: number;
  /** Safe-specific gas limit for the execution */
  safeTxGas?: number;
  /** Gas added to base gas for the Safe execution */
  baseGas?: number;
  /** Gas price (in wei or token) */
  gasPrice?: string;
  /** Token address for gas payment (zero address = native token) */
  gasToken?: `0x${string}`;
  /** Refund receiver for remaining gas */
  refundReceiver?: `0x${string}`;
}

/** Response from submitting a transaction to Safe */
export interface SafeTransactionResponse {
  /** The Safe transaction hash (different from on-chain tx hash) */
  safeTxHash: `0x${string}`;
}

/**
 * Supported Safe SDK event names used for transaction lifecycle tracking.
 */
export type SafeEventName =
  | "SAFE_TX_CONFIRMED"
  | "SAFE_TX_REJECTED"
  | "TRANSACTION_CONFIRMED"
  | "TRANSACTION_REJECTED"
  | "MESSAGE_CONFIRMED"
  | "MESSAGE_REJECTED";

/** Type guard for SafeTransactionRequest */
export function isSafeTransactionRequest(
  obj: unknown,
): obj is SafeTransactionRequest {
  if (!obj || typeof obj !== "object") return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.to === "string" &&
    typeof r.value === "string" &&
    typeof r.data === "string"
  );
}
