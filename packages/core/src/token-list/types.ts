/**
 * Token List Types — compliant with Uniswap Token List spec
 *
 * @see https://github.com/Uniswap/token-lists
 */

/**
 * Metadata for a single token.
 */
export interface TokenListEntry {
  /** EVM contract address or token identifier */
  readonly address: string;
  /** Numeric chain ID (e.g. 1 for Ethereum) */
  readonly chainId: number;
  /** Human-readable name (e.g. "USD Coin") */
  readonly name: string;
  /** Ticker symbol (e.g. "USDC") */
  readonly symbol: string;
  /** Token decimals (e.g. 6 for USDC, 18 for ETH) */
  readonly decimals: number;
  /** Optional logo URL */
  readonly logoURI?: string;
  /** Optional semantic tags (e.g. ["stablecoin"]) */
  readonly tags?: string[];
  /** Optional extensions for custom metadata */
  readonly extensions?: Record<string, unknown>;
  /** Source identifier (set internally by the manager) */
  readonly source?: string;
}

/**
 * A token list conforming to the Uniswap Token List JSON schema.
 */
export interface TokenList {
  readonly name: string;
  readonly timestamp: string;
  readonly version: {
    major: number;
    minor: number;
    patch: number;
  };
  readonly tokens: TokenListEntry[];
  readonly logoURI?: string;
  readonly keywords?: string[];
  readonly tags?: Record<string, TokenListTag>;
}

export interface TokenListTag {
  readonly name: string;
  readonly description: string;
}

/**
 * Configuration for a single token list source.
 */
export interface TokenListSource {
  /** Unique source identifier */
  name: string;
  /** Remote URL to fetch the list from */
  url?: string;
  /** Inline token array (used for built-in lists or custom tokens) */
  tokens?: TokenListEntry[];
  /** Refresh interval in ms (default 24h) */
  refreshInterval?: number;
  /** Whether this source is enabled by default */
  enabled: boolean;
  /** Optional chain filter – only tokens matching these chain IDs are kept */
  chainFilter?: number[];
}

/**
 * Configuration for TokenListManager.
 */
export interface TokenListManagerConfig {
  /** Ordered list of token list sources */
  sources: TokenListSource[];
  /** localStorage key for caching merged results */
  cacheKey?: string;
  /** Cache TTL in ms (default 24h) */
  cacheTtl?: number;
  /** Source priority for deduplication – earlier = higher priority */
  sourcePriority?: string[];
  /** Fetch timeout per source (ms, default 10000) */
  fetchTimeout?: number;
}

/**
 * Status snapshot of a single source.
 */
export interface TokenListSourceStatus {
  name: string;
  enabled: boolean;
  state: "loading" | "loaded" | "error";
  tokenCount: number;
  lastUpdated: number | null;
  error?: string;
}

/**
 * Search query parameters.
 */
export interface TokenSearchQuery {
  query: string;
  chainId?: number;
  limit?: number;
}

/**
 * Result of a token search.
 */
export interface TokenSearchResult {
  exact: TokenMatch[];
  fuzzy: TokenMatch[];
  hasMore: boolean;
}

/**
 * A single search match with relevance score.
 */
export interface TokenMatch {
  token: TokenListEntry;
  score: number;
  matchField: "symbol" | "name" | "address";
  hasBalance?: boolean;
  balance?: string;
}
