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
  | "fee_rpc_error";

export class WalletError extends Error {
  code: WalletErrorCode;
  details?: unknown;

  constructor(code: WalletErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "WalletError";
    this.code = code;
    this.details = details;
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
