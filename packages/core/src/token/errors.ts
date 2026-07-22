/**
 * Unified error handling for ERC-20 token operations.
 *
 * ERC20TokenError is independent of WalletError — the core package
 * shouldn't depend on wallet-engine. Wallet-engine integration wraps
 * these into WalletError when needed.
 */

export type ERC20TokenErrorCode =
  | "token_not_deployed" // Contract has no code on target chain
  | "invalid_address" // from/to/spender is not a valid address
  | "invalid_amount" // Amount format error (NaN, negative, too many decimals)
  | "insufficient_allowance" // allowance(owner, spender) < amount
  | "insufficient_balance" // balanceOf(owner) < amount
  | "decimals_fetch_failed" // Cannot read decimals from chain
  | "token_info_fetch_failed" // Cannot read token metadata
  | "rpc_error" // Underlying RPC error
  | "encoding_error" // ABI encoding failure
  | "unknown_error"; // Catch-all

/** Human-readable messages for each error code */
export const ERC20_TOKEN_ERROR_MESSAGES: Record<ERC20TokenErrorCode, string> = {
  token_not_deployed: "Token contract is not deployed on this chain.",
  invalid_address: "Address is not a valid EVM address.",
  invalid_amount: "Amount is invalid.",
  insufficient_allowance:
    "Insufficient allowance. Please approve the spender first.",
  insufficient_balance: "Insufficient token balance.",
  decimals_fetch_failed: "Failed to fetch token decimals from chain.",
  token_info_fetch_failed: "Failed to fetch token metadata from chain.",
  rpc_error: "RPC error occurred.",
  encoding_error: "Failed to encode ABI data.",
  unknown_error: "An unknown error occurred.",
};

export class ERC20TokenError extends Error {
  constructor(
    public readonly code: ERC20TokenErrorCode,
    message?: string,
    public readonly cause?: unknown,
  ) {
    super(message ?? ERC20_TOKEN_ERROR_MESSAGES[code]);
    this.name = "ERC20TokenError";
  }

  /** Check if this error has a specific code */
  hasCode(code: ERC20TokenErrorCode): boolean {
    return this.code === code;
  }
}

/** Type guard */
export function isERC20TokenError(e: unknown): e is ERC20TokenError {
  return e instanceof ERC20TokenError;
}
