/**
 * Transaction Builder
 *
 * Provides a unified transaction construction interface for wallet-engine.
 * Handles fee field resolution, validation, cleanup of conflicting fields,
 * and building a complete transaction request ready for signing.
 */

import type { ResolvedFeeOptions } from "./fee-oracle";
import type { TransactionRequest } from "./signers/types";

/**
 * Build a complete transaction request by applying resolved fee options.
 *
 * @param tx - Base transaction request
 * @param resolvedFees - Resolved fee options from fee oracle
 * @returns Complete transaction request with fee fields set and conflicts cleaned
 */
export function buildTransaction(
  tx: TransactionRequest,
  resolvedFees: ResolvedFeeOptions,
): TransactionRequest {
  const built: TransactionRequest = {
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gas: tx.gas,
    nonce: tx.nonce,
    chainId: tx.chainId,
  };

  if (resolvedFees.type === "eip1559") {
    built.maxFeePerGas = resolvedFees.maxFeePerGas;
    built.maxPriorityFeePerGas = resolvedFees.maxPriorityFeePerGas;
    // Clear legacy fields to avoid encoding ambiguity
    built.gasPrice = undefined;
  } else {
    built.gasPrice = resolvedFees.gasPrice;
    // Clear EIP-1559 fields to avoid encoding ambiguity
    built.maxFeePerGas = undefined;
    built.maxPriorityFeePerGas = undefined;
  }

  return built;
}

/**
 * Clone a TransactionRequest while preserving fee fields for bumping.
 * Clears previous fee values so the new tx can get fresh estimates.
 */
export function cloneForBumping(
  originalTx: TransactionRequest,
): TransactionRequest {
  return {
    to: originalTx.to,
    value: originalTx.value,
    data: originalTx.data,
    gas: originalTx.gas,
    nonce: originalTx.nonce,
    chainId: originalTx.chainId,
    // Intentionally NOT copying fee fields — bump will resolve fresh values
  };
}

/**
 * Get the chain ID as a number from a transaction request or CAIP-2 string.
 */
export function resolveChainId(
  tx: TransactionRequest,
  caipChainId: string,
): number {
  if (tx.chainId !== undefined) return tx.chainId;
  return parseInt(caipChainId.replace("eip155:", ""), 10);
}
