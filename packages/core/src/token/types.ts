/**
 * Token Configuration — uniquely identifies an ERC-20 token on a specific chain.
 */
export interface TokenConfig {
  /** ERC-20 token contract address */
  address: `0x${string}`;
  /** Chain ID (decimal, e.g. 1 for Ethereum) */
  chainId: number;
  /** Optional cached decimals (skip RPC call when provided) */
  decimals?: number;
}

/**
 * Token Metadata — fetched on-chain via name(), symbol(), decimals(), totalSupply().
 */
export interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}

/**
 * Parameters for building an ERC-20 transfer transaction.
 */
export interface ERC20TransferTxParams {
  token: TokenConfig;
  from: `0x${string}`;
  to: `0x${string}`;
  /** Amount in human-readable units (e.g. "1.50" for 1.5 USDC) */
  amount: string | bigint;
}

/**
 * Parameters for building an ERC-20 approve transaction.
 */
export interface ERC20ApproveTxParams {
  token: TokenConfig;
  owner: `0x${string}`;
  spender: `0x${string}`;
  amount: string | bigint;
}

/**
 * Parameters for building an ERC-20 transferFrom transaction.
 */
export interface ERC20TransferFromTxParams {
  token: TokenConfig;
  from: `0x${string}`;
  to: `0x${string}`;
  amount: string | bigint;
}

/**
 * RPC call options — useful for overriding the default RPC URL.
 */
export interface ERC20CallOptions {
  /** Override RPC URL (default: derived from chainId via config) */
  rpcUrl?: string;
}
