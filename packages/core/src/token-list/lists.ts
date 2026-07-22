/**
 * Built-in default token lists.
 *
 * Only includes the most common tokens to keep the bundle small.
 * Full lists (Uniswap, Coinbase, Jupiter) are loaded from remote sources.
 */

import type { TokenListEntry, TokenListSource } from "./types";

/**
 * Popular Ethereum mainnet tokens (chainId = 1).
 */
export const ETHEREUM_MAINNET_TOKENS: TokenListEntry[] = [
  {
    chainId: 1,
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    name: "Wrapped Ether",
    symbol: "WETH",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/ethereum-eth-logo.png",
    tags: ["wrapped", "gas-token"],
  },
  {
    chainId: 1,
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 1,
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    name: "Tether USD",
    symbol: "USDT",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/tether-usdt-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 1,
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    name: "Dai Stablecoin",
    symbol: "DAI",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/multi-collateral-dai-dai-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 1,
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    name: "Wrapped Bitcoin",
    symbol: "WBTC",
    decimals: 8,
    logoURI: "https://cryptologos.cc/logos/wrapped-bitcoin-wbtc-logo.png",
    tags: ["wrapped", "btc"],
  },
  {
    chainId: 1,
    address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    name: "Aave",
    symbol: "AAVE",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/aave-aave-logo.png",
    tags: ["defi"],
  },
  {
    chainId: 1,
    address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    name: "Uniswap",
    symbol: "UNI",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/uniswap-uni-logo.png",
    tags: ["defi"],
  },
  {
    chainId: 1,
    address: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    name: "ChainLink Token",
    symbol: "LINK",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/chainlink-link-logo.png",
    tags: ["oracle"],
  },
  {
    chainId: 1,
    address: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
    name: "Frax",
    symbol: "FRAX",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/frax-frax-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 1,
    address: "0x4Fabb145d64652a948d72533023f6E7A623C7C53",
    name: "Binance USD",
    symbol: "BUSD",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/binance-usd-busd-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 1,
    address: "0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b",
    name: "Cronos Token",
    symbol: "CRO",
    decimals: 8,
    logoURI: "https://cryptologos.cc/logos/crypto-com-coin-cro-logo.png",
    tags: [],
  },
  {
    chainId: 1,
    address: "0x3845badAde8e6dFF049820680d1F14bD3903a5d0",
    name: "The Sandbox",
    symbol: "SAND",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/the-sandbox-sand-logo.png",
    tags: ["gaming"],
  },
  {
    chainId: 1,
    address: "0x0D8775F648430679A709E98d2b0Cb6250d2887EF",
    name: "Basic Attention Token",
    symbol: "BAT",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/basic-attention-token-bat-logo.png",
    tags: ["privacy"],
  },
  {
    chainId: 1,
    address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
    name: "Polygon",
    symbol: "MATIC",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/polygon-matic-logo.png",
    tags: ["layer2"],
  },
];

/**
 * Popular Polygon (chainId 137) tokens.
 */
export const POLYGON_TOKENS: TokenListEntry[] = [
  {
    chainId: 137,
    address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    name: "Wrapped MATIC",
    symbol: "WMATIC",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/polygon-matic-logo.png",
    tags: ["wrapped", "gas-token"],
  },
  {
    chainId: 137,
    address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    name: "USD Coin (PoS)",
    symbol: "USDC",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 137,
    address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    name: "Tether USD (PoS)",
    symbol: "USDT",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/tether-usdt-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 137,
    address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    name: "Dai Stablecoin (PoS)",
    symbol: "DAI",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/multi-collateral-dai-dai-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 137,
    address: "0x1BFd67037B42Cf73acF2047067bd4F2C47D9BfD6",
    name: "Wrapped BTC (PoS)",
    symbol: "WBTC",
    decimals: 8,
    logoURI: "https://cryptologos.cc/logos/wrapped-bitcoin-wbtc-logo.png",
    tags: ["wrapped", "btc"],
  },
  {
    chainId: 137,
    address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    name: "Wrapped Ether (PoS)",
    symbol: "WETH",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/ethereum-eth-logo.png",
    tags: ["wrapped"],
  },
  {
    chainId: 137,
    address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
    name: "ChainLink Token (PoS)",
    symbol: "LINK",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/chainlink-link-logo.png",
    tags: ["oracle"],
  },
];

/**
 * Optimism (chainId 10) tokens.
 */
export const OPTIMISM_TOKENS: TokenListEntry[] = [
  {
    chainId: 10,
    address: "0x4200000000000000000000000000000000000006",
    name: "Wrapped Ether",
    symbol: "WETH",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/ethereum-eth-logo.png",
    tags: ["wrapped", "gas-token"],
  },
  {
    chainId: 10,
    address: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    name: "USD Coin (Optimism)",
    symbol: "USDC",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 10,
    address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    name: "Tether USD (Optimism)",
    symbol: "USDT",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/tether-usdt-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 10,
    address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    name: "Dai Stablecoin (Optimism)",
    symbol: "DAI",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/multi-collateral-dai-dai-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 10,
    address: "0x4200000000000000000000000000000000000042",
    name: "Optimism",
    symbol: "OP",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/optimism-ethereum-op-logo.png",
    tags: ["layer2"],
  },
];

/**
 * Arbitrum (chainId 42161) tokens.
 */
export const ARBITRUM_TOKENS: TokenListEntry[] = [
  {
    chainId: 42161,
    address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    name: "Wrapped Ether",
    symbol: "WETH",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/ethereum-eth-logo.png",
    tags: ["wrapped", "gas-token"],
  },
  {
    chainId: 42161,
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    name: "USD Coin (Arbitrum)",
    symbol: "USDC",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 42161,
    address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    name: "Tether USD (Arbitrum)",
    symbol: "USDT",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/tether-usdt-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 42161,
    address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    name: "Dai Stablecoin (Arbitrum)",
    symbol: "DAI",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/multi-collateral-dai-dai-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 42161,
    address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    name: "Wrapped BTC (Arbitrum)",
    symbol: "WBTC",
    decimals: 8,
    logoURI: "https://cryptologos.cc/logos/wrapped-bitcoin-wbtc-logo.png",
    tags: ["wrapped", "btc"],
  },
  {
    chainId: 42161,
    address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    name: "Arbitrum",
    symbol: "ARB",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/arbitrum-arb-logo.png",
    tags: ["layer2"],
  },
];

/**
 * Base (chainId 8453) tokens.
 */
export const BASE_TOKENS: TokenListEntry[] = [
  {
    chainId: 8453,
    address: "0x4200000000000000000000000000000000000006",
    name: "Wrapped Ether",
    symbol: "WETH",
    decimals: 18,
    logoURI: "https://cryptologos.cc/logos/ethereum-eth-logo.png",
    tags: ["wrapped", "gas-token"],
  },
  {
    chainId: 8453,
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin (Base)",
    symbol: "USDC",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
    tags: ["stablecoin"],
  },
  {
    chainId: 8453,
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    name: "USD Base Coin",
    symbol: "USDbC",
    decimals: 6,
    logoURI: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
    tags: ["stablecoin", "bridged"],
  },
];

/**
 * All built-in tokens aggregated by chain ID.
 */
export const DEFAULT_BUILTIN_TOKENS: Record<number, TokenListEntry[]> = {
  1: ETHEREUM_MAINNET_TOKENS,
  137: POLYGON_TOKENS,
  10: OPTIMISM_TOKENS,
  42161: ARBITRUM_TOKENS,
  8453: BASE_TOKENS,
};

/**
 * All built-in tokens as a flat array.
 */
export function getAllBuiltinTokens(): TokenListEntry[] {
  return Object.values(DEFAULT_BUILTIN_TOKENS).flat();
}

/**
 * Default sources for TokenListManager.
 *
 * - Built-in (inline): always available, no network fetch needed
 * - Uniswap Default: loaded from remote URL on first use
 * - Coinbase: loaded from remote URL on first use
 */
export const DEFAULT_SOURCES: TokenListSource[] = [
  {
    name: "built-in",
    tokens: getAllBuiltinTokens(),
    enabled: true,
  },
  {
    name: "uniswap-default",
    url: "https://tokens.uniswap.org",
    enabled: true,
    refreshInterval: 24 * 60 * 60 * 1000, // 24h
  },
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/tokens",
    enabled: false,
    refreshInterval: 24 * 60 * 60 * 1000,
  },
];
