/**
 * Chain Registry
 *
 * Single source of truth for chain names, token addresses, and provider IDs.
 * Do NOT create new mapping tables elsewhere — use `CHAINS` and `getChainInfo()`.
 */

// ─── ChainInfo Interface ───────────────────────────────────────────────

export interface ChainInfo {
  name: string;
  caip2Id: string; // e.g. "eip155:1"
  nativeCurrency: { symbol: string; decimals: number };
  axelarName?: string; // Axelar GMP name (undefined = not supported by Axelar)
  usdcAddress?: string; // ERC-20 USDC address (undefined = no USDC on this chain)
  usdcDecimals?: number; // USDC decimals (defaults to 6)
  usdtAddress?: string; // ERC-20 USDT address (undefined = no USDT on this chain)
  usdtDecimals?: number; // USDT decimals (defaults to 6)
  tokens?: Record<string, string>; // additional ERC-20 tokens keyed by symbol (DAI, WETH, WMATIC, ...)
  entryPoint?: string; // ERC-4337 EntryPoint address (undefined = AA not supported)
  factoryAddress?: string; // Account factory address
  explorerUrl?: string; // Block explorer base URL (undefined = use default)
  chainlinkEthUsdFeed?: string; // Chainlink ETH/USD price feed oracle address
}

// ─── CHAINS Registry ───────────────────────────────────────────────────

export const CHAINS: Record<number, ChainInfo> = {
  1: {
    name: "Ethereum",
    caip2Id: "eip155:1",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    axelarName: "ethereum",
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdtAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    tokens: {
      DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    },
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    factoryAddress: "0x9406Cc6185a346906296840746125a0E44976454",
    explorerUrl: "https://etherscan.io",
    chainlinkEthUsdFeed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  },
  10: {
    name: "Optimism",
    caip2Id: "eip155:10",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    usdcAddress: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    usdtAddress: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    tokens: {
      DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      WETH: "0x4200000000000000000000000000000000000006",
    },
    entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    factoryAddress: "0x9406Cc6185a346906296840746125a0E44976454",
    explorerUrl: "https://optimistic.etherscan.io",
    chainlinkEthUsdFeed: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
  },
  56: {
    name: "BNB Chain",
    caip2Id: "eip155:56",
    nativeCurrency: { symbol: "BNB", decimals: 18 },
    axelarName: "binance",
    usdcAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdtAddress: "0x55d398326f99059fF775485246999027B3197955",
    usdcDecimals: 18,
    usdtDecimals: 18,
    explorerUrl: "https://bscscan.com",
  },
  100: {
    name: "Gnosis",
    caip2Id: "eip155:100",
    nativeCurrency: { symbol: "xDAI", decimals: 18 },
    axelarName: "gnosis",
    usdcAddress: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83",
    usdtAddress: "0x4ECaBa5870353805a9F068101A40E0f32ed605C6",
    explorerUrl: "https://gnosisscan.io",
  },
  137: {
    name: "Polygon",
    caip2Id: "eip155:137",
    nativeCurrency: { symbol: "MATIC", decimals: 18 },
    axelarName: "polygon",
    usdcAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    usdtAddress: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    tokens: {
      DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
      WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    },
    entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    factoryAddress: "0x9406Cc6185a346906296840746125a0E44976454",
    explorerUrl: "https://polygonscan.com",
    chainlinkEthUsdFeed: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0",
  },
  250: {
    name: "Fantom",
    caip2Id: "eip155:250",
    nativeCurrency: { symbol: "FTM", decimals: 18 },
    axelarName: "fantom",
    usdcAddress: "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75",
    explorerUrl: "https://ftmscan.com",
  },
  324: {
    name: "zkSync Era",
    caip2Id: "eip155:324",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
  },
  1101: {
    name: "Polygon zkEVM",
    caip2Id: "eip155:1101",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    axelarName: "polygon-zkevm",
    usdcAddress: "0xA8CE8aee21bC2A48a5EF670afCc9274C7bbbC035",
    explorerUrl: "https://zkevm.polygonscan.com",
  },
  8453: {
    name: "Base",
    caip2Id: "eip155:8453",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    axelarName: "base",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokens: {
      WETH: "0x4200000000000000000000000000000000000006",
    },
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    factoryAddress: "0x9406Cc6185a346906296840746125a0E44976454",
    explorerUrl: "https://basescan.org",
  },
  42161: {
    name: "Arbitrum",
    caip2Id: "eip155:42161",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    axelarName: "arbitrum",
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdtAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    tokens: {
      DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    factoryAddress: "0x9406Cc6185a346906296840746125a0E44976454",
    explorerUrl: "https://arbiscan.io",
  },
  43114: {
    name: "Avalanche",
    caip2Id: "eip155:43114",
    nativeCurrency: { symbol: "AVAX", decimals: 18 },
    axelarName: "avalanche",
    usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    explorerUrl: "https://snowtrace.io",
  },
  59144: {
    name: "Linea",
    caip2Id: "eip155:59144",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    usdcAddress: "0x176211869cA2b568f2A7D4EE941E073a542EEd12",
    explorerUrl: "https://lineascan.build",
  },
  534352: {
    name: "Scroll",
    caip2Id: "eip155:534352",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    usdcAddress: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4",
    explorerUrl: "https://scrollscan.com",
  },
  11155111: {
    name: "Sepolia",
    caip2Id: "eip155:11155111",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    factoryAddress: "0x9406Cc6185a346906296840746125a0E44976454",
    explorerUrl: "https://sepolia.etherscan.io",
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Get chain info for a given chain ID.
 * Throws if the chain is not in the registry.
 */
export function getChainInfo(chainId: number): ChainInfo {
  const info = CHAINS[chainId];
  if (!info) {
    throw new Error(
      `Chain ${chainId} not found in registry. Add it to chain-registry.ts`,
    );
  }
  return info;
}

// ─── Token resolution helpers (single source of truth for token addresses) ──

/** Zero address, representing the native gas token (ETH / MATIC / BNB / ...) */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function findChainInfo(chainRef: string | number): ChainInfo | undefined {
  if (typeof chainRef === "number") return CHAINS[chainRef];
  return Object.values(CHAINS).find((c) => c.caip2Id === chainRef);
}

/**
 * Resolve a token symbol (or pass through an address) to its on-chain address.
 * Accepts a numeric chainId or a CAIP-2 id (e.g. "eip155:1").
 * Returns the input unchanged if the chain or token is unknown.
 */
export function resolveTokenAddress(
  chainRef: string | number,
  symbolOrAddress: string,
): string {
  if (symbolOrAddress.startsWith("0x") && symbolOrAddress.length === 42) {
    return symbolOrAddress;
  }
  const info = findChainInfo(chainRef);
  if (!info) return symbolOrAddress;

  const symbol = symbolOrAddress.toUpperCase();
  if (symbol === "USDC") return info.usdcAddress ?? symbolOrAddress;
  if (symbol === "USDT") return info.usdtAddress ?? symbolOrAddress;
  if (symbol === info.nativeCurrency.symbol.toUpperCase()) return ZERO_ADDRESS;
  return info.tokens?.[symbol] ?? symbolOrAddress;
}

/**
 * Reverse of resolveTokenAddress: map an on-chain address back to its symbol.
 * Falls back to a truncated address if the token is unknown.
 */
export function resolveTokenSymbol(
  chainRef: string | number,
  address: string,
): string {
  const info = findChainInfo(chainRef);
  const addr = address.toLowerCase();
  const fallback = address.startsWith("0x") ? address.slice(0, 10) : address;

  if (addr === ZERO_ADDRESS) return info?.nativeCurrency.symbol ?? "UNKNOWN";
  if (!info) return fallback;
  if (info.usdcAddress?.toLowerCase() === addr) return "USDC";
  if (info.usdtAddress?.toLowerCase() === addr) return "USDT";
  for (const [symbol, a] of Object.entries(info.tokens ?? {})) {
    if (a.toLowerCase() === addr) return symbol;
  }
  return fallback;
}

/** Native gas token symbol for a chain (defaults to "ETH"). */
export function getNativeTokenSymbol(chainRef: string | number): string {
  return findChainInfo(chainRef)?.nativeCurrency.symbol ?? "ETH";
}

/** Native gas token decimals for a chain (defaults to 18). */
export function getNativeTokenDecimals(chainRef: string | number): number {
  return findChainInfo(chainRef)?.nativeCurrency.decimals ?? 18;
}
