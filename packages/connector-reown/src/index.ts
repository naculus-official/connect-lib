import type { UniversalWalletSession } from "@naculus/connect-core";
import { extractAccounts, WalletError } from "@naculus/connect-core";
import {
  type WalletConnectConfig,
  WalletConnectConnector,
} from "@naculus/connector-walletconnect";

export type {
  WalletConnectConfig,
  WalletConnectConnectInput,
  WalletConnectConnector,
  WalletConnectMetadata,
} from "@naculus/connector-walletconnect";

/**
 * Reown AppKit-compatible adapter for @naculus/connector-walletconnect.
 *
 * Provides `createNaculusAppKitAdapter()` which returns an adapter object
 * that can be used with Reown AppKit's `adapters` option. This allows any
 * dApp using Reown AppKit to integrate Naculus's WalletConnect connector
 * as a first-class wallet option.
 *
 * The adapter wraps a WalletConnectConnector and exposes AppKit-compatible
 * connect, disconnect, and reconnection flows.
 *
 * @example
 * ```typescript
 * import { createNaculusAppKitAdapter } from "@naculus/connector-reown";
 * import { createAppKit } from "@reown/appkit";
 *
 * const naculusAdapter = createNaculusAppKitAdapter({
 *   projectId: "your-project-id",
 *   metadata: { name: "My DApp", description: "...", url: "...", icons: [] },
 * });
 *
 * const appKit = createAppKit({
 *   projectId: "your-project-id",
 *   adapters: [naculusAdapter],
 *   networks: [mainnet, polygon],
 *   metadata: { name: "My DApp", description: "...", url: "...", icons: [] },
 * });
 * ```
 */
export function createNaculusAppKitAdapter(
  config: WalletConnectConfig,
): NaculusAppKitAdapter {
  return new NaculusAppKitAdapter(config);
}

/**
 * Naculus AppKit adapter class.
 *
 * Provides an interface compatible with Reown AppKit's expected adapter shape.
 * Each instance wraps a WalletConnectConnector and exposes:
 * - `connect()` / `disconnect()` / `reconnect()`
 * - `getAccounts()` / `getChainId()`
 * - EIP-1193 provider via `getProvider()`
 * - Standard event emitter interface
 */
export class NaculusAppKitAdapter {
  /** Adapter identity */
  readonly id = "naculus";
  readonly name = "Naculus";

  /** Underlying Naculus WalletConnect connector */
  readonly connector: WalletConnectConnector;

  private currentSession?: UniversalWalletSession;
  private currentChainId?: string;
  private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  constructor(config: WalletConnectConfig) {
    this.connector = new WalletConnectConnector(config);
  }

  /**
   * Connect to a wallet.
   * Returns EIP-1193 provider and account info.
   */
  async connect(input?: unknown): Promise<{
    provider: NaculusProvider;
    accounts: string[];
    chainId: number;
  }> {
    const session = await this.connector.connect(input);
    this.currentSession = session;

    const accounts = extractAccounts(session.namespaces).map(
      (a: string) => a.split(":").pop()!,
    );

    // Determine chain ID from session
    const evmChains = session.namespaces.eip155?.chains;
    if (evmChains && evmChains.length > 0) {
      this.currentChainId = evmChains[0];
    } else {
      this.currentChainId = "eip155:1";
    }

    const chainId = Number(this.currentChainId.split(":")[1]);

    return {
      provider: this.createProvider(),
      accounts,
      chainId,
    };
  }

  /**
   * Disconnect the current session.
   */
  async disconnect(): Promise<void> {
    if (this.currentSession) {
      await this.connector.disconnect(this.currentSession);
      this.currentSession = undefined;
      this.currentChainId = undefined;
    }
  }

  /**
   * Reconnect to an existing session.
   */
  async reconnect(session: UniversalWalletSession): Promise<{
    provider: NaculusProvider;
    accounts: string[];
    chainId: number;
  }> {
    const restored = await this.connector.reconnect(session);
    this.currentSession = restored;

    const accounts = extractAccounts(restored.namespaces).map(
      (a: string) => a.split(":").pop()!,
    );

    const evmChains = restored.namespaces.eip155?.chains;
    const chainId = evmChains ? Number(evmChains[0].split(":")[1]) : 1;

    return {
      provider: this.createProvider(),
      accounts,
      chainId,
    };
  }

  /**
   * Get connected accounts.
   */
  async getAccounts(): Promise<string[]> {
    if (!this.currentSession) return [];
    const accounts = extractAccounts(this.currentSession.namespaces).map(
      (a: string) => a.split(":").pop()!,
    );
    return [...new Set(accounts)];
  }

  /**
   * Get the current chain ID.
   */
  async getChainId(): Promise<number> {
    if (this.currentChainId) {
      return Number(this.currentChainId.split(":")[1]);
    }

    if (this.currentSession?.namespaces.eip155?.chains[0]) {
      return Number(
        this.currentSession.namespaces.eip155.chains[0].split(":")[1],
      );
    }

    return 1;
  }

  /**
   * Get EIP-1193 provider.
   */
  getProvider(): NaculusProvider {
    return this.createProvider();
  }

  /**
   * Switch to a different chain.
   */
  async switchChain(chainId: number): Promise<void> {
    const caip2Chain = `eip155:${chainId}`;

    if (this.currentSession) {
      try {
        await this.connector.switchChain(this.currentSession, caip2Chain);
      } catch (error) {
        throw new WalletError(
          "chain_switch_rejected",
          `Failed to switch to chain ${chainId}: ${error}`,
        );
      }
    }

    this.currentChainId = caip2Chain;
  }

  /**
   * Sign a message.
   */
  async signMessage(
    message: string,
    address: string,
    chainId?: number,
  ): Promise<string> {
    if (!this.currentSession) {
      throw new WalletError("session_expired", "No active session.");
    }

    const result = await this.connector.signMessage(this.currentSession, {
      message,
      address,
      chainId: chainId ? `eip155:${chainId}` : undefined,
    });

    return String(result);
  }

  /**
   * Send a transaction.
   */
  async sendTransaction(
    transaction: Record<string, unknown>,
    chainId?: number,
  ): Promise<string> {
    if (!this.currentSession) {
      throw new WalletError("session_expired", "No active session.");
    }

    const result = await this.connector.sendTransaction(this.currentSession, {
      transaction,
      chainId: chainId ? `eip155:${chainId}` : undefined,
    });

    return String(result);
  }

  /**
   * Sign typed data (EIP-712)
   */
  async signTypedData(
    typedData: string,
    address: string,
    chainId?: number,
  ): Promise<string> {
    if (!this.currentSession) {
      throw new WalletError("session_expired", "No active session.");
    }

    const result = await this.connector.signTypedData(this.currentSession, {
      typedData,
      address,
      chainId: chainId ? `eip155:${chainId}` : undefined,
    });

    return String(result);
  }

  /**
   * Get the current session, if any.
   */
  getSession(): UniversalWalletSession | undefined {
    return this.currentSession;
  }

  /**
   * Listen for events.
   */
  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  /**
   * Remove event listener.
   */
  removeListener(event: string, handler: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((handler) => handler(...args));
    }
  }

  private createProvider(): NaculusProvider {
    return {
      request: async ({
        method,
        params,
      }: {
        method: string;
        params?: unknown[];
      }) => {
        if (!this.currentSession) {
          throw new WalletError("session_expired", "No active session.");
        }
        return this.connector.request({
          method,
          params: params ?? [],
        });
      },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        this.on(event, handler);
      },
      removeListener: (
        event: string,
        handler: (...args: unknown[]) => void,
      ) => {
        this.removeListener(event, handler);
      },
    };
  }
}

/** Minimal EIP-1193 provider interface */
export interface NaculusProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * Type guard: check if an object is a NaculusAppKitAdapter.
 */
export function isNaculusAppKitAdapter(
  obj: unknown,
): obj is NaculusAppKitAdapter {
  return obj instanceof NaculusAppKitAdapter;
}
