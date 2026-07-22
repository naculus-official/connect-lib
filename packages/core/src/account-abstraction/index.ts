/**
 * Account Abstraction (ERC-4337) Module
 *
 * Smart Contract Wallet management, UserOperation construction & signing,
 * Paymaster integration, and batch transactions for ERC-4337.
 *
 * @module account-abstraction
 */

export {
  AA_ERROR_MESSAGES,
  type AAErrorCode,
  AccountAbstractionError,
  isAAError,
} from "./errors";
export {
  createPaymasterService,
  PaymasterService,
  type PaymasterServiceConfig,
} from "./paymaster";
export {
  decodeGasLimits,
  encodeGasLimits,
  SmartAccountManager,
  type SmartAccountManagerConfig,
} from "./SmartAccountManager";
export {
  AA_SUPPORTED_CHAINS,
  type AccountType,
  type Address,
  type BundlerClient,
  type Call,
  DEFAULT_CALL_GAS_LIMIT,
  DEFAULT_ENTRY_POINT,
  DEFAULT_PRE_VERIFICATION_GAS,
  DEFAULT_VERIFICATION_GAS_LIMIT,
  ENTRY_POINT_V0_6,
  ENTRY_POINT_V0_7,
  type Hex,
  type Paymaster,
  type PaymasterConfig,
  type PaymasterData,
  type PaymasterType,
  type SendUserOpOptions,
  SIMPLE_ACCOUNT_FACTORY,
  type SmartAccountConfig,
  type SmartAccountInfo,
  type UserOperation,
  type UserOperationGasEstimate,
  type UserOperationReceipt,
  type UserOperationResponse,
} from "./types";
export {
  buildCallData,
  buildUserOperation,
  estimateUserOperationGas,
  hashUserOperation,
  sendUserOperation,
  signUserOperation,
} from "./user-operation";
