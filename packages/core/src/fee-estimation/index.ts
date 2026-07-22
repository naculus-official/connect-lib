/**
 * Fee Estimation Module Entry Point
 *
 * @see SRS-001
 */

export {
  parseBigInt,
  toDecString,
  toHumanReadable,
} from "./conversion";
export type { FeeEstimationErrorCode } from "./errors";

export {
  FEE_ERROR_MESSAGES,
  FeeEstimationError,
  isFeeEstimationError,
} from "./errors";
export {
  clearChainFeeEstimators,
  estimateFees,
  estimateMaxPriorityFeePerGas,
  getChainId,
  getFeeData,
  getGasPrice,
  getLatestBaseFee,
  registerChainFeeEstimator,
  unregisterChainFeeEstimator,
} from "./feeEstimation";
export type {
  ChainFeeEstimator,
  ChainFeeSupport,
  FeeEstimationConfig,
  FeeTypeStrategy,
  FeeValues,
  FeeValuesEIP1559,
  FeeValuesLegacy,
} from "./types";
