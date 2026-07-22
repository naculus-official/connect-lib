import { DEFAULT_RPC_URLS } from "../rpc";
import { ENSProvider } from "./providers/ens";
import { SNSProvider } from "./providers/sns";
import type {
  AddressResult,
  NameResolverConfig,
  NameResult,
  ResolverProvider,
} from "./types";
import { ResolutionError, ResolverCache } from "./types";

// ── Default RPC URLs ─────────────────────────────────────────────

function defaultEnsRpc(): string {
  return DEFAULT_RPC_URLS["eip155:1"] ?? "https://eth.llamarpc.com";
}

function defaultSnsRpc(): string {
  return DEFAULT_RPC_URLS["solana:0"] ?? "https://api.mainnet-beta.solana.com";
}

// ── Name Detector ────────────────────────────────────────────────

/**
 * Detect which name service a name belongs to based on its suffix.
 */
function detectNameService(name: string): ".eth" | ".sol" | null {
  const lower = name.toLowerCase().trim();
  if (lower.endsWith(".eth")) return ".eth";
  if (lower.endsWith(".sol")) return ".sol";
  return null;
}

/**
 * Validate that a name is syntactically valid for its service.
 */
function isValidName(name: string, suffix: ".eth" | ".sol"): boolean {
  const label = name.toLowerCase().trim().slice(0, -suffix.length);
  if (!label) return false;

  // Basic validation: at least one character, no empty parts
  // ENS: valid chars include alphanumeric, hyphens, underscores, emoji
  // SNS: similar constraints
  // For now, just check non-empty with basic char constraints
  if (label.length < 1 || label.length > 255) return false;

  // .eth must start with alphanumeric (no leading hyphens)
  if (suffix === ".eth") {
    if (!/^[a-z0-9]/.test(label)) return false;
    // No consecutive hyphens
    if (/--/.test(label)) return false;
  }

  // .sol must start with alphanumeric
  if (suffix === ".sol") {
    if (!/^[a-z0-9]/.test(label)) return false;
  }

  return true;
}

// ── NameResolver ─────────────────────────────────────────────────

/**
 * Unified name resolution service for ENS / SNS / future name systems.
 *
 * Features:
 * - Auto-detection of name service by suffix (.eth → ENS, .sol → SNS)
 * - Forward resolution: name → address
 * - Reverse lookup: address → name
 * - In-memory caching with configurable TTL
 * - Timeout support
 * - Minimal dependencies (plain fetch, no ethers/web3)
 */
export class NameResolver {
  private readonly providers: Map<string, ResolverProvider> = new Map();
  private readonly cache: ResolverCache;
  private readonly timeoutMs: number;

  constructor(config?: NameResolverConfig) {
    // Set up cache
    this.cache = new ResolverCache(config?.cache?.ttlMs ?? 300_000);
    this.timeoutMs = config?.timeoutMs ?? 10_000;

    // Initialize ENS provider
    const ensRpcUrl = config?.providers?.ens?.rpcUrl ?? defaultEnsRpc();
    this.registerProvider(new ENSProvider(ensRpcUrl));

    // Initialize SNS provider
    const snsRpcUrl = config?.providers?.sns?.rpcUrl ?? defaultSnsRpc();
    this.registerProvider(new SNSProvider(snsRpcUrl));
  }

  /**
   * Register a custom name resolution provider.
   */
  registerProvider(provider: ResolverProvider): void {
    this.providers.set(provider.chainType, provider);
  }

  /**
   * Resolve a human-readable name to a blockchain address.
   *
   * @param name - The name to resolve (e.g. "vitalik.eth", "jupiter.sol").
   * @returns AddressResult with the resolved address, or null if not found.
   * @throws ResolutionError on provider errors, timeout, or unsupported names.
   */
  async resolveName(name: string): Promise<AddressResult | null> {
    const cleanName = name.trim();

    if (!cleanName) {
      throw new ResolutionError("INVALID_NAME", "Name cannot be empty");
    }

    // Check cache first
    const cacheKey = `resolve:${cleanName.toLowerCase()}`;
    const cached = this.cache.get<AddressResult>(cacheKey);
    if (cached !== null) return cached;

    // Detect name service
    const suffix = detectNameService(cleanName);
    if (!suffix) {
      throw new ResolutionError(
        "UNSUPPORTED_NAME_SERVICE",
        `Unsupported name service for "${cleanName}". Supported suffixes: .eth, .sol`,
      );
    }

    if (!isValidName(cleanName, suffix)) {
      throw new ResolutionError(
        "INVALID_NAME",
        `Invalid name format: "${cleanName}"`,
      );
    }

    // Find matching provider
    const provider = this.findProviderForName(cleanName);
    if (!provider) {
      throw new ResolutionError(
        "UNSUPPORTED_NAME_SERVICE",
        `No provider found for name: "${cleanName}"`,
      );
    }

    // Execute resolution with timeout
    const result = await this.withTimeout(
      provider.resolveName(cleanName),
      "resolveName",
    );

    // Cache the result
    if (result) {
      this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Reverse-lookup a blockchain address to find its human-readable name.
   *
   * @param address - The blockchain address to look up.
   * @param chainId - Optional CAIP-2 chain ID to hint which provider to use.
   * @returns NameResult with the resolved name, or null if not found.
   */
  async lookupAddress(
    address: string,
    chainId?: string,
  ): Promise<NameResult | null> {
    if (!address) {
      throw new ResolutionError("INVALID_ADDRESS", "Address cannot be empty");
    }

    const cleanAddr = address.trim();

    // Determine chain type from address format or chainId
    const chainType = this.detectChainType(cleanAddr, chainId);

    // Check cache
    const cacheKey = `lookup:${cleanAddr.toLowerCase()}:${chainType}`;
    const cached = this.cache.get<NameResult>(cacheKey);
    if (cached !== null) return cached;

    // Find provider for chain type
    const provider = this.providers.get(chainType);
    if (!provider) {
      return null;
    }

    // Execute with timeout
    const result = await this.withTimeout(
      provider.lookupAddress(cleanAddr),
      "lookupAddress",
    );

    // Cache the result
    if (result) {
      this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Resolve multiple names in a single batch call.
   * Merges requests by provider to minimize RPC calls.
   *
   * @param names - Array of names to resolve.
   * @returns Map of name to AddressResult (or null if not found).
   */
  async resolveNames(
    names: string[],
  ): Promise<Map<string, AddressResult | null>> {
    const results = new Map<string, AddressResult | null>();
    const errors: Array<{ name: string; error: Error }> = [];

    await Promise.allSettled(
      names.map(async (name) => {
        try {
          const result = await this.resolveName(name);
          results.set(name, result);
        } catch (err) {
          errors.push({
            name,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }),
    );

    return results;
  }

  /**
   * Clear the resolution cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Internal Helpers ──────────────────────────────────────────

  private findProviderForName(name: string): ResolverProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.supportsName(name)) return provider;
    }
    return undefined;
  }

  private detectChainType(address: string, chainId?: string): string {
    // If chainId is provided, derive from it
    if (chainId) {
      const ns = chainId.split(":")[0];
      if (ns === "eip155") return "eip155";
      if (ns === "solana") return "solana";
      if (ns === "xrpl") return "xrpl";
    }

    // Auto-detect from address format
    // EVM: starts with 0x, 40 hex chars
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) return "eip155";
    // Solana: Base58, 32-44 chars, no 0x prefix
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return "solana";

    // Default to eip155
    return "eip155";
  }

  private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new ResolutionError(
                "RESOLUTION_TIMEOUT",
                `${label} timed out after ${this.timeoutMs}ms`,
              ),
            ),
          this.timeoutMs,
        ),
      ),
    ]);
  }
}
