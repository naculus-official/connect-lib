/**
 * Session-Manager-Specific Error Codes
 *
 * Extends WalletError with session-specific error codes.
 *
 * @see SRS-009 §8
 */

import { WalletError } from "../errors";

export type SessionErrorCode =
  | "no_active_session"
  | "chain_switch_rejected"
  | "chain_unsupported"
  | "fee_rpc_error"
  | "method_unsupported"
  | "invalid_chain";

export const SESSION_ERROR_MESSAGES: Record<SessionErrorCode, string> = {
  no_active_session: "No active session. Please connect your wallet first.",
  chain_switch_rejected: "Chain switch was rejected by the user.",
  chain_unsupported: "The requested chain is not supported by this wallet.",
  fee_rpc_error: "Failed to fetch fee estimation. Using cached values.",
  method_unsupported: "This method is not supported by the current connector.",
  invalid_chain:
    "Invalid chain ID format. Expected CAIP-2 format (e.g., eip155:1).",
};

/**
 * Create a WalletError with session-manager-specific error code.
 */
export function createSessionError(
  code: SessionErrorCode,
  details?: unknown,
): WalletError {
  return new WalletError(code, SESSION_ERROR_MESSAGES[code], details);
}
