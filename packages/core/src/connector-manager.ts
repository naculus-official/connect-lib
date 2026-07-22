/**
 * Connector Manager
 *
 * Manages multiple wallet connectors and provides a unified interface
 * for connecting, disconnecting, and managing wallet connections.
 */

import type {
  BatchCall,
  ConnectorSupport,
  UniversalConnector,
  WalletCapabilities,
} from "./connector";
import { WalletError } from "./errors";
import { isMobileBrowser } from "./platform";
import type { UniversalWalletSession } from "./session";

export type ConnectorId = string;

export interface ConnectorEntry {
  id: ConnectorId;
  connector: UniversalConnector;
  priority: number;
}

export interface ConnectorManagerConfig {
  autoSelect?: boolean;
  preferOrder?: ConnectorId[];
}

export class ConnectorManager {
  private connectors: Map<ConnectorId, UniversalConnector> = new Map();
  private entries: Map<ConnectorId, ConnectorEntry> = new Map();
  private activeConnectorId: ConnectorId | null = null;
  private activeSession: UniversalWalletSession | null = null;
  private config: ConnectorManagerConfig;

  /** Prevent concurrent connect() calls from overwriting sessions */
  private _connecting = false;

  constructor(config: ConnectorManagerConfig = {}) {
    this.config = {
      autoSelect: config.autoSelect ?? true,
      preferOrder: config.preferOrder ?? [],
    };
  }

  register(id: ConnectorId, connector: UniversalConnector, priority = 0): void {
    this.connectors.set(id, connector);
    this.entries.set(id, { id, connector, priority });
  }

  unregister(id: ConnectorId): void {
    this.connectors.delete(id);
    this.entries.delete(id);
    if (this.activeConnectorId === id) {
      this.activeConnectorId = null;
    }
  }

  get(id: ConnectorId): UniversalConnector | undefined {
    return this.connectors.get(id);
  }

  getActive(): UniversalConnector | undefined {
    if (!this.activeConnectorId) return undefined;
    return this.connectors.get(this.activeConnectorId);
  }

  getActiveSession(): UniversalWalletSession | null {
    return this.activeSession;
  }

  list(): ConnectorEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => b.priority - a.priority,
    );
  }

  listBySupport(support: keyof ConnectorSupport): UniversalConnector[] {
    return this.list()
      .map((entry) => entry.connector)
      .filter((connector) => connector.supports[support]);
  }

  async connect(
    id?: ConnectorId,
    input?: unknown,
  ): Promise<UniversalWalletSession> {
    if (this._connecting) {
      throw new Error("Connection already in progress");
    }
    this._connecting = true;

    try {
      let connector: UniversalConnector | undefined;

      if (id) {
        connector = this.connectors.get(id);
        if (!connector) {
          throw new Error(`Connector "${id}" not found`);
        }
      } else if (this.config.autoSelect) {
        connector = this.selectBestConnector();
        if (!connector) {
          throw new Error("No connectors available");
        }
      } else {
        throw new Error("No connector specified and autoSelect is disabled");
      }

      const session = await connector.connect(input);
      this.activeConnectorId = connector.id;
      this.activeSession = session;
      return session;
    } finally {
      this._connecting = false;
    }
  }

  async reconnect(
    session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    if (this._connecting) {
      throw new Error("Connection already in progress");
    }
    this._connecting = true;

    try {
      if (!session.topic) {
        throw new Error("Reconnection not supported for this session type");
      }

      const connectorId =
        this.activeConnectorId ?? this.connectors.keys().next().value;
      const connector = connectorId ? this.get(connectorId) : null;

      if (connector?.reconnect) {
        const newSession = await connector.reconnect(session);
        this.activeConnectorId = connectorId!;
        this.activeSession = newSession;
        return newSession;
      }

      throw new Error(
        `Reconnection not supported by connector "${connectorId ?? "unknown"}"`,
      );
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.activeConnectorId || !this.activeSession) {
      return;
    }

    const connector = this.connectors.get(this.activeConnectorId);
    if (connector) {
      await connector.disconnect(this.activeSession);
    }

    this.activeConnectorId = null;
    this.activeSession = null;
  }

  async getAccounts(): Promise<string[]> {
    if (!this.activeConnectorId || !this.activeSession) {
      return [];
    }

    const connector = this.connectors.get(this.activeConnectorId);
    if (!connector) {
      return [];
    }

    return connector.getAccounts(this.activeSession);
  }

  async signMessage(input: {
    message: string;
    account?: string;
  }): Promise<unknown> {
    if (!this.activeConnectorId || !this.activeSession) {
      throw new Error("No active session");
    }

    const connector = this.connectors.get(this.activeConnectorId);
    if (!connector?.signMessage) {
      throw new Error("signMessage not supported by this connector");
    }

    return connector.signMessage(this.activeSession, input);
  }

  async sendTransaction(input: unknown): Promise<unknown> {
    if (!this.activeConnectorId || !this.activeSession) {
      throw new Error("No active session");
    }

    const connector = this.connectors.get(this.activeConnectorId);
    if (!connector?.sendTransaction) {
      throw new Error("sendTransaction not supported by this connector");
    }

    return connector.sendTransaction(this.activeSession, input);
  }

  async switchChain(chainId: string): Promise<void> {
    if (!this.activeConnectorId || !this.activeSession) {
      throw new Error("No active session");
    }

    const connector = this.connectors.get(this.activeConnectorId);
    if (!connector?.switchChain) {
      throw new Error("switchChain not supported by this connector");
    }

    await connector.switchChain(this.activeSession, chainId);
  }

  async request(request: {
    method: string;
    params: unknown[];
  }): Promise<unknown> {
    const connector = this.getActive();
    if (!connector?.request)
      throw new WalletError(
        "method_not_allowed",
        "RPC requests not supported by active connector",
      );
    return connector.request(request);
  }

  async getBalance(chainId?: string): Promise<string> {
    const connector = this.getActive();
    if (!connector?.getBalance)
      throw new WalletError(
        "method_not_allowed",
        "Balance queries not supported by active connector",
      );
    return connector.getBalance(chainId);
  }

  async sendCalls(
    session: UniversalWalletSession,
    calls: BatchCall[],
    chainId?: string,
  ): Promise<string> {
    if (!this.activeConnectorId || !this.activeSession) {
      throw new Error("No active session");
    }

    const connector = this.connectors.get(this.activeConnectorId);
    if (!connector?.sendCalls) {
      throw new Error("sendCalls not supported by this connector");
    }

    return connector.sendCalls(session, calls, chainId);
  }

  async getCapabilities(
    session: UniversalWalletSession,
  ): Promise<Record<string, WalletCapabilities>> {
    if (!this.activeConnectorId || !this.activeSession) {
      throw new Error("No active session");
    }

    const connector = this.connectors.get(this.activeConnectorId);
    if (!connector?.getCapabilities) {
      throw new Error("getCapabilities not supported by this connector");
    }

    return connector.getCapabilities(session);
  }

  clear(): void {
    this.connectors.clear();
    this.entries.clear();
    this.activeConnectorId = null;
    this.activeSession = null;
  }

  private selectBestConnector(): UniversalConnector | undefined {
    const available = this.list();

    if (this.config.preferOrder && this.config.preferOrder.length > 0) {
      for (const preferredId of this.config.preferOrder) {
        const entry = this.entries.get(preferredId);
        if (entry) {
          return entry.connector;
        }
      }
    }

    const isMobile = isMobileBrowser();

    for (const entry of available) {
      const support = entry.connector.supports;
      if (isMobile && support.mobile) {
        return entry.connector;
      }
      if (!isMobile && support.desktop) {
        return entry.connector;
      }
    }

    return available[0]?.connector;
  }
}

export function createConnectorManager(
  config?: ConnectorManagerConfig,
): ConnectorManager {
  return new ConnectorManager(config);
}
