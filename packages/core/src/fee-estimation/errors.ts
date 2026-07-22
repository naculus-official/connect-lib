/**
 * Fee Estimation Error
 *
 * Thrown when all fee estimation strategies have failed.
 */

export type FeeEstimationErrorCode =
  | "fee_estimation_failed"
  | "fee_chain_not_supported"
  | "fee_rpc_error";

export class FeeEstimationError extends Error {
  code: FeeEstimationErrorCode;
  details?: unknown;

  constructor(
    code: FeeEstimationErrorCode,
    message?: string,
    details?: unknown,
  ) {
    super(message ?? code);
    this.name = "FeeEstimationError";
    this.code = code;
    this.details = details;
  }
}

export function isFeeEstimationError(
  e: unknown,
  code?: FeeEstimationErrorCode,
): e is FeeEstimationError {
  if (!e || typeof e !== "object") {
    return false;
  }

  const candidate = e as FeeEstimationError;
  if (
    candidate.name !== "FeeEstimationError" ||
    typeof candidate.code !== "string"
  ) {
    return false;
  }

  return code ? candidate.code === code : true;
}

/** Error message constants */
export const FEE_ERROR_MESSAGES = {
  ESTIMATION_FAILED: "Fee estimation failed after all strategies exhausted.",
  CHAIN_NOT_SUPPORTED: "Chain not supported for fee estimation.",
  RPC_ERROR: "RPC call failed during fee estimation.",
} as const;
