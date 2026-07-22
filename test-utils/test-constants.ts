/**
 * Centralized test constants — single source of truth for test values.
 *
 * Rule: NO hardcoded string/number in test files. Import from here.
 */

import {
  EIP155_ARBITRUM,
  EIP155_BASE,
  EIP155_MAINNET,
  EIP155_OPTIMISM,
  EIP155_POLYGON,
  EIP155_SEPOLIA,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  XRPL_MAINNET,
  XRPL_TESTNET,
} from "../packages/core/src/constants";

// ── Addresses ──────────────────────────────────────────────────────

const addr = (hex: string) => hex as `0x${string}`;

export const ADDRESSES = {
  ZERO: addr("0x0000000000000000000000000000000000000000"),
  ALICE: addr("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
  BOB: addr("0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"),
  CHARLIE: addr("0x" + "c".repeat(40)),
  USDC_MAINNET: addr("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  USDT_MAINNET: addr("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
  WETH_MAINNET: addr("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
  SOLANA: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb",
  XRPL_CLASSIC: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",

  /** Generic test address: 0x1234...5678 (40-char) */
  TEST_1: addr("0x1234567890abcdef1234567890abcdef12345678"),
  /** Generic test address: 0x1234...7890 (40-char, used in walletconnect/safe/embedded) */
  TEST_2: addr("0x1234567890123456789012345678901234567890"),
  /** Mock Safe multisig address */
  SAFE_MULTISIG: addr("0x1234567890123456789012345678901234567890"),
  /** Mock Safe recipient A */
  SAFE_RECIPIENT_A: addr("0x" + "a".repeat(40)),
  /** Mock Safe recipient B */
  SAFE_RECIPIENT_B: addr("0x" + "b".repeat(40)),
  /** Mock Safe implementation */
  SAFE_IMPL: addr("0x" + "c".repeat(40)),
  /** Mock Safe transaction hash (64 hex) */
  SAFE_TX_HASH: "0x" + "d".repeat(64),
  /** Coinbase test recipient */
  COINBASE_RECIPIENT: addr("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"),
  /** Mock EIP-6963 injected wallet address */
  EIP6963_ACCOUNT: addr("0x1234567890abcdef1234567890abcdef12345678"),
} as const;

// ── Chain IDs ──────────────────────────────────────────────────────

export const CHAINS = {
  EVM_MAINNET: EIP155_MAINNET,
  EVM_SEPOLIA: EIP155_SEPOLIA,
  EVM_POLYGON: EIP155_POLYGON,
  EVM_ARBITRUM: EIP155_ARBITRUM,
  EVM_OPTIMISM: EIP155_OPTIMISM,
  EVM_BASE: EIP155_BASE,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
  XRPL_MAINNET,
  XRPL_TESTNET,
} as const;

// ── Decimal counts ─────────────────────────────────────────────────

export const DECIMALS = {
  ETH: 18,
  USDC: 6,
  USDT: 6,
  SOL: 9,
  XRP: 6,
  WBTC: 8,
  ZERO: 0,
  MAX_ERC20: 255,
} as const;

// ── Financial amounts (human-readable + raw) ───────────────────────

export const AMOUNTS = {
  ONE_ETH: "1",
  DUST_WEI: "0.000000000000000001",
  ONE_USDC: "1",
  ONE_DOLLAR_USDC: "1",
  ONE_SOL: "1",
  ONE_XRP: "1",
  TEN_THOUSAND_USDC: "10000",
  ONE_MILLION_USDC: "1000000",
  MAX_UINT256: (1n << 256n) - 1n,
  MAX_UINT128: (1n << 128n) - 1n,
  MAX_SAFE_INTEGER: BigInt(Number.MAX_SAFE_INTEGER),
  BEYOND_MAX_SAFE: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
} as const;

// ── Gas & Fee values ───────────────────────────────────────────────

export const GAS = {
  STANDARD_PRICE_GWEI: 50_000_000_000n,
  STANDARD_LIMIT: 210_000n,
  HIGH_PRICE_GWEI: 500_000_000_000n,
  LOW_PRICE_GWEI: 1_000_000_000n,
  EXTREME_PRICE: 1_000_000_000_000_000_000_000n, // 10^12 gwei
} as const;

// ── Session values ─────────────────────────────────────────────────

export const SESSION = {
  TIMEOUT_MS: 5 * 60 * 1000,
  AUTO_RECONNECT_MS: 30 * 1000,
  NAMESPACES: {
    EIP155: "eip155" as const,
    SOLANA: "solana" as const,
    XRPL: "xrpl" as const,
  },
} as const;

// ── WalletConnect ──────────────────────────────────────────────────

export const WALLETCONNECT = {
  PROJECT_ID: "test-project-id",
  METADATA: {
    name: "Test DApp",
    description: "Test Description",
    url: "https://test.dapp.com",
    icons: ["https://test.dapp.com/icon.png"],
  },
} as const;

// ── Expected ABI selectors (known values from ERC20) ───────────────

export const ABI_SELECTORS = {
  balanceOf: "0x70a08231",
  transfer: "0xa9059cbb",
  approve: "0x095ea7b3",
  allowance: "0xdd62ed3e",
  transferFrom: "0x23b872dd",
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  chainlinkLatestRoundData: "0xfeaf968c",
} as const;
