/**
 * Error types for Account Abstraction (ERC-4337) operations.
 *
 * Independent error class — core package does not depend on wallet-engine.
 */

export type AAErrorCode =
  | "aa_unsupported_chain" // Chain does not support ERC-4337
  | "aa_no_bundler" // No bundler URL configured
  | "aa_no_paymaster" // Paymaster not configured
  | "aa_no_entry_point" // EntryPoint address not found for chain
  | "aa_no_factory" // Factory address not found for chain
  | "aa_account_not_deployed" // Smart account not deployed
  | "aa_account_already_deployed" // Smart account already deployed
  | "aa_invalid_owner" // Invalid owner address
  | "aa_user_op_failed" // UserOperation failed on chain
  | "aa_user_op_rejected" // UserOperation rejected by bundler
  | "aa_estimation_failed" // Gas estimation failed
  | "aa_signature_failed" // UserOperation signing failed
  | "aa_rpc_error" // RPC call error
  | "aa_invalid_input" // Invalid input parameters
  | "aa_unknown_account_type" // Unsupported account type
  | "aa_no_calls" // No calls provided for UserOperation
  | "aa_encode_error" // ABI encode/decode error
  | "aa_paymaster_rejected" // Paymaster declined sponsorship
  | "aa_receipt_timeout" // UserOperation receipt not found after max retries
  | "aa_unknown_error"; // Catch-all

/** Human-readable messages for each error code */
export const AA_ERROR_MESSAGES: Record<AAErrorCode, string> = {
  aa_unsupported_chain: "Chain does not support ERC-4337 account abstraction.",
  aa_no_bundler:
    "Bundler URL not configured. Provide a bundler URL or bundlerClient.",
  aa_no_paymaster: "Paymaster not configured.",
  aa_no_entry_point: "EntryPoint contract address not found for this chain.",
  aa_no_factory: "Account factory contract address not found for this chain.",
  aa_account_not_deployed: "Smart account is not deployed on-chain.",
  aa_account_already_deployed: "Smart account is already deployed.",
  aa_invalid_owner: "Invalid owner address.",
  aa_user_op_failed: "UserOperation failed during execution.",
  aa_user_op_rejected: "UserOperation was rejected by the bundler.",
  aa_estimation_failed: "Failed to estimate gas for UserOperation.",
  aa_signature_failed: "Failed to sign UserOperation.",
  aa_rpc_error: "RPC call failed.",
  aa_invalid_input: "Invalid input parameters.",
  aa_unknown_account_type: "Unsupported account type.",
  aa_no_calls: "At least one call is required for the UserOperation.",
  aa_encode_error: "ABI encode/decode error.",
  aa_paymaster_rejected: "Paymaster declined to sponsor this UserOperation.",
  aa_receipt_timeout: "UserOperation receipt not found after maximum retries.",
  aa_unknown_error: "An unknown error occurred.",
};

export class AccountAbstractionError extends Error {
  constructor(
    public readonly code: AAErrorCode,
    message?: string,
    public readonly cause?: unknown,
  ) {
    super(message ?? AA_ERROR_MESSAGES[code]);
    this.name = "AccountAbstractionError";
  }

  hasCode(code: AAErrorCode): boolean {
    return this.code === code;
  }
}

/** Type guard */
export function isAAError(e: unknown): e is AccountAbstractionError {
  return e instanceof AccountAbstractionError;
}
