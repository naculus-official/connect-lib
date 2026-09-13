import type { UniversalWalletSession } from "@naculus/connect-core";
import { WalletError } from "@naculus/connect-core";
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

function normalizeNumericChainId(chainId: number): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new WalletError(
      "chain_unsupported",
      `Invalid EIP-155 chain ID: ${chainId}`,
    );
  }
  return chainId;
}

function parseEip155ChainId(chainId: string): number {
  if (!/^eip155:[1-9][0-9]*$/.test(chainId)) {
    throw new WalletError(
      "chain_unsupported",
      `Invalid EIP-155 chain ID: ${chainId}`,
    );
  }
  return normalizeNumericChainId(
    Number(BigInt(chainId.slice("eip155:".length))),
  );
}

function extractEvmAddress(account: string): string {
  const parts = account.split(":");
  const address = parts.length === 3 ? parts[2] : undefined;
  if (
    parts[0] !== "eip155" ||
    !address ||
    !/^0x[a-fA-F0-9]{40}$/.test(address)
  ) {
    throw new WalletError(
      "wallet_unavailable",
      `Invalid EIP-155 account: ${account}`,
    );
  }
  return address;
}

/** Return only accounts authorized for the requested EIP-155 chain. */
function extractEvmAccountsForChain(
  accounts: string[],
  chainId: string,
): string[] {
  const reference = chainId.slice("eip155:".length);
  return [
    ...new Set(
      accounts
        .filter((account) => {
          const parts = account.split(":");
          return (
            parts.length === 3 &&
            parts[0] === "eip155" &&
            parts[1] === reference
          );
        })
        .map(extractEvmAddress),
    ),
  ];
}

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

    const evmNamespace = session.namespaces.eip155;
    if (!evmNamespace?.chains[0]) {
      throw new WalletError(
        "chain_unsupported",
        "Reown adapter requires an EIP-155 namespace.",
      );
    }
    // Determine chain ID from session
    const evmChains = evmNamespace.chains;
    this.currentChainId = evmChains[0];

    const chainId = parseEip155ChainId(this.currentChainId);
    const accounts = extractEvmAccountsForChain(
      evmNamespace.accounts,
      this.currentChainId,
    );

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

    const evmNamespace = restored.namespaces.eip155;
    if (!evmNamespace?.chains[0]) {
      throw new WalletError(
        "chain_unsupported",
        "Reown adapter requires an EIP-155 namespace.",
      );
    }
    const chainId = parseEip155ChainId(evmNamespace.chains[0]);
    this.currentChainId = evmNamespace.chains[0];
    const accounts = extractEvmAccountsForChain(
      evmNamespace.accounts,
      this.currentChainId,
    );

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
    const namespace = this.currentSession.namespaces.eip155;
    if (!namespace?.chains[0]) return [];
    return extractEvmAccountsForChain(
      namespace.accounts,
      this.currentChainId ?? namespace.chains[0],
    );
  }

  /**
   * Get the current chain ID.
   */
  async getChainId(): Promise<number> {
    if (this.currentChainId) {
      return parseEip155ChainId(this.currentChainId);
    }

    if (this.currentSession?.namespaces.eip155?.chains[0]) {
      return parseEip155ChainId(
        this.currentSession.namespaces.eip155.chains[0],
      );
    }

    throw new WalletError(
      "session_expired",
      "No active WalletConnect session.",
    );
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
    chainId = normalizeNumericChainId(chainId);
    if (!this.currentSession) {
      throw new WalletError(
        "session_expired",
        "No active WalletConnect session.",
      );
    }
    const caip2Chain = `eip155:${chainId}`;

    try {
      await this.connector.switchChain(this.currentSession, caip2Chain);
    } catch (error) {
      throw new WalletError(
        "chain_switch_rejected",
        `Failed to switch to chain ${chainId}: ${error}`,
      );
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
      chainId:
        chainId !== undefined
          ? `eip155:${normalizeNumericChainId(chainId)}`
          : undefined,
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
      chainId:
        chainId !== undefined
          ? `eip155:${normalizeNumericChainId(chainId)}`
          : undefined,
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
      chainId:
        chainId !== undefined
          ? `eip155:${normalizeNumericChainId(chainId)}`
          : undefined,
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
