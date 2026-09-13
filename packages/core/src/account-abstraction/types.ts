/**
 * ERC-4337 Account Abstraction Types
 *
 * Defines the type hierarchy for Smart Contract Wallet management,
 * UserOperation construction, Paymaster integration, and batch transactions.
 *
 * @see docs/features/account-abstraction.md
 */

// ─── Hex Helpers ────────────────────────────────────────────────────────

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type UserOperationVersion = "0.6" | "0.7";

// ─── UserOperation (ERC-4337 v0.7) ──────────────────────────────────────

/**
 * ERC-4337 UserOperation structure.
 * Follows the v0.7 spec: accountGasLimits replaces separate callGasLimit/verificationGasLimit,
 * and paymasterPostOpGasLimit is bundled into paymasterData.
 */
export interface UserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  /** ABI-encoded callGasLimit + verificationGasLimit (v0.7) */
  accountGasLimits: Hex;
  /** ABI-encoded maxPriorityFeePerGas + maxFeePerGas (v0.7) */
  gasFees?: Hex;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** ABI-encoded paymaster + paymasterVerificationGasLimit + paymasterPostOpGasLimit + paymasterData */
  paymasterAndData: Hex;
  signature: Hex;
}

// ─── Call (Single Operation within a UserOp) ────────────────────────────

export interface Call {
  /** Target contract address */
  to: Address;
  /** Value in wei (0n for pure function calls) */
  value: bigint;
  /** Encoded calldata */
  data: Hex;
}

// ─── Smart Account Configuration ────────────────────────────────────────

/**
 * Smart account implementations this module knows about.
 *
 * Only "simple" (eth-infinitism SimpleAccount) is implemented; the others are
 * named so a caller's intent survives in config and so adding one is a change
 * in one place. Passing any of them today throws `aa_unknown_account_type`
 * rather than silently deriving an address from the SimpleAccount factory,
 * which would be an address the user could send funds to and never control.
 *
 * None of these verifies a P-256 signature, which is why a passkey cannot own
 * one — that needs a WebAuthn validator or the RIP-7212 precompile.
 */
export type AccountType = "simple" | "light" | "kernel" | "safe";

export interface SmartAccountConfig {
  /** Owner address (typically an EOA) */
  owner: Address;
  /** Optional salt for CREATE2 deterministic address */
  salt?: bigint;
  /** Account implementation type */
  accountType: AccountType;
  /** ERC-4337 EntryPoint contract address */
  entryPoint: Address;
  /** Chain ID (CAIP-2 format, e.g. "eip155:1") */
  chainId: string;
}

export interface SmartAccountInfo {
  /** Deterministic counterfactual address */
  address: Address;
  /** Whether the contract is deployed on-chain */
  isDeployed: boolean;
  /** Account type */
  accountType: AccountType;
  /** Owner address */
  owner: Address;
}

// ─── Bundler / RPC Types ────────────────────────────────────────────────

export interface BundlerClient {
  /** RPC endpoint URL */
  url: string;
  /** Optional API key for authenticated bundler services */
  apiKey?: string;
}

export interface UserOperationResponse {
  /** UserOp hash (returned by eth_sendUserOperation) */
  userOpHash: Hex;
  /** Smart account sender address */
  sender: Address;
  /** UserOp nonce */
  nonce: bigint;
}

export interface UserOperationReceipt {
  userOpHash: Hex;
  entryPoint: Address;
  sender: Address;
  nonce: bigint;
  paymaster?: Address;
  actualGasUsed: bigint;
  actualGasCost: bigint;
  success: boolean;
  /** Transaction receipt of the HandleOps bundle */
  transactionHash: Hex;
  /** Array of logs emitted during execution */
  logs: Log[];
}

export interface Log {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface UserOperationGasEstimate {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  /** v0.7 bundlers may return accountGasLimits */
  accountGasLimits?: Hex;
  /** v0.7 paymaster validation gas returned when a paymaster is present. */
  paymasterVerificationGasLimit?: bigint;
}

// ─── Paymaster Types ────────────────────────────────────────────────────

export type PaymasterType = "verifying" | "token" | "sponsor" | "custom";

export interface PaymasterConfig {
  type: PaymasterType;
  /** Paymaster RPC URL */
  url: string;
  /** Optional policy configuration */
  policy?: {
    /** Whitelisted dApp origins */
    allowedDapps?: string[];
    /** ERC-20 token address for token paymaster */
    token?: Address;
    /** Maximum gas per UserOperation */
    maxGasPerUserOp?: bigint;
  };
}

export interface PaymasterData {
  /** The paymasterAndData hex to inject into UserOperation */
  paymasterAndData: Hex;
  /** Human-readable sponsorship info */
  sponsorInfo?: string;
}

/**
 * Chain and EntryPoint context for the ERC-7677 paymaster web-service API.
 * Supplying this context makes the request standards-based; omitting it keeps
 * the legacy `pm_sponsorUserOperation` compatibility path.
 */
export interface PaymasterRequestOptions {
  entryPoint: Address;
  chainId: number | bigint;
  version?: UserOperationVersion;
  context?: Record<string, unknown>;
}

export interface Paymaster {
  /** Get paymaster data for a UserOperation */
  getPaymasterData(
    userOp: Partial<UserOperation>,
    request?: PaymasterRequestOptions,
  ): Promise<PaymasterData>;
  /** Verify if a UserOperation is eligible for sponsorship */
  isSponsored(userOp: Partial<UserOperation>): Promise<boolean>;
}

// ─── Send UserOperation Options ─────────────────────────────────────────

export interface SendUserOpOptions {
  /** Optional gas overrides */
  gasOverrides?: {
    callGasLimit?: bigint;
    verificationGasLimit?: bigint;
    preVerificationGas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  };
  /** Optional paymaster configuration */
  paymaster?: PaymasterConfig;
  /** Whether to skip deploy (for already deployed accounts) */
  skipDeploy?: boolean;
}

// ─── EntryPoint Address Constants ───────────────────────────────────────

/**
 * ERC-4337 EntryPoint v0.6 contract addresses.
 * https://github.com/eth-infinitism/account-abstraction
 */
export const ENTRY_POINT_V0_6: Address =
  "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

/**
 * ERC-4337 EntryPoint v0.7 contract address (same on all chains).
 */
export const ENTRY_POINT_V0_7: Address =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

/**
 * Default EntryPoint address (v0.7).
 */
export const DEFAULT_ENTRY_POINT = ENTRY_POINT_V0_7;

// ─── SimpleAccount Factory Addresses ────────────────────────────────────

/**
 * SimpleAccount Factory v0.6 address (eth-infinitism).
 * This factory is coupled to EntryPoint v0.6 through its immutable account
 * implementation; it must not be used with a v0.7 EntryPoint.
 */
export const SIMPLE_ACCOUNT_FACTORY_V06: Address =
  "0x9406Cc6185a346906296840746125a0E44976454";

/**
 * SimpleAccount Factory v0.7 address (eth-infinitism).
 * This factory is coupled to EntryPoint v0.7 through its immutable account
 * implementation; it must not be used with a v0.6 EntryPoint.
 */
export const SIMPLE_ACCOUNT_FACTORY_V07: Address =
  "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985";

/** Default SimpleAccount factory for the default EntryPoint v0.7. */
export const SIMPLE_ACCOUNT_FACTORY = SIMPLE_ACCOUNT_FACTORY_V07;

// ─── Gas Budget Defaults ────────────────────────────────────────────────

/** Default call gas limit for UserOperations */
export const DEFAULT_CALL_GAS_LIMIT = 100_000n;

/** Default verification gas limit for UserOperations */
export const DEFAULT_VERIFICATION_GAS_LIMIT = 100_000n;

/** Default pre-verification gas for UserOperations */
export const DEFAULT_PRE_VERIFICATION_GAS = 50_000n;

// ─── Chain AA Support ───────────────────────────────────────────────────

/**
 * Chains known to support ERC-4337 AA (EntryPoint deployed).
 * Keyed by CAIP-2 chain ID.
 */
export const AA_SUPPORTED_CHAINS: Record<
  string,
  { entryPoint: Address; factory: Address; version: UserOperationVersion }
> = {
  "eip155:1": {
    entryPoint: ENTRY_POINT_V0_7,
    factory: SIMPLE_ACCOUNT_FACTORY_V07,
    version: "0.7",
  }, // Ethereum
  "eip155:137": {
    entryPoint: ENTRY_POINT_V0_6,
    factory: SIMPLE_ACCOUNT_FACTORY_V06,
    version: "0.6",
  }, // Polygon
  "eip155:10": {
    entryPoint: ENTRY_POINT_V0_6,
    factory: SIMPLE_ACCOUNT_FACTORY_V06,
    version: "0.6",
  }, // Optimism
  "eip155:42161": {
    entryPoint: ENTRY_POINT_V0_6,
    factory: SIMPLE_ACCOUNT_FACTORY_V06,
    version: "0.6",
  }, // Arbitrum
  "eip155:8453": {
    entryPoint: ENTRY_POINT_V0_7,
    factory: SIMPLE_ACCOUNT_FACTORY_V07,
    version: "0.7",
  }, // Base
  "eip155:11155111": {
    entryPoint: ENTRY_POINT_V0_7,
    factory: SIMPLE_ACCOUNT_FACTORY_V07,
    version: "0.7",
  }, // Sepolia
};
