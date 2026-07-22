/**
 * Minimal ERC-20 ABI — only the 9 function selectors we need.
 *
 * Designed to be used with viem's readContract / simulateContract,
 * or with our manual ABI encoding for raw transaction building.
 *
 * Specifications:
 *   - EIP-20: https://eips.ethereum.org/EIPS/eip-20
 *   - Solidity ABI: https://docs.soliditylang.org/en/latest/abi-spec.html
 */

export type AbiFunction = {
  name: string;
  type: "function";
  stateMutability: "view" | "nonpayable" | "payable";
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
};

/** Full minimal ABI as const for viem compatibility */
export const ERC20_MIN_ABI = [
  // ── State-changing ──────────────────────────────────
  {
    name: "transfer",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    name: "approve",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    name: "transferFrom",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  // ── Read-only ───────────────────────────────────────
  {
    name: "allowance",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "remaining", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "decimals", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "symbol", type: "string" }],
  },
  {
    name: "name",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "name", type: "string" }],
  },
  {
    name: "totalSupply",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "totalSupply", type: "uint256" }],
  },
] as const;

/**
 * Canonical function signatures (for manual keccak256-based encoding).
 */
export const ERC20_FUNCTION_SIGNATURES = {
  transfer: "transfer(address,uint256)",
  approve: "approve(address,uint256)",
  transferFrom: "transferFrom(address,address,uint256)",
  allowance: "allowance(address,address)",
  balanceOf: "balanceOf(address)",
  decimals: "decimals()",
  symbol: "symbol()",
  name: "name()",
  totalSupply: "totalSupply()",
} as const;

/**
 * Type helper — extract the ABI items for a given function name.
 */
export type AbiItem<TName extends (typeof ERC20_MIN_ABI)[number]["name"]> =
  (typeof ERC20_MIN_ABI)[number] & { name: TName };
