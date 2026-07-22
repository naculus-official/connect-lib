/**
 * TokenListManager — load, merge, cache, and search token lists.
 *
 * Supports multiple sources (built-in, Uniswap, Coinbase, custom).
 * Deduplicates by (chainId, address) with configurable source priority.
 * Caches merged results to localStorage.
 */

import { createStorageAdapter, type StorageAdapter } from "../storage";
import { DEFAULT_SOURCES } from "./lists";
import type {
  TokenList,
  TokenListEntry,
  TokenListManagerConfig,
  TokenListSource,
  TokenListSourceStatus,
  TokenMatch,
  TokenSearchResult,
} from "./types";

const DEFAULT_CACHE_KEY = "naculus_token_list_cache";
const DEFAULT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_FETCH_TIMEOUT = 10000; // 10s

interface CachedData {
  timestamp: number;
  tokens: TokenListEntry[];
}

export class TokenListManager {
  private config: TokenListManagerConfig;
  private tokens: TokenListEntry[] = [];
  private sourceStatus: Map<string, TokenListSourceStatus> = new Map();
  private storage: StorageAdapter;

  constructor(config?: Partial<TokenListManagerConfig>) {
    this.config = {
      sources: config?.sources ?? DEFAULT_SOURCES,
      cacheKey: config?.cacheKey ?? DEFAULT_CACHE_KEY,
      cacheTtl: config?.cacheTtl ?? DEFAULT_CACHE_TTL,
      sourcePriority: config?.sourcePriority,
      fetchTimeout: config?.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT,
    };

    this.storage = createStorageAdapter("local", "");

    // Initialize source statuses
    for (const source of this.config.sources) {
      this.sourceStatus.set(source.name, {
        name: source.name,
        enabled: source.enabled,
        state: "loading",
        tokenCount: 0,
        lastUpdated: null,
      });
    }
  }

  /**
   * Load all enabled sources.
   * Checks cache first, falls back to in-memory or failed-source stale data.
   */
  async load(): Promise<TokenListEntry[]> {
    // 1. Check cache
    const cached = await this.loadFromCache();
    if (cached && !this.isCacheExpired(cached.timestamp)) {
      this.tokens = cached.tokens;
      this.updateSourceStatuses("loaded");
      return this.tokens;
    }

    // 2. Fetch from all enabled sources in parallel
    const enabledSources = this.config.sources.filter((s) => s.enabled);
    const results = await Promise.allSettled(
      enabledSources.map((source) => this.fetchSource(source)),
    );

    // 3. Merge results
    const allTokens: TokenListEntry[] = [];
    for (let i = 0; i < enabledSources.length; i++) {
      const result = results[i];
      const source = enabledSources[i];
      if (result.status === "fulfilled") {
        allTokens.push(...result.value);
        this.sourceStatus.set(source.name, {
          name: source.name,
          enabled: source.enabled,
          state: "loaded",
          tokenCount: result.value.length,
          lastUpdated: Date.now(),
        });
      } else {
        // Source failed — use stale cache tokens for this source if available
        const stale = await this.loadFromCache();
        const staleTokens =
          stale?.tokens.filter((t) => t.source === source.name) ?? [];
        allTokens.push(...staleTokens);

        this.sourceStatus.set(source.name, {
          name: source.name,
          enabled: source.enabled,
          state: "error",
          tokenCount: staleTokens.length,
          lastUpdated: stale?.timestamp ?? null,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }

    // 4. Deduplicate and store
    this.tokens = this.deduplicate(allTokens);

    // 5. Cache
    await this.saveToCache(this.tokens);

    return this.tokens;
  }

  /**
   * Force-refresh all sources, bypassing cache.
   */
  async refresh(): Promise<TokenListEntry[]> {
    // Clear in-memory cache so load re-fetches
    this.tokens = [];
    return this.load();
  }

  /**
   * Get all loaded tokens, optionally filtered.
   */
  getTokens(options?: { chainId?: number; source?: string }): TokenListEntry[] {
    let result = this.tokens;

    if (options?.chainId !== undefined) {
      result = result.filter((t) => t.chainId === options.chainId);
    }

    if (options?.source !== undefined) {
      result = result.filter((t) => t.source === options.source);
    }

    return result;
  }

  /**
   * Search tokens by symbol, name, or address.
   */
  search(
    query: string,
    options?: { chainId?: number; limit?: number },
  ): TokenSearchResult {
    const limit = options?.limit ?? 20;
    const q = query.trim().toLowerCase();

    if (!q) {
      return { exact: [], fuzzy: [], hasMore: false };
    }

    const exact: TokenMatch[] = [];
    const fuzzy: TokenMatch[] = [];

    let candidates = this.tokens;
    if (options?.chainId !== undefined) {
      candidates = candidates.filter((t) => t.chainId === options.chainId);
    }

    // Check if query looks like an address
    const isAddress =
      /^0x[0-9a-fA-F]{40}$/.test(q) || /^0x[0-9a-fA-F]{40}$/.test(query.trim());

    for (const token of candidates) {
      if (isAddress) {
        // Exact address match (case-insensitive)
        if (token.address.toLowerCase() === q) {
          exact.push({
            token,
            score: 1.0,
            matchField: "address",
          });
        }
        continue;
      }

      const sym = token.symbol.toLowerCase();
      const name = token.name.toLowerCase();

      // Exact symbol match (case-insensitive)
      if (sym === q) {
        exact.push({
          token,
          score: 1.0,
          matchField: "symbol",
        });
        continue;
      }

      // Exact name match
      if (name === q) {
        exact.push({
          token,
          score: 0.95,
          matchField: "name",
        });
        continue;
      }

      // Fuzzy: symbol starts with query
      if (sym.startsWith(q)) {
        fuzzy.push({
          token,
          score: 0.8,
          matchField: "symbol",
        });
        continue;
      }

      // Fuzzy: name includes query (word boundary)
      if (name.includes(q)) {
        fuzzy.push({
          token,
          score: 0.6,
          matchField: "name",
        });
        continue;
      }

      // Fuzzy: symbol includes query
      if (sym.includes(q)) {
        fuzzy.push({
          token,
          score: 0.4,
          matchField: "symbol",
        });
      }
    }

    // Sort: exact first, then fuzzy by score descending
    exact.sort((a, b) => b.score - a.score);
    fuzzy.sort((a, b) => b.score - a.score);

    const total = exact.length + fuzzy.length;
    const hasMore = total > limit;

    // Slice both arrays proportionally
    const exactSlice = exact.slice(
      0,
      Math.min(exact.length, Math.ceil(limit / 2)),
    );
    const remaining = limit - exactSlice.length;
    const fuzzySlice = fuzzy.slice(0, remaining);

    return { exact: exactSlice, fuzzy: fuzzySlice, hasMore };
  }

  /**
   * Get a single token by address and chain ID.
   */
  getToken(address: string, chainId: number): TokenListEntry | undefined {
    return this.tokens.find(
      (t) =>
        t.address.toLowerCase() === address.toLowerCase() &&
        t.chainId === chainId,
    );
  }

  /**
   * Clear all caches.
   */
  clearCache(): void {
    this.tokens = [];
    this.storage.remove(this.config.cacheKey!);
    this.sourceStatus.clear();
  }

  /**
   * Get status of all registered sources.
   */
  getSourcesStatus(): TokenListSourceStatus[] {
    return Array.from(this.sourceStatus.values());
  }

  // ── Private ─────────────────────────────────────────────────────

  private async fetchSource(
    source: TokenListSource,
  ): Promise<TokenListEntry[]> {
    // Inline tokens — no network fetch needed
    if (source.tokens && source.tokens.length > 0) {
      return source.tokens.map((t) => ({ ...t, source: source.name }));
    }

    if (!source.url) {
      return [];
    }

    // Remote URL fetch
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.fetchTimeout,
    );

    try {
      const res = await fetch(source.url, { signal: controller.signal });

      if (!res.ok) {
        throw new Error(
          `Failed to fetch token list "${source.name}": HTTP ${res.status}`,
        );
      }

      const contentType = res.headers.get("content-type") ?? "";
      let raw: unknown;

      if (
        contentType.includes("application/json") ||
        contentType.includes("text/plain")
      ) {
        raw = await res.json();
      } else {
        // Try parsing as JSON regardless
        const text = await res.text();
        raw = JSON.parse(text);
      }

      // Uniswap Token List format: { tokens: [...] } or plain array
      let tokens: TokenListEntry[];

      if (Array.isArray(raw)) {
        tokens = raw as TokenListEntry[];
      } else if (raw && typeof raw === "object") {
        const list = raw as TokenList;
        tokens = list.tokens ?? [];
      } else {
        tokens = [];
      }

      // Apply chain filter if configured
      if (source.chainFilter && source.chainFilter.length > 0) {
        tokens = tokens.filter((t) => source.chainFilter!.includes(t.chainId));
      }

      // Tag with source name
      return tokens.map((t) => ({ ...t, source: source.name }));
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Deduplicate tokens by (chainId, address).
   * Source priority controls which record wins for colliding tokens.
   */
  private deduplicate(tokens: TokenListEntry[]): TokenListEntry[] {
    const seen = new Map<string, TokenListEntry>();
    const priority =
      this.config.sourcePriority ?? this.config.sources.map((s) => s.name);

    for (const token of tokens) {
      const key = `${token.chainId}:${token.address.toLowerCase()}`;
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, token);
        continue;
      }

      // Existing has higher priority → keep it
      const existingIdx = priority.indexOf(existing.source ?? "");
      const currentIdx = priority.indexOf(token.source ?? "");

      if (currentIdx >= 0 && (existingIdx < 0 || currentIdx < existingIdx)) {
        // Current token has higher priority → replace
        seen.set(key, token);
      }
      // Otherwise keep existing
    }

    return Array.from(seen.values());
  }

  private async loadFromCache(): Promise<CachedData | null> {
    try {
      return await this.storage.get<CachedData>(this.config.cacheKey!);
    } catch {
      return null;
    }
  }

  private async saveToCache(tokens: TokenListEntry[]): Promise<void> {
    try {
      await this.storage.set<CachedData>(this.config.cacheKey!, {
        timestamp: Date.now(),
        tokens,
      });
    } catch {
      // Cache write failure is non-fatal
    }
  }

  private isCacheExpired(timestamp: number): boolean {
    return Date.now() - timestamp > (this.config.cacheTtl ?? DEFAULT_CACHE_TTL);
  }

  private updateSourceStatuses(state: "loading" | "loaded" | "error"): void {
    for (const [name, status] of this.sourceStatus) {
      status.state = state;
      status.tokenCount = this.tokens.filter((t) => t.source === name).length;
      status.lastUpdated = Date.now();
    }
  }
}
