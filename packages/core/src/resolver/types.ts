import type {
  NAMESPACE_EIP155,
  NAMESPACE_SOLANA,
  NAMESPACE_XRPL,
} from "../constants";

/**
 * Result of a forward name resolution (name → address).
 */
export interface AddressResult {
  /** Resolved address (without CAIP-10 prefix). */
  address: string;
  /** Chain type that this address belongs to. */
  chainType: "eip155" | "solana" | "xrpl";
  /** The original name that was resolved. */
  name: string;
  /** Optional chain ID (CAIP-2 format) that the name was resolved on. */
  chainId?: string;
}

/**
 * Result of a reverse lookup (address → name).
 */
export interface NameResult {
  /** Resolved name (e.g. "vitalik.eth", "vitalik.sol"). */
  name: string;
  /** Chain type that this name belongs to. */
  chainType: "eip155" | "solana" | "xrpl";
  /** Whether the result is a primary / canonical name. */
  isPrimary: boolean;
}

/**
 * Provider interface for a specific name service (ENS, SNS, etc.).
 */
export interface ResolverProvider {
  /** The chain type this provider handles. */
  chainType: "eip155" | "solana" | "xrpl";
  /** Resolve a name to an address. Returns null if name is not found. */
  resolveName(name: string): Promise<AddressResult | null>;
  /** Reverse-lookup an address to a name. Returns null if no name is found. */
  lookupAddress(address: string): Promise<NameResult | null>;
  /** Check if this provider can handle a given name (by suffix or format). */
  supportsName(name: string): boolean;
}

/**
 * Error codes for name resolution failures.
 */
export type ResolutionErrorCode =
  | "NAME_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "UNSUPPORTED_NAME_SERVICE"
  | "RESOLUTION_TIMEOUT"
  | "INVALID_NAME"
  | "INVALID_ADDRESS";

/**
 * Error class for name resolution failures.
 */
export class ResolutionError extends Error {
  readonly code: ResolutionErrorCode;

  constructor(code: ResolutionErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ResolutionError";
    this.code = code;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/**
 * Configuration for the name resolver.
 */
export interface NameResolverConfig {
  providers?: {
    ens?: { rpcUrl: string };
    sns?: { rpcUrl: string };
  };
  cache?: {
    /** TTL in milliseconds (default: 5 minutes). */
    ttlMs: number;
  };
  /** Default timeout for resolution requests in ms. */
  timeoutMs?: number;
}

/**
 * Internal cache entry with expiry.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Simple in-memory cache with TTL.
 */
export class ResolverCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 300_000) {
    this.ttlMs = ttlMs;
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }

  /** Remove stale entries. */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}
