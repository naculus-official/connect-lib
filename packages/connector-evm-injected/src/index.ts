import type {
  BatchCall,
  ConnectorSupport,
  UniversalConnector,
  UniversalWalletSession,
  WalletCapabilities,
} from "@naculus/connect-core";
import {
  CONNECTOR_ERROR_MESSAGES,
  createEmptySession,
  detectPlatform,
  extractAccountsFromPermissions,
  getPermissions,
  hasPermission,
  requestPermissions,
  WalletError,
} from "@naculus/connect-core";
import { CHAIN_METADATA } from "./chain";
import {
  EIP6963_ANNOUNCE_EVENT,
  EIP6963_REQUEST_EVENT,
  isCoinbaseWalletInstalled,
  isMetaMaskInstalled,
} from "./discovery";
import type {
  DiscoveredWallet,
  EIP6963ProviderInfo,
  EIP6963Session,
  Eip6963EthereumProvider,
} from "./types";
import { toHexValue } from "./utils";

export { isCoinbaseWalletInstalled, isMetaMaskInstalled } from "./discovery";
export {
  DiscoveredWallet,
  EIP6963Provider,
  EIP6963ProviderInfo,
  EIP6963Session,
  Eip6963EthereumProvider,
} from "./types";

interface StoredEventHandler {
  wallet: DiscoveredWallet;
  accountsHandler: (...args: unknown[]) => void;
  chainHandler: (...args: unknown[]) => void;
}

const SUPPORT: ConnectorSupport = {
  desktop: true,
  mobile: true,
  deepLink: true,
  qr: false,
  trustedReconnect: true,
};

class EIP6963ConnectorImpl implements UniversalConnector {
  readonly id = "eip6963";
  readonly name = "EIP-6963 Injected Wallets";
  readonly kind = "eip6963" as const;
  readonly namespaces = ["eip155"];
  readonly supports = SUPPORT;

  private discoveredWallets: Map<string, DiscoveredWallet> = new Map();
  private listeners: Set<(wallets: DiscoveredWallet[]) => void> = new Set();
  private announceHandler: ((...args: unknown[]) => void) | null = null;
  private activeSessions: Map<string, EIP6963Session> = new Map();
  private storedEventHandlers: Map<string, StoredEventHandler> = new Map();

  startDiscovery(): void {
    if (typeof window === "undefined") return;

    const handler: (...args: unknown[]) => void = (event: unknown) => {
      if (!event || typeof event !== "object") return;
      const e = event as Record<string, unknown>;
      const detail = e.detail as
        | { info?: EIP6963ProviderInfo; provider?: Eip6963EthereumProvider }
        | undefined;
      if (detail?.info && detail?.provider) {
        this.handleAnnouncement(detail.info, detail.provider);
      }
    };

    this.announceHandler = handler;
    window.addEventListener(EIP6963_ANNOUNCE_EVENT, handler);

    window.dispatchEvent(new Event(EIP6963_REQUEST_EVENT));
  }

  stopDiscovery(): void {
    if (typeof window === "undefined" || !this.announceHandler) return;

    window.removeEventListener(EIP6963_ANNOUNCE_EVENT, this.announceHandler);
    this.announceHandler = null;
  }

  private handleAnnouncement(
    info: EIP6963ProviderInfo,
    provider: Eip6963EthereumProvider,
  ): void {
    if (this.discoveredWallets.has(info.uuid)) return;

    const wallet: DiscoveredWallet = {
      id: info.uuid,
      name: info.name,
      icon: info.icon,
      rdns: info.rdns,
      provider,
    };

    this.discoveredWallets.set(info.uuid, wallet);
    this.notifyListeners();
  }

  getDiscoveredWallets(): DiscoveredWallet[] {
    return Array.from(this.discoveredWallets.values());
  }

  async connect(input?: unknown): Promise<UniversalWalletSession> {
    let wallet: DiscoveredWallet | undefined;

    if (!input) {
      const wallets = this.getDiscoveredWallets();
      if (wallets.length === 0) {
        throw new WalletError(
          "wallet_unavailable",
          "No wallets discovered. Please call startDiscovery() to find available wallets.",
        );
      }
      wallet = wallets[0];
    } else if (typeof input === "string") {
      wallet = this.getWalletByRDNS(input);
      if (!wallet) {
        throw new WalletError(
          "wallet_unavailable",
          `Wallet "${input}" not found. Please check the wallet RDNS.`,
        );
      }
    } else if (typeof input === "object" && "provider" in input) {
      wallet = input as DiscoveredWallet;
    } else if (typeof input === "object") {
      wallet = this.getDiscoveredWallets()[0];
    }

    if (!wallet) {
      throw new WalletError("wallet_unavailable", "No wallet available.");
    }

    const chainIdInput =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>)
        : undefined;
    const chainId =
      chainIdInput && typeof chainIdInput.chainId === "string"
        ? chainIdInput.chainId
        : undefined;

    let accounts: string[];

    const existingPermissions = await getPermissions(wallet.provider);
    if (hasPermission(existingPermissions ?? [], "eth_accounts")) {
      accounts = extractAccountsFromPermissions(existingPermissions ?? []);
      if (accounts.length === 0) {
        accounts = (await wallet.provider.request({
          method: "eth_requestAccounts",
          params: chainId ? [{ chainId }] : [],
        })) as string[];
      }
    } else {
      try {
        await requestPermissions(wallet.provider);
        accounts = (await wallet.provider.request({
          method: "eth_requestAccounts",
          params: chainId ? [{ chainId }] : [],
        })) as string[];
      } catch {
        accounts = (await wallet.provider.request({
          method: "eth_requestAccounts",
          params: chainId ? [{ chainId }] : [],
        })) as string[];
      }
    }

    const eip155Accounts = accounts.map((acc) => `eip155:${acc}`);
    const strippedChainId = chainId?.startsWith("eip155:")
      ? chainId.split(":")[1]
      : chainId;
    const chains = strippedChainId ? [`eip155:${strippedChainId}`] : ["eip155:1"];
    const methods = [
      "eth_requestAccounts",
      "eth_sendTransaction",
      "personal_sign",
      "eth_signTypedData_v4",
    ];
    const events = ["accountsChanged", "chainChanged"];

    const session = createEmptySession({
      id: `eip6963-${wallet.id}-${Date.now()}`,
      walletId: wallet.id,
      walletType: "eip6963",
      namespaces: {
        eip155: {
          chains,
          accounts: eip155Accounts,
          methods,
          events,
          capabilities: {
            atomicBatch: { supported: false },
            permissions: true,
            serverSigning: false,
          },
        },
      },
      platform: detectPlatform(),
    });

    const eip6963Session: EIP6963Session = {
      wallet,
      accounts: eip155Accounts,
      chains,
      methods,
      events,
    };

    this.activeSessions.set(wallet.id, eip6963Session);

    this.setupEventListeners(wallet, session);
    this.setupPermissionsListener(wallet);

    return session;
  }

  async reconnect(
    session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    const wallet = Array.from(this.discoveredWallets.values()).find(
      (w) => w.id === session.walletId,
    );

    if (!wallet) {
      throw new WalletError(
        "session_expired",
        "EIP-6963 wallet not found. Please reconnect.",
      );
    }

    // Verify wallet is still accessible
    const accounts = (await wallet.provider.request({
      method: "eth_accounts",
    })) as string[];

    if (!accounts || accounts.length === 0) {
      throw new WalletError(
        "session_expired",
        "No accounts found. Please reconnect.",
      );
    }

    // Remove old event listeners if any, then setup fresh ones
    this.removeEventListeners(wallet);

    // Update session accounts from live provider
    const eip155Accounts = accounts.map((acc: string) => `eip155:${acc}`);
    const ns = session.namespaces.eip155;
    if (ns) {
      ns.accounts = eip155Accounts;
    }

    this.setupEventListeners(wallet, session);

    const eip6963Session: EIP6963Session = {
      wallet,
      accounts: eip155Accounts,
      chains: ns?.chains ?? [],
      methods: ns?.methods ?? [],
      events: ns?.events ?? [],
    };
    this.activeSessions.set(wallet.id, eip6963Session);

    return session;
  }

  private setupEventListeners(
    wallet: DiscoveredWallet,
    session: UniversalWalletSession,
  ): void {
    const accountsHandler = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (accounts.length === 0) {
        this.handleDisconnect(session);
      }
    };

    const chainHandler = (...args: unknown[]) => {
      const chainId = args[0] as string;
      const ns = session.namespaces["eip155"];
      if (ns) {
        ns.chains = [chainId];
      }
    };

    wallet.provider.on("accountsChanged", accountsHandler);
    wallet.provider.on("chainChanged", chainHandler);

    this.storedEventHandlers.set(wallet.id, {
      wallet,
      accountsHandler,
      chainHandler,
    });
  }

  private setupPermissionsListener(wallet: DiscoveredWallet): void {
    const permissionsHandler = async () => {
      const permissions = await getPermissions(wallet.provider);
      if (!hasPermission(permissions ?? [], "eth_accounts")) {
        this.activeSessions.delete(wallet.id);
      }
    };
    wallet.provider.on("permissionsChanged", permissionsHandler);
  }

  private handleDisconnect(session: UniversalWalletSession): void {
    const eip6963Session = Array.from(this.activeSessions.values()).find((s) =>
      session.namespaces.eip155?.accounts.some((acc) =>
        s.accounts.includes(acc),
      ),
    );

    if (eip6963Session) {
      this.removeEventListeners(eip6963Session.wallet);
      this.activeSessions.delete(eip6963Session.wallet.id);
    }
  }

  private removeEventListeners(wallet: DiscoveredWallet): void {
    const handlers = this.storedEventHandlers.get(wallet.id);
    if (handlers) {
      wallet.provider.removeListener(
        "accountsChanged",
        handlers.accountsHandler,
      );
      wallet.provider.removeListener("chainChanged", handlers.chainHandler);
      this.storedEventHandlers.delete(wallet.id);
    }
  }

  async disconnect(session: UniversalWalletSession): Promise<void> {
    const eip6963Session = Array.from(this.activeSessions.values()).find((s) =>
      session.namespaces.eip155?.accounts.some((acc) =>
        s.accounts.includes(acc),
      ),
    );

    if (eip6963Session) {
      this.removeEventListeners(eip6963Session.wallet);
      this.activeSessions.delete(eip6963Session.wallet.id);
    }

    if (session.id && session.id.startsWith("eip6963-")) {
      const walletId = session.id.replace("eip6963-", "");
      this.activeSessions.delete(walletId);
      this.storedEventHandlers.delete(walletId);
    }
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    const accounts = session.namespaces.eip155?.accounts ?? [];
    return accounts;
  }

  async signMessage(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!input || typeof input !== "object")
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );
    const inputObj = input as Record<string, unknown>;
    const rawMessage =
      typeof inputObj.message === "string" ? inputObj.message : undefined;
    const rawAddress =
      typeof inputObj.address === "string"
        ? inputObj.address
        : typeof inputObj.account === "string"
          ? inputObj.account
          : undefined;
    if (!rawMessage)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_MESSAGE,
      );
    const accounts = session.namespaces.eip155?.accounts ?? [];

    // Strip CAIP-10 prefix if present, fall back to session's first account
    const targetAccount = rawAddress?.includes(":")
      ? rawAddress.split(":").pop()!
      : (rawAddress ?? accounts[0]?.split(":").pop());
    if (!targetAccount) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_SIGNING,
      );
    }

    const eip6963Session = Array.from(this.activeSessions.values()).find((s) =>
      s.accounts.some((acc) => accounts.includes(acc)),
    );

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    // Hex-encode the message for personal_sign
    const hexMessage =
      rawMessage.startsWith("0x") && /^0x[0-9a-fA-F]*$/.test(rawMessage)
        ? rawMessage
        : "0x" +
          Array.from(new TextEncoder().encode(rawMessage))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");

    const result = await eip6963Session.wallet.provider.request({
      method: "personal_sign",
      params: [hexMessage, targetAccount],
    });

    return result;
  }

  async signTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!input || typeof input !== "object" || !("transaction" in input))
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_TX,
      );
    const inputObj = input as Record<string, unknown>;
    const transaction = inputObj.transaction as
      | { serialized?: number[] }
      | undefined;
    if (!transaction?.serialized || !Array.isArray(transaction.serialized))
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );
    const accounts = session.namespaces.eip155?.accounts ?? [];

    const fromAccount = accounts[0]?.split(":").pop();
    if (!fromAccount) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_SIGNING,
      );
    }

    const eip6963Session = Array.from(this.activeSessions.values()).find((s) =>
      s.accounts.some((acc) => accounts.includes(acc)),
    );

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    const txData = new Uint8Array(transaction.serialized).reduce(
      (str, byte) => str + byte.toString(16).padStart(2, "0"),
      "",
    );

    const result = await eip6963Session.wallet.provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: fromAccount,
          data: `0x${txData}`,
        },
      ],
    });

    return result;
  }

  async sendTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (input == null) throw new WalletError("invalid_input", "Invalid input");
    if (!input || typeof input !== "object" || !("transaction" in input))
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_TX,
      );
    const inputObj = input as Record<string, unknown>;
    const transactionRaw = inputObj.transaction;
    const transaction =
      transactionRaw && typeof transactionRaw === "object"
        ? (transactionRaw as Record<string, unknown>)
        : {};
    const accounts = session.namespaces.eip155?.accounts ?? [];

    const fromAccount =
      typeof transaction.from === "string"
        ? transaction.from
        : accounts[0]?.split(":").pop();
    if (!fromAccount) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
      );
    }

    const eip6963Session = Array.from(this.activeSessions.values()).find((s) =>
      s.accounts.some((acc) => accounts.includes(acc)),
    );

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    const result = await eip6963Session.wallet.provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: fromAccount,
          to: typeof transaction.to === "string" ? transaction.to : undefined,
          value:
            typeof transaction.value === "string"
              ? toHexValue(transaction.value)
              : undefined,
          data:
            typeof transaction.data === "string" ? transaction.data : undefined,
        },
      ],
    });

    return result;
  }

  async switchChain(
    session: UniversalWalletSession,
    chainId: string,
  ): Promise<void> {
    const accounts = session.namespaces.eip155?.accounts ?? [];
    if (accounts.length === 0) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNTS,
      );
    }

    const eip6963Session = Array.from(this.activeSessions.values()).find((s) =>
      s.accounts.some((acc) => accounts.includes(acc)),
    );

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    // Convert CAIP-10 chainId (e.g. "eip155:137") to hex format (e.g. "0x89")
    // as required by wallet_switchEthereumChain
    const hexChainId = chainId.startsWith("eip155:")
      ? `0x${parseInt(chainId.split(":")[1], 10).toString(16)}`
      : chainId;

    try {
      await eip6963Session.wallet.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }],
      });
    } catch (error: unknown) {
      // Error code 4902 = chain not recognized by wallet, add it first
      const rpcError = error as { code?: number; message?: string } | undefined;
      if (rpcError?.code === 4902) {
        const chainParams = CHAIN_METADATA[hexChainId];
        if (!chainParams) {
          throw new WalletError(
            "chain_unsupported",
            `Chain ${hexChainId} is not recognized. No metadata available to add it.`,
          );
        }
        await eip6963Session.wallet.provider.request({
          method: "wallet_addEthereumChain",
          params: [chainParams],
        });
        // Retry switch after adding the chain
        await eip6963Session.wallet.provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hexChainId }],
        });
      } else {
        throw new WalletError(
          "chain_unsupported",
          `Failed to switch chain: ${rpcError?.message ?? String(error)}`,
        );
      }
    }

    const currentChains = session.namespaces.eip155?.chains ?? [];
    if (!currentChains.includes(chainId)) {
      const newChains = [
        ...currentChains.filter((c) => c.startsWith("eip155:")),
        chainId,
      ];
      session.namespaces.eip155!.chains = newChains;
    }
  }

  async sendCalls(
    session: UniversalWalletSession,
    calls: BatchCall[],
    chainId?: string,
  ): Promise<string> {
    if (calls == null) throw new WalletError("invalid_input", "Invalid input");
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const fromAccount = accounts[0]?.split(":").pop();
    if (!fromAccount) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
      );
    }

    const eip6963Session = Array.from(this.activeSessions.values()).find((s) =>
      s.accounts.some((acc) => accounts.includes(acc)),
    );

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    try {
      const chainIdParam = chainId
        ? { chainId: `0x${parseInt(chainId.split(":")[1], 10).toString(16)}` }
        : {};
      const result = await eip6963Session.wallet.provider.request({
        method: "wallet_sendCalls",
        params: [
          {
            from: fromAccount,
            calls: calls.map((c) => ({
              to: c.to,
              value: c.value,
              data: c.data,
            })),
            ...chainIdParam,
          },
        ],
      });
      return result as string;
    } catch {
      const txHashes: string[] = [];
      for (const call of calls) {
        const hash = await eip6963Session.wallet.provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: fromAccount,
              to: call.to,
              value: call.value,
              data: call.data,
            },
          ],
        });
        txHashes.push(hash as string);
      }
      return txHashes.length === 1 ? txHashes[0] : txHashes.join(",");
    }
  }

  async getCapabilities(
    session: UniversalWalletSession,
  ): Promise<Record<string, WalletCapabilities>> {
    const eip6963Session = Array.from(this.activeSessions.values()).find((s) =>
      session.namespaces.eip155?.accounts.some((acc) =>
        s.accounts.includes(acc),
      ),
    );

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    const chains = session.namespaces.eip155?.chains ?? ["eip155:1"];
    const capabilities: Record<string, WalletCapabilities> = {};

    try {
      const result = (await eip6963Session.wallet.provider.request({
        method: "wallet_getCapabilities",
        params: [],
      })) as Record<string, Record<string, unknown>>;

      for (const chain of chains) {
        const caps = result[chain] ?? {};
        capabilities[chain] = {
          atomicBatch: caps.atomicBatch
            ? { supported: true, maxBatchSize: 5 }
            : { supported: false },
          paymasterService: caps.paymasterService
            ? { supported: true }
            : undefined,
        };
      }
    } catch {
      for (const chain of chains) {
        capabilities[chain] = {
          atomicBatch: { supported: true, maxBatchSize: 5 },
        };
      }
    }

    return capabilities;
  }

  async getCallsStatus(
    session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<import("@naculus/connect-core").CallsStatus> {
    try {
      const accounts = session.namespaces.eip155?.accounts ?? [];
      const eip6963Session = Array.from(this.activeSessions.values()).find(
        (s) => s.accounts.some((acc) => accounts.includes(acc)),
      );
      if (!eip6963Session?.wallet.provider?.request)
        throw new Error("no provider");
      return (await eip6963Session.wallet.provider.request({
        method: "wallet_getCallsStatus",
        params: [bundleHash],
      })) as import("@naculus/connect-core").CallsStatus;
    } catch {
      return { status: "PENDING" };
    }
  }

  async request(request: {
    method: string;
    params: unknown[];
  }): Promise<unknown> {
    const session = this.activeSessions.values().next().value;
    if (!session)
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    return session.wallet.provider.request({
      method: request.method,
      params: request.params,
    });
  }

  async getBalance(chainId?: string): Promise<string> {
    const activeWalletEntries = Array.from(this.activeSessions.values());
    const session = chainId
      ? activeWalletEntries.find((s) =>
          s.chains.some((c) => c === chainId),
        ) ?? activeWalletEntries[0]
      : activeWalletEntries[0];
    if (!session)
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    const accounts = session.accounts;
    if (accounts.length === 0)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNTS,
      );
    const address = accounts[0].split(":").pop()!;
    const provider = session.wallet.provider;
    const balance = (await provider.request({
      method: "eth_getBalance",
      params: [address, "latest"],
    })) as string;
    return balance;
  }

  onUpdate(callback: (wallets: DiscoveredWallet[]) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notifyListeners(): void {
    const wallets = this.getDiscoveredWallets();
    this.listeners.forEach((cb) => cb(wallets));
  }

  getWalletByRDNS(rdns: string): DiscoveredWallet | undefined {
    return this.getDiscoveredWallets().find((w) => w.rdns === rdns);
  }

  clear(): void {
    for (const handlers of this.storedEventHandlers.values()) {
      handlers.wallet.provider.removeListener(
        "accountsChanged",
        handlers.accountsHandler,
      );
      handlers.wallet.provider.removeListener(
        "chainChanged",
        handlers.chainHandler,
      );
    }
    this.storedEventHandlers.clear();
    this.discoveredWallets.clear();
    this.activeSessions.clear();
    this.notifyListeners();
  }
}

export const eip6963Connector = new EIP6963ConnectorImpl();

export type { EIP6963ConnectorImpl as EIP6963ConnectorClass };
export { EIP6963ConnectorImpl as EIP6963Connector };

export function createEIP6963Connector(): EIP6963ConnectorImpl {
  return new EIP6963ConnectorImpl();
}

export function getEIP6963Provider(
  rdns: string,
): Eip6963EthereumProvider | null {
  const wallet = eip6963Connector.getWalletByRDNS(rdns);
  return wallet?.provider ?? null;
}

export function isWalletInstalled(rdns: string): boolean {
  if (typeof window === "undefined") return false;
  return eip6963Connector.getWalletByRDNS(rdns) !== undefined;
}
