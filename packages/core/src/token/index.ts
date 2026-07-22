/**
 * Token Module — ERC-20 transaction building, amount formatting, and queries.
 *
 * @see SRS-007
 */

export type { AbiItem } from "./abi";
export { ERC20_FUNCTION_SIGNATURES, ERC20_MIN_ABI } from "./abi";
export {
  abiEncodeAddress,
  abiEncodeFunctionCall,
  abiEncodeUint256,
  abiFunctionSelector,
  ERC20TokenHelper,
} from "./ERC20TokenHelper";
export type { ERC20TokenErrorCode } from "./errors";

export { ERC20TokenError, isERC20TokenError } from "./errors";
export type {
  ERC20ApproveTxParams,
  ERC20CallOptions,
  ERC20TransferFromTxParams,
  ERC20TransferTxParams,
  TokenConfig,
  TokenInfo,
} from "./types";
export { formatUnits, parseUnits } from "./units";
