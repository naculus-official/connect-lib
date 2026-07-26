export const CONNECTOR_ERROR_MESSAGES = {
  SESSION_EXPIRED: "Session expired. Please reconnect your wallet.",
  NO_ACCOUNT_SIGNING:
    "No account found for signing. Please reconnect your wallet.",
  NO_ACCOUNT_TX:
    "No account found for transaction. Please reconnect your wallet.",
  NO_ACCOUNTS: "No accounts available. Please reconnect your wallet.",
  INVALID_INPUT: "Invalid input.",
  MISSING_TX: "Missing transaction.",
  MISSING_MESSAGE: "Missing message parameter.",
  USER_REJECTED: "Operation rejected by user.",
  TX_FAILED: "Transaction failed.",
  CHAIN_UNSUPPORTED: "Chain not supported.",
  METHOD_NOT_ALLOWED: "Method not allowed.",
  WALLET_UNAVAILABLE: "Wallet not available.",
} as const;

export type WalletErrorCode =
  | "wallet_unavailable"
  | "user_rejected"
  | "deeplink_timeout"
  | "session_expired"
  | "intent_expired"
  | "namespace_mismatch"
  | "chain_unsupported"
  | "method_not_allowed"
  | "method_unsupported"
  | "signature_rejected"
  | "tx_failed"
  | "invalid_proposal"
  | "invalid_input"
  | "siwx_error"
  | "no_active_session"
  | "chain_switch_rejected"
  | "invalid_chain"
  | "no_solana_session"
  | "unsupported_chain"
  | "fee_rpc_error"
  | "rpc_error"
  | "session_not_found"
  | "session_inactive"
  | "session_scope_exceeded"
  | "invalid_scope"
  | "bad_stuff"
  | "no_rpc"
  | "not_initialized"
  | "no_wallet"
  | "storage_unavailable"
  | "terminated"
  | "test_code"
  | "timeout"
  | "worker_error"
  | "decryption_failed"
  | "storage_quota"
  | "storage_read_failed"
  | "storage_write_failed"
  | "storage_clear_failed"
  | "session_decrypt_failed"
  | "crypto_worker_error"
  | "simulation_unavailable"
  | "derivation_failed"
  | "invalid_fee"
  | "invalid_key"
  | "invalid_mnemonic"
  | "invalid_multiplier"
  | "rpc_timeout"
  | "simulation_malicious"
  | "simulation_reverted"
  | "fee_estimation_failed";

export class WalletError extends Error {
  code: WalletErrorCode;
  details?: unknown;
  cause?: unknown;

  constructor(code: WalletErrorCode, message?: string, details?: unknown, cause?: unknown) {
    super(message ?? code);
    this.name = "WalletError";
    this.code = code;
    if (details instanceof Error) {
      this.cause = details;
      this.details = details;
    } else {
      this.details = details;
    }
    if (cause) this.cause = cause;
  }
}

export function isWalletError(
  e: unknown,
  code?: WalletErrorCode,
): e is WalletError {
  if (!e || typeof e !== "object") {
    return false;
  }

  const candidate = e as WalletError;
  if (candidate.name !== "WalletError" || typeof candidate.code !== "string") {
    return false;
  }

  return code ? candidate.code === code : true;
}
