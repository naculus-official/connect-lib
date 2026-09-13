/**
 * SessionManager
 *
 * Unified multi-chain session management system.
 * Wraps ConnectorManager to add chain-aware session lifecycle,
 * fee estimation sync, event emission, and persistence.
 *
 * @see SRS-009 §3-6
 */

import type { UniversalConnector, UniversalWalletSession } from "../connector";
import type { ConnectorManager } from "../connector-manager";
import type { FeeEstimationConfig, FeeValues } from "../fee-estimation";
import { estimateFees } from "../fee-estimation";
import { logger } from "../logger";
import { DEFAULT_RPC_URLS } from "../rpc";
import type { SessionNamespace } from "../session";
import { createSessionError } from "./errors";
import type {
  SessionEvent,
  SessionEventHandler,
  SessionEventPayloads,
} from "./events";
import { SessionEventEmitter } from "./events";
import {
  createSessionPersistence,
  type SessionPersistence,
} from "./persistence";
import type {
  ActiveSessionBundle,
  ChainSession,
  RefreshFeesOptions,
  SessionManagerConfig,
  UserFeeOverrides,
} from "./types";
import { parseChainId, validateChainId } from "./types";

// ─── Default Chain Metadata ────────────────────────────────────────────

const DEFAULT_CHAIN_METADATA: Record<
  string,
  { name: string; symbol: string; decimals: number }
> = {
  "eip155:1": { name: "Ether", symbol: "ETH", decimals: 18 },
  "eip155:137": { name: "POL", symbol: "POL", decimals: 18 },
  "eip155:10": { name: "Ether", symbol: "ETH", decimals: 18 },
  "eip155:42161": { name: "Ether", symbol: "ETH", decimals: 18 },
  "eip155:8453": { name: "Ether", symbol: "ETH", decimals: 18 },
  "eip155:11155111": { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
    name: "SOL",
    symbol: "SOL",
    decimals: 9,
  },
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": {
    name: "SOL",
    symbol: "SOL",
    decimals: 9,
  },
  "xrpl:0": { name: "XRP", symbol: "XRP", decimals: 6 },
};

/**
 * Native-currency precision per CAIP-2 namespace, used when a chain is not in
 * the table above.
 *
 * Precision is a property of the namespace, not of the individual chain, so it
 * is knowable even for an unlisted chain — unlike the ticker, which is not.
 * Defaulting every namespace to 18 silently misreports XRP by 10^12 and SOL by
 * 10^9. Values: wei (eip155), lamports (solana, cf. the SOL entries above),
 * drops (xrpl, cf. formatXRPAmount/parseXRPAmount in @naculus/connector-xrpl).
 */
const NAMESPACE_NATIVE_DECIMALS: Record<string, number> = {
  eip155: 18,
  solana: 9,
  xrpl: 6,
};

const DEFAULT_EXPLORERS: Record<string, string> = {
  "eip155:1": "https://etherscan.io",
  "eip155:137": "https://polygonscan.com",
  "eip155:10": "https://optimistic.etherscan.io",
  "eip155:42161": "https://arbiscan.io",
  "eip155:8453": "https://basescan.org",
  "eip155:11155111": "https://sepolia.etherscan.io",
};

// ─── SessionManager ────────────────────────────────────────────────────

export class SessionManager extends SessionEventEmitter {
  private bundles: Map<string, ActiveSessionBundle> = new Map();
  private activeBundleId: string | null = null;
  private userFeeOverrides: UserFeeOverrides = {};
  private config: Required<
    Pick<SessionManagerConfig, "autoRefreshFeeOnSwitch" | "maxActiveSessions">
  > &
    Omit<SessionManagerConfig, "autoRefreshFeeOnSwitch" | "maxActiveSessions">;
  private persistence: SessionPersistence;

  constructor(
    private connectorManager: ConnectorManager,
    config?: SessionManagerConfig,
  ) {
    super();
    this.config = {
      autoRefreshFeeOnSwitch: config?.autoRefreshFeeOnSwitch ?? true,
      maxActiveSessions: config?.maxActiveSessions ?? 10,
      defaultRpcUrls: config?.defaultRpcUrls,
      defaultCurrencies: config?.defaultCurrencies,
      defaultExplorers: config?.defaultExplorers,
      encryptionKey: config?.encryptionKey,
    };
    this.persistence = createSessionPersistence(
      undefined,
      undefined,
      this.config.encryptionKey,
    );
  }

  // ── Core API ────────────────────────────────────────────────────────

  /** Register or replace a connector used by an attached session. */
  registerConnector(connector: UniversalConnector, priority = 0): void {
    this.connectorManager.register(connector.id, connector, priority);
  }

  /**
   * Adopt a session that was already connected by a UI/client layer.
   * This avoids prompting the wallet twice while still giving the session
   * manager ownership of persistence, chain sessions, and lifecycle events.
   */
  async attach(
    session: UniversalWalletSession,
    chainId?: string,
  ): Promise<ActiveSessionBundle> {
    const activeChainId =
      chainId ??
      Object.values(session.namespaces)
        .flatMap((namespace) => namespace.chains)
        .at(0);
    if (!activeChainId) {
      throw createSessionError(
        "chain_unsupported",
        "Session contains no chain.",
      );
    }
    validateChainId(activeChainId);

    const connectorId = session.connectorId ?? session.walletType;
    this.connectorManager.adopt(session);

    const bundle = this.buildBundle(session, activeChainId, connectorId);
    const bundleId = this.getBundleId(session);
    if (
      !this.bundles.has(bundleId) &&
      this.bundles.size >= this.config.maxActiveSessions
    ) {
      const oldest = Array.from(this.bundles.entries()).reduce((a, b) =>
        a[1].lastActiveAt < b[1].lastActiveAt ? a : b,
      );
      this.bundles.delete(oldest[0]);
    }
    this.bundles.set(bundleId, bundle);
    this.activeBundleId = bundleId;
    await this.persistBundle(bundle);
    this.emit("sessionConnected", { bundle });
    return bundle;
  }

  /**
   * Connect to a wallet on a specific chain.
   * Delegates to the connector's connect method and wraps the result
   * in an ActiveSessionBundle.
   */
  async connect(
    walletType: string,
    chainId: string,
    input?: unknown,
  ): Promise<ActiveSessionBundle> {
    validateChainId(chainId);

    if (this.bundles.size >= this.config.maxActiveSessions) {
      // LRU evict: remove oldest bundle
      const oldest = Array.from(this.bundles.entries()).reduce((a, b) =>
        a[1].lastActiveAt < b[1].lastActiveAt ? a : b,
      );
      this.bundles.delete(oldest[0]);
    }

    const session = await this.connectorManager.connect(walletType, input);
    return this.attach(session, chainId);
  }

  /**
   * Switch the active chain for the current session.
   * Delegates to the appropriate connector's switchChain method.
   * After successful switch, auto-refreshes fee estimation.
   */
  async switchChain(chainId: string): Promise<void> {
    validateChainId(chainId);

    const bundle = this.getActiveBundle();
    if (!bundle) {
      throw createSessionError("no_active_session");
    }

    const previousChainId = bundle.activeChainId;

    // No-op if already on the requested chain
    if (previousChainId === chainId) {
      return;
    }

    const connector = this.resolveConnector(bundle.walletSession);
    if (!connector.switchChain) {
      throw createSessionError("method_unsupported");
    }

    try {
      await connector.switchChain(bundle.walletSession, chainId);
    } catch (error: any) {
      // Map user rejection
      if (
        error?.code === 4001 ||
        error?.code === "user_rejected" ||
        error?.code === "chain_switch_rejected"
      ) {
        throw createSessionError("chain_switch_rejected", error);
      }
      throw createSessionError("chain_unsupported", error);
    }

    // Ensure the chain session exists (create if first time)
    if (!bundle.chainSessions.has(chainId)) {
      const chainSession = this.createChainSession(
        chainId,
        bundle.walletSession.connectorId ?? bundle.walletSession.walletType,
      );
      bundle.chainSessions.set(chainId, chainSession);
      this.emit("chainSessionAdded", { bundle, chainSession });
    }

    bundle.activeChainId = chainId;
    bundle.lastActiveAt = new Date().toISOString();

    // Update wallet session namespaces
    this.updateSessionNamespace(bundle.walletSession, chainId);

    this.emit("chainChanged", { bundle, previousChainId, newChainId: chainId });

    // Auto-refresh fee estimation
    if (this.config.autoRefreshFeeOnSwitch) {
      try {
        await this.refreshFees(chainId);
      } catch (error) {
        // Non-blocking: fee refresh failure should not block chain switch
        logger.warn(
          "session-manager",
          `Fee refresh failed after chain switch to ${chainId}:`,
          error,
        );
      }
    }

    await this.persistBundle(bundle);
  }

  /**
   * Synchronize an active bundle after a wallet emits an external
   * EIP-1193 chainChanged event. The wallet has already switched, so this
   * updates local state without issuing a second wallet_switch request.
   */
  async syncExternalChain(chainId: string): Promise<void> {
    validateChainId(chainId);

    const bundle = this.getActiveBundle();
    if (!bundle || bundle.activeChainId === chainId) return;

    const previousChainId = bundle.activeChainId;
    if (!bundle.chainSessions.has(chainId)) {
      const chainSession = this.createChainSession(
        chainId,
        bundle.walletSession.connectorId ?? bundle.walletSession.walletType,
      );
      bundle.chainSessions.set(chainId, chainSession);
      this.emit("chainSessionAdded", { bundle, chainSession });
    }

    bundle.activeChainId = chainId;
    bundle.lastActiveAt = new Date().toISOString();
    this.updateSessionNamespace(bundle.walletSession, chainId);
    this.emit("chainChanged", { bundle, previousChainId, newChainId: chainId });
    await this.persistBundle(bundle);
  }

  /**
   * Disconnect the active session.
   * Cleans up all chain sessions and clears storage.
   */
  async disconnect(): Promise<void> {
    const bundle = this.getActiveBundle();
    if (!bundle) return;

    const connector = this.resolveConnector(bundle.walletSession);
    try {
      await connector.disconnect(bundle.walletSession);
    } catch (error) {
      logger.warn("session-manager", "Disconnect error:", error);
    }

    const connectorId =
      bundle.walletSession.connectorId ?? bundle.walletSession.walletType;
    const topic = bundle.walletSession.topic;
    const bundleId = this.activeBundleId;

    if (bundleId) {
      this.bundles.delete(bundleId);
    }
    this.activeBundleId = null;

    await this.persistence.clear();

    this.emit("sessionDisconnected", { connectorId, topic });
  }

  /**
   * Disconnect a specific chain session within the active bundle.
   * Does not disconnect the entire wallet.
   */
  async disconnectChain(chainId: string): Promise<void> {
    const bundle = this.getActiveBundle();
    if (!bundle) {
      throw createSessionError("no_active_session");
    }

    const removed = bundle.chainSessions.delete(chainId);
    if (removed) {
      this.emit("chainSessionRemoved", { bundle, chainId });

      // If the active chain was removed, move to the first available
      if (bundle.activeChainId === chainId) {
        const remaining = Array.from(bundle.chainSessions.keys());
        bundle.activeChainId = remaining[0] ?? bundle.activeChainId;
      }

      await this.persistBundle(bundle);
    }
  }

  /**
   * Get the active chain session.
   */
  getActiveChainSession(): ChainSession | undefined {
    const bundle = this.getActiveBundle();
    if (!bundle) return undefined;
    return bundle.chainSessions.get(bundle.activeChainId);
  }

  /**
   * Get all active chain sessions across all connected bundles.
   */
  getAllChainSessions(): ChainSession[] {
    const sessions: ChainSession[] = [];
    for (const bundle of this.bundles.values()) {
      bundle.chainSessions.forEach((session) => {
        sessions.push(session);
      });
    }
    return sessions;
  }

  /**
   * Get all active session bundles.
   */
  getAllActiveSessions(): ActiveSessionBundle[] {
    return Array.from(this.bundles.values());
  }

  /**
   * Get the currently active session bundle.
   */
  getActiveBundle(): ActiveSessionBundle | null {
    if (!this.activeBundleId) return null;
    return this.bundles.get(this.activeBundleId) ?? null;
  }

  // ── Fee Estimation Sync ─────────────────────────────────────────────

  /**
   * Refresh fee estimation for a specific chain.
   * Called automatically on switchChain if autoRefreshFeeOnSwitch is enabled.
   */
  async refreshFees(
    chainId?: string,
    options?: RefreshFeesOptions,
  ): Promise<FeeValues | null> {
    const bundle = this.getActiveBundle();
    if (!bundle) {
      throw createSessionError("no_active_session");
    }

    const targetChainId = chainId ?? bundle.activeChainId;
    const chainSession = bundle.chainSessions.get(targetChainId);
    if (!chainSession) return null;

    try {
      const feeConfig: FeeEstimationConfig = {
        rpcUrl: chainSession.rpcUrl,
        chainId: targetChainId,
      };

      // Apply user fee overrides if present for this chain
      const overrides = this.userFeeOverrides[targetChainId];
      if (overrides) {
        if (overrides.type) feeConfig.type = overrides.type;
        if (overrides.maxPriorityFeePerGas !== undefined) {
          feeConfig.maxPriorityFeePerGas = overrides.maxPriorityFeePerGas;
        }
        if (overrides.baseFeeMultiplier !== undefined) {
          feeConfig.baseFeeMultiplier = overrides.baseFeeMultiplier;
        }
      }

      // Apply per-call overrides from options
      if (options?.userOverrides) {
        Object.assign(feeConfig, options.userOverrides);
      }

      const fees = await estimateFees(feeConfig);

      chainSession.lastKnownFees = fees;
      chainSession.lastFeeUpdatedAt = new Date().toISOString();

      this.emit("feesUpdated", { chainId: targetChainId, fees });

      return fees;
    } catch (error: any) {
      // If RPC fails, keep cached values and emit warning
      logger.warn(
        "session-manager",
        `Fee refresh failed for ${targetChainId}:`,
        error,
      );
      return chainSession.lastKnownFees ?? null;
    }
  }

  // ── User Fee Overrides ──────────────────────────────────────────────

  /**
   * Set user fee overrides for a specific chain.
   * Overrides are preserved across chain switches.
   */
  setUserFeeOverrides(
    chainId: string,
    overrides: Partial<UserFeeOverrides[string]>,
  ): void {
    const existing = this.userFeeOverrides[chainId] ?? {};
    this.userFeeOverrides[chainId] = { ...existing, ...overrides };
  }

  /**
   * Get the current user fee overrides for a specific chain.
   */
  getUserFeeOverrides(chainId: string): UserFeeOverrides[string] | undefined {
    return this.userFeeOverrides[chainId];
  }

  /**
   * Clear user fee overrides for a specific chain.
   */
  clearUserFeeOverrides(chainId?: string): void {
    if (chainId) {
      delete this.userFeeOverrides[chainId];
    } else {
      this.userFeeOverrides = {};
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  /**
   * Attempt to restore a session from persistence.
   * Returns true if a session was restored, false otherwise.
   */
  async restoreFromPersistence(): Promise<boolean> {
    const data = await this.persistence.load();
    if (!data) return false;

    const bundle = this.persistence.deserializeToBundle(data);
    if (!bundle) {
      await this.persistence.clear();
      return false;
    }

    const bundleId = this.getBundleId(bundle.walletSession);
    // Restoration can happen before the UI has registered every connector.
    // Adopt when the connector is available, but keep the persisted bundle so
    // a later provider bootstrap can register it and take ownership.
    const connectorId =
      bundle.walletSession.connectorId ?? bundle.walletSession.walletType;
    if (this.connectorManager.get(connectorId)) {
      this.connectorManager.adopt(bundle.walletSession);
    }
    this.bundles.set(bundleId, bundle);
    this.activeBundleId = bundleId;

    this.emit("sessionConnected", { bundle });
    return true;
  }

  // ── Internal Helpers ────────────────────────────────────────────────

  /**
   * Build a bundle from a wallet session, marking the given chain as active.
   */
  private buildBundle(
    session: UniversalWalletSession,
    activeChainId: string,
    walletType: string,
  ): ActiveSessionBundle {
    const chainSessions = new Map<string, ChainSession>();

    // Parse existing session namespaces to build chain sessions
    for (const [, namespace] of Object.entries(session.namespaces)) {
      const ns = namespace as SessionNamespace;
      for (const chain of ns.chains) {
        if (!chainSessions.has(chain)) {
          chainSessions.set(chain, this.createChainSession(chain, walletType));
        }
      }
    }

    // If the requested chain isn't in the namespaces yet, add it
    if (!chainSessions.has(activeChainId)) {
      chainSessions.set(
        activeChainId,
        this.createChainSession(activeChainId, walletType),
      );
    }

    return {
      walletSession: session,
      chainSessions,
      activeChainId,
      lastActiveAt: new Date().toISOString(),
    };
  }

  /**
   * Create a ChainSession for the given chain ID.
   * Resolves RPC URL, native currency, and block explorer from config
   * or defaults.
   */
  private createChainSession(
    chainId: string,
    connectorId: string,
  ): ChainSession {
    validateChainId(chainId);
    const { namespace } = parseChainId(chainId);

    const nativeCurrency = this.config.defaultCurrencies?.[chainId] ??
      DEFAULT_CHAIN_METADATA[chainId] ?? {
        name: chainId,
        symbol: chainId.includes(":") ? chainId.split(":")[1] : chainId,
        decimals: NAMESPACE_NATIVE_DECIMALS[namespace],
      };

    const rpcUrl =
      this.config.defaultRpcUrls?.[chainId] ?? DEFAULT_RPC_URLS[chainId] ?? "";

    const blockExplorer =
      this.config.defaultExplorers?.[chainId] ?? DEFAULT_EXPLORERS[chainId];

    return {
      chainId,
      connectorId,
      rpcUrl,
      nativeCurrency,
      blockExplorer,
    };
  }

  /**
   * Update the UniversalWalletSession namespaces to reflect
   * the current active chain.
   */
  private updateSessionNamespace(
    session: UniversalWalletSession,
    chainId: string,
  ): void {
    const { namespace, reference } = parseChainId(chainId);

    if (!session.namespaces[namespace]) {
      session.namespaces[namespace] = {
        chains: [],
        accounts: [],
        methods: [],
        events: [],
      };
    }

    // `namespaces[ns].chains` carries two contracts at once: this manager
    // treats it as the set of known chains (activeChainId tracks the active
    // one), while every connector that reads it — evm-injected, coinbase,
    // embedded, reown — treats `chains[0]` as the active chain. Appending
    // satisfies the first and silently fails the second, which is why the
    // connectors all rewrite the array themselves. Promote instead, so both
    // readings agree and a connector that relies on this path is not handed a
    // stale head.
    const ns = session.namespaces[namespace];
    ns.chains = [chainId, ...ns.chains.filter((c) => c !== chainId)];
  }

  /**
   * Resolve the appropriate connector for a given wallet session.
   */
  private resolveConnector(
    session: UniversalWalletSession,
  ): UniversalConnector {
    const connectorId = session.connectorId ?? session.walletType;
    const connector = this.connectorManager.get(connectorId);
    if (!connector) {
      throw createSessionError(
        "chain_unsupported",
        `No connector found for connector: ${connectorId}`,
      );
    }
    return connector;
  }

  /**
   * Get a unique bundle ID from a wallet session.
   */
  private getBundleId(session: UniversalWalletSession): string {
    return session.topic ?? session.id;
  }

  /**
   * Persist the active bundle to storage.
   */
  private async persistBundle(bundle: ActiveSessionBundle): Promise<void> {
    const data = this.persistence.serializeBundle(bundle);
    await this.persistence.save(data);
  }
}

/**
 * Create a SessionManager instance.
 */
export function createSessionManager(
  connectorManager: ConnectorManager,
  config?: SessionManagerConfig,
): SessionManager {
  return new SessionManager(connectorManager, config);
}
