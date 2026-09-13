import type {
  BatchCall,
  ConnectorSupport,
  SendCallsOptions,
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
  hexEncode,
  normalizeEip5792Capabilities,
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

/** Normalize EIP-1193 chainChanged values to the CAIP-2 form used by sessions. */
function normalizeEip155ChainId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  try {
    if (value.startsWith("eip155:")) {
      const reference = value.slice("eip155:".length);
      if (!/^\d+$/.test(reference)) return undefined;
      const numeric = BigInt(reference);
      return numeric > 0n ? `eip155:${numeric.toString(10)}` : undefined;
    }
    if (/^0x[0-9a-f]+$/i.test(value) || /^\d+$/.test(value)) {
      const numeric = BigInt(value);
      return numeric > 0n ? `eip155:${numeric.toString(10)}` : undefined;
    }
  } catch {
    // An invalid wallet event must not corrupt the persisted session.
  }

  return undefined;
}

function rawEvmAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let address = value;
  if (value.includes(":")) {
    const parts = value.split(":");
    if (
      parts.length !== 3 ||
      parts[0] !== "eip155" ||
      !/^[1-9][0-9]*$/.test(parts[1] ?? "")
    ) {
      return undefined;
    }
    address = parts[2];
  }
  return address && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : undefined;
}

function requireEvmAddress(value: unknown, field: string): string {
  const address = rawEvmAddress(value);
  if (!address) {
    throw new WalletError(
      "invalid_input",
      `${field} must be a 20-byte EVM address.`,
    );
  }
  return address;
}

/** Select the account explicitly approved for a requested EIP-155 chain. */
function accountForChain(
  accounts: string[],
  chainId: string,
): string | undefined {
  const reference = chainId.startsWith("eip155:")
    ? chainId.slice("eip155:".length)
    : undefined;
  const candidate = accounts.find((account) => {
    if (typeof account !== "string") return false;
    if (!account.includes(":")) return reference !== undefined;
    const parts = account.split(":");
    return (
      parts.length === 3 && parts[0] === "eip155" && parts[1] === reference
    );
  });
  return candidate ? requireEvmAddress(candidate, "account") : undefined;
}

const EVM_QUANTITY_FIELDS = [
  "chainId",
  "gas",
  "gasLimit",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "nonce",
  "value",
] as const;

function normalizeEvmTransaction(
  transaction: Record<string, unknown>,
  fallbackFrom: string,
  expectedChainId?: string,
): Record<string, unknown> {
  if (
    (transaction.to === undefined || transaction.to === null) &&
    transaction.data === undefined
  ) {
    throw new WalletError(
      "invalid_input",
      "Transaction must include a 20-byte 'to' address or contract-creation data.",
    );
  }
  const normalized = { ...transaction };
  normalized.from =
    transaction.from === undefined
      ? requireEvmAddress(fallbackFrom, "from")
      : requireEvmAddress(transaction.from, "from");
  if (transaction.to !== undefined) {
    if (transaction.to === null) delete normalized.to;
    else normalized.to = requireEvmAddress(transaction.to, "to");
  }
  if (transaction.data !== undefined) {
    if (
      typeof transaction.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.data)
    ) {
      throw new WalletError(
        "invalid_input",
        "data must be even-length hexadecimal.",
      );
    }
  }

  for (const field of EVM_QUANTITY_FIELDS) {
    const value = normalized[field];
    if (typeof value === "number" || typeof value === "bigint") {
      if (
        (typeof value === "number" &&
          (!Number.isSafeInteger(value) || value < 0)) ||
        (typeof value === "bigint" && value < 0n)
      ) {
        throw new WalletError(
          "invalid_input",
          `${field} must be a non-negative safe EIP-1474 quantity.`,
        );
      }
      normalized[field] = `0x${BigInt(value).toString(16)}`;
    } else if (typeof value === "string") {
      try {
        // Canonicalize both decimal input and EIP-1474 hex quantities. This
        // also rejects malformed values such as `0xzz` instead of forwarding
        // them to an injected provider.
        normalized[field] = toHexValue(value);
      } catch (error) {
        throw new WalletError(
          "invalid_input",
          `${field} must be a canonical EIP-1474 quantity.`,
          error,
        );
      }
    }
  }

  if (expectedChainId && normalized.chainId !== undefined) {
    const expected = toEip155HexChainId(expectedChainId);
    if (normalized.chainId !== expected) {
      throw new WalletError(
        "chain_mismatch",
        "Transaction chainId does not match the active injected-wallet chain.",
      );
    }
  }

  return normalized;
}

function toEip155HexChainId(chainId: string | undefined): string {
  const reference = chainId?.startsWith("eip155:")
    ? chainId.slice("eip155:".length)
    : chainId;
  if (!reference || !/^[1-9][0-9]*$/.test(reference)) {
    throw new WalletError("invalid_input", `Invalid EVM chain ID: ${chainId}`);
  }
  return `0x${BigInt(reference).toString(16)}`;
}

function normalizeBatchCall(call: BatchCall): Record<string, unknown> {
  if (call.to === undefined && call.data === undefined) {
    throw new WalletError(
      "invalid_input",
      "Call must include a 20-byte 'to' address or contract-creation data.",
    );
  }
  const normalized: Record<string, unknown> = {};
  if (call.to !== undefined)
    normalized.to = requireEvmAddress(call.to, "call.to");
  if (call.value !== undefined) {
    try {
      normalized.value = toHexValue(call.value);
    } catch (error) {
      throw new WalletError(
        "invalid_input",
        "call.value must be an EIP-1474 quantity.",
        error,
      );
    }
  }
  if (call.data !== undefined) {
    if (
      typeof call.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data)
    ) {
      throw new WalletError(
        "invalid_input",
        "call.data must be an even-length hexadecimal byte string.",
      );
    }
    normalized.data = call.data;
  }
  return normalized;
}

function assertSessionTransactionFrom(
  transaction: Record<string, unknown>,
  accounts: string[],
): void {
  if (transaction.from === undefined) return;
  const requested = rawEvmAddress(transaction.from);
  const allowed = requested
    ? accounts.some(
        (account) =>
          rawEvmAddress(account)?.toLowerCase() === requested.toLowerCase(),
      )
    : false;
  if (!allowed) {
    throw new WalletError(
      "invalid_input",
      "Transaction 'from' must be one of the connected EVM accounts.",
    );
  }
}

function extractCallBundleId(result: unknown): string {
  if (typeof result === "string") return result;
  if (
    result &&
    typeof result === "object" &&
    typeof (result as { id?: unknown }).id === "string"
  ) {
    return (result as { id: string }).id;
  }
  throw new WalletError(
    "rpc_error",
    "wallet_sendCalls returned no bundle identifier.",
    result,
  );
}

function isUnsupportedSendCallsError(error: unknown): boolean {
  const code = (error as { code?: number } | undefined)?.code;
  if (code === -32601 || code === -32004) return true;
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("not supported") ||
    message.includes("unsupported") ||
    message.includes("method not found")
  );
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
  private readonly accountsSubscribers = new Set<
    (accounts: string[]) => void
  >();
  private readonly chainSubscribers = new Set<(chainId: string) => void>();

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
        // Wait up to 500ms for EIP-6963 announcements
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        const afterWait = this.getDiscoveredWallets();
        if (afterWait.length > 0) {
          wallet = afterWait[0];
        } else if (
          typeof window !== "undefined" &&
          (window as unknown as { ethereum?: { isMetaMask?: boolean } })
            .ethereum
        ) {
          wallet = {
            id: "window-ethereum",
            name: "Browser Wallet",
            icon: "",
            rdns: "io.metamask",
            provider: (
              window as unknown as { ethereum: Record<string, unknown> }
            ).ethereum as unknown as Eip6963EthereumProvider,
          };
        } else {
          throw new WalletError(
            "wallet_unavailable",
            "No wallet available. Install MetaMask or another EIP-6963 wallet.",
          );
        }
      } else {
        wallet = wallets[0];
      }
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
          params: [],
        })) as string[];
      }
    } else {
      try {
        await requestPermissions(wallet.provider);
        accounts = (await wallet.provider.request({
          method: "eth_requestAccounts",
          params: [],
        })) as string[];
      } catch {
        accounts = (await wallet.provider.request({
          method: "eth_requestAccounts",
          params: [],
        })) as string[];
      }
    }

    if (
      !Array.isArray(accounts) ||
      accounts.length === 0 ||
      accounts.some((account) => !rawEvmAddress(account))
    ) {
      throw new WalletError(
        "rpc_error",
        "Wallet returned an invalid EIP-155 account list.",
      );
    }

    const requestedChain = chainId
      ? normalizeEip155ChainId(chainId)
      : undefined;
    if (chainId && !requestedChain) {
      throw new WalletError(
        "invalid_input",
        `Invalid EVM chain ID: ${chainId}`,
      );
    }
    let providerChain: string | undefined;
    try {
      const rawProviderChain = await wallet.provider.request({
        method: "eth_chainId",
        params: [],
      });
      providerChain = normalizeEip155ChainId(rawProviderChain);
    } catch {
      // The provider chain is authoritative. A missing response is handled
      // below as an unavailable/invalid chain, never as mainnet.
    }
    if (requestedChain && providerChain && requestedChain !== providerChain) {
      throw new WalletError(
        "chain_unsupported",
        `Requested ${requestedChain}, but the wallet is currently on ${providerChain}.`,
      );
    }
    const activeChain = providerChain;
    if (!activeChain) {
      throw new WalletError(
        "chain_unsupported",
        "Wallet did not return a valid EIP-155 chain ID.",
      );
    }
    const chainReference = activeChain.slice("eip155:".length);
    const chains = [activeChain];
    const eip155Accounts = accounts.map(
      (acc) => `eip155:${chainReference}:${rawEvmAddress(acc)!}`,
    );
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

    const rawChain = await wallet.provider.request({
      method: "eth_chainId",
      params: [],
    });
    const liveChain = normalizeEip155ChainId(rawChain);
    if (!liveChain) {
      throw new WalletError(
        "chain_unsupported",
        "Wallet did not return a valid EIP-155 chain ID.",
      );
    }

    // Remove old event listeners if any, then setup fresh ones
    this.removeEventListeners(wallet);

    // Update session accounts from live provider
    const ns = session.namespaces.eip155;
    const chainReference = liveChain.slice("eip155:".length);
    const eip155Accounts = accounts.map(
      (acc: string) => `eip155:${chainReference}:${acc}`,
    );
    if (ns) {
      ns.chains = [liveChain];
      ns.accounts = eip155Accounts;
    }

    this.setupEventListeners(wallet, session);

    const eip6963Session: EIP6963Session = {
      wallet,
      accounts: eip155Accounts,
      chains: [liveChain],
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
      const accounts = Array.isArray(args[0])
        ? (args[0] as unknown[]).filter((account): account is string =>
            Boolean(rawEvmAddress(account)),
          )
        : [];
      if (accounts.length === 0) {
        this.handleDisconnect(session);
        // An empty list is the disconnect signal in the shared contract.
        this.notifyAccountsChanged([]);
        return;
      }

      // EIP-1193 account changes are part of the active session contract. Keep
      // both the public session and the connector's routing index in sync so
      // subsequent signing/transaction calls target the wallet's new account.
      const chainReference =
        session.namespaces.eip155?.chains?.[0]?.split(":")[1];
      if (!chainReference || !/^[1-9][0-9]*$/.test(chainReference)) {
        return;
      }
      const caip10Accounts = accounts.map(
        (account) => `eip155:${chainReference}:${account}`,
      );
      const namespace = session.namespaces.eip155;
      if (namespace) namespace.accounts = caip10Accounts;
      const active = this.activeSessions.get(wallet.id);
      if (active) active.accounts = caip10Accounts;
      if (active && namespace) active.chains = namespace.chains;
      this.notifyAccountsChanged(caip10Accounts);
    };

    const chainHandler = (...args: unknown[]) => {
      const chainId = normalizeEip155ChainId(args[0]);
      if (!chainId) return;
      const ns = session.namespaces.eip155;
      if (ns) {
        ns.chains = [chainId];
        const chainReference = chainId.split(":")[1]!;
        ns.accounts = ns.accounts
          .map((account) => rawEvmAddress(account))
          .filter((account): account is string => Boolean(account))
          .map((account) => `eip155:${chainReference}:${account}`);
        const active = this.activeSessions.get(wallet.id);
        if (active) {
          active.chains = [chainId];
          active.accounts = ns.accounts;
        }
        // A chain change re-keys every CAIP-10 account, so subscribers need
        // telling even though the underlying addresses did not change.
        this.notifyAccountsChanged(ns.accounts);
        this.notifyChainChanged(chainId);
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

  /**
   * UniversalConnector.onAccountsChanged.
   *
   * This connector already re-keyed the session's CAIP-10 accounts on both
   * `accountsChanged` and `chainChanged`; it simply had no way to say so, so
   * appkit reimplemented the same re-keying by reaching through
   * `getDiscoveredWallets()` into the raw EIP-1193 provider. Subscribers now
   * read the session the connector has already updated.
   */
  onAccountsChanged(
    _session: UniversalWalletSession,
    handler: (accounts: string[]) => void,
  ): () => void {
    this.accountsSubscribers.add(handler);
    return () => {
      this.accountsSubscribers.delete(handler);
    };
  }

  /** UniversalConnector.onChainChanged. */
  onChainChanged(
    _session: UniversalWalletSession,
    handler: (chainId: string) => void,
  ): () => void {
    this.chainSubscribers.add(handler);
    return () => {
      this.chainSubscribers.delete(handler);
    };
  }

  private notifyChainChanged(chainId: string): void {
    for (const subscriber of [...this.chainSubscribers]) {
      try {
        subscriber(chainId);
      } catch {
        // One bad subscriber must not stop the others from being told.
      }
    }
  }

  private notifyAccountsChanged(accounts: string[]): void {
    for (const subscriber of [...this.accountsSubscribers]) {
      try {
        subscriber(accounts);
      } catch {
        // One bad subscriber must not stop the others from being told.
      }
    }
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
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const eip6963Session = this.findActiveSession(accounts);

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

  /**
   * Find the active EIP-6963 session that owns any of the given accounts.
   */
  private findActiveSession(accounts: string[]): EIP6963Session | undefined {
    return Array.from(this.activeSessions.values()).find((s) =>
      s.accounts.some((acc) => accounts.includes(acc)),
    );
  }

  async disconnect(session: UniversalWalletSession): Promise<void> {
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const eip6963Session = this.findActiveSession(accounts);

    if (eip6963Session) {
      this.removeEventListeners(eip6963Session.wallet);
      this.activeSessions.delete(eip6963Session.wallet.id);
    }

    if (session.id?.startsWith("eip6963-")) {
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

    const requestedAccount = rawAddress ?? accounts[0];
    if (!requestedAccount) {
      throw new WalletError(
        "invalid_input",
        "Signing account must be a 20-byte EVM address.",
      );
    }
    assertSessionTransactionFrom({ from: requestedAccount }, accounts);
    const targetAccount = requireEvmAddress(requestedAccount, "address");

    const eip6963Session = this.findActiveSession(accounts);

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    const hexMessage = hexEncode(rawMessage);

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
      | Record<string, unknown>
      | undefined;
    if (!transaction || typeof transaction !== "object")
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );
    if (Object.keys(transaction).length === 0) {
      throw new WalletError(
        "method_not_allowed",
        "Transaction object must contain at least one field.",
      );
    }
    if (Array.isArray(transaction.serialized)) {
      throw new WalletError(
        "method_unsupported",
        "Injected wallets cannot safely decode serialized transactions. Pass a transaction object to signTransaction.",
      );
    }
    if (transaction.to === undefined && transaction.data === undefined) {
      throw new WalletError(
        "invalid_input",
        "Transaction must include a 20-byte 'to' address or contract-creation data.",
      );
    }
    const accounts = session.namespaces.eip155?.accounts ?? [];
    assertSessionTransactionFrom(transaction, accounts);

    const fromAccount = accountForChain(
      accounts,
      session.namespaces.eip155?.chains?.[0] ?? "",
    );
    if (!fromAccount) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_SIGNING,
      );
    }

    const eip6963Session = this.findActiveSession(accounts);

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    const result = await eip6963Session.wallet.provider.request({
      method: "eth_signTransaction",
      params: [
        normalizeEvmTransaction(
          transaction,
          fromAccount,
          session.namespaces.eip155?.chains?.[0],
        ),
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
    if (transaction.to === undefined && transaction.data === undefined) {
      throw new WalletError(
        "invalid_input",
        "Transaction must include a 20-byte 'to' address or contract-creation data.",
      );
    }
    const accounts = session.namespaces.eip155?.accounts ?? [];
    assertSessionTransactionFrom(transaction, accounts);

    const fromAccount =
      typeof transaction.from === "string"
        ? requireEvmAddress(transaction.from, "from")
        : accountForChain(
            accounts,
            session.namespaces.eip155?.chains?.[0] ?? "",
          );
    if (!fromAccount) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
      );
    }

    const eip6963Session = this.findActiveSession(accounts);

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    const result = await eip6963Session.wallet.provider.request({
      method: "eth_sendTransaction",
      params: [
        normalizeEvmTransaction(
          transaction,
          fromAccount,
          session.namespaces.eip155?.chains?.[0],
        ),
      ],
    });

    return result;
  }

  async switchChain(
    session: UniversalWalletSession,
    chainId: string,
  ): Promise<void> {
    const normalizedChainId = normalizeEip155ChainId(chainId);
    if (!normalizedChainId) {
      throw new WalletError(
        "invalid_input",
        `Invalid EVM chain ID: ${chainId}`,
      );
    }
    const accounts = session.namespaces.eip155?.accounts ?? [];
    if (accounts.length === 0) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNTS,
      );
    }

    const eip6963Session = this.findActiveSession(accounts);

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    // Convert CAIP-10 chainId (e.g. "eip155:137") to hex format (e.g. "0x89")
    // as required by wallet_switchEthereumChain
    const hexChainId = `0x${BigInt(normalizedChainId.slice("eip155:".length)).toString(16)}`;

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

    // Every reader in this connector treats `chains[0]` as the active chain —
    // including `normalizeEvmTransaction`, whose chain_mismatch guard compares
    // a caller-supplied chainId against it. Appending, and skipping the update
    // entirely when the chain was already listed, left `chains[0]` pinned to
    // whatever `connect()` returned first: switching to a chain already in the
    // session moved the wallet but not the session, so a correctly-stamped
    // transaction on the new chain was rejected as a mismatch. Promote instead.
    const currentChains = session.namespaces.eip155?.chains ?? [];
    const newChains = [
      normalizedChainId,
      ...currentChains.filter(
        (c) => c.startsWith("eip155:") && c !== normalizedChainId,
      ),
    ];

    // Accounts are CAIP-10 values qualified with the active chain's reference
    // (see the accountsChanged handler, which rebuilds them the same way), and
    // accountForChain() matches on that reference. Promoting the chain without
    // re-qualifying the accounts would leave the two out of step and make
    // every from-less transaction fail with "no account for signing".
    const reference = normalizedChainId.slice("eip155:".length);
    const requalified = accounts
      .map((account) => rawEvmAddress(account))
      .filter((address): address is string => address !== undefined)
      .map((address) => `eip155:${reference}:${address}`);

    const namespace = session.namespaces.eip155;
    if (namespace) {
      namespace.chains = newChains;
      if (requalified.length > 0) namespace.accounts = requalified;
    }
    eip6963Session.chains = newChains;
    if (requalified.length > 0) eip6963Session.accounts = requalified;
  }

  async sendCalls(
    session: UniversalWalletSession,
    calls: BatchCall[],
    chainId?: string,
    options?: SendCallsOptions,
  ): Promise<string> {
    if (!Array.isArray(calls)) {
      throw new WalletError("invalid_input", "Invalid input");
    }
    if (calls.length === 0) {
      throw new WalletError("invalid_input", "At least one call is required.");
    }
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const fromAccount = accountForChain(
      accounts,
      session.namespaces.eip155?.chains?.[0] ?? "",
    );
    if (!fromAccount) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
      );
    }

    const eip6963Session = this.findActiveSession(accounts);

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    const activeChain = session.namespaces.eip155?.chains?.[0];
    const requestedChain = chainId ?? activeChain;
    if (!activeChain || !requestedChain) {
      throw new WalletError(
        "session_expired",
        "Session does not contain a valid EIP-155 chain ID.",
      );
    }
    const normalizedRequested = normalizeEip155ChainId(requestedChain);
    if (!normalizedRequested || normalizedRequested !== activeChain) {
      throw new WalletError(
        "chain_mismatch",
        "wallet_sendCalls chainId must match the active injected-wallet chain.",
      );
    }

    try {
      const result = await eip6963Session.wallet.provider.request({
        method: "wallet_sendCalls",
        params: [
          {
            version: "2.0.0",
            from: fromAccount,
            chainId: toEip155HexChainId(normalizedRequested),
            atomicRequired: options?.atomicRequired === true,
            calls: calls.map(normalizeBatchCall),
            ...(options?.paymasterService
              ? {
                  capabilities: {
                    paymasterService: {
                      url: options.paymasterService.url,
                      context: options.paymasterService.context ?? {},
                    },
                  },
                }
              : {}),
          },
        ],
      });
      return extractCallBundleId(result);
    } catch (error) {
      // EIP-5792 fallback is safe only when wallet_sendCalls is unavailable.
      // Never turn a user rejection or wallet error into real transactions.
      if (!isUnsupportedSendCallsError(error)) throw error;
      // Sending the calls one at a time is exactly the partial execution the
      // caller ruled out, and it would be indistinguishable from success.
      if (options?.atomicRequired || options?.paymasterService) throw error;
      const txHashes: string[] = [];
      for (const call of calls) {
        const hash = await eip6963Session.wallet.provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: fromAccount,
              ...normalizeBatchCall(call),
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
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const eip6963Session = this.findActiveSession(accounts);

    if (!eip6963Session) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }

    const chains = session.namespaces.eip155?.chains;
    if (!chains || chains.length === 0) {
      throw new WalletError(
        "session_expired",
        "Session does not contain a valid EIP-155 chain ID.",
      );
    }
    const account = accountForChain(accounts, chains[0] ?? "");
    const hexChains = chains.map((chain) => toEip155HexChainId(chain));
    // EIP-5792 accepts the address and queried EIP-155 chain IDs. Empty params
    // are not portable across injected wallets.
    const result = await eip6963Session.wallet.provider.request({
      method: "wallet_getCapabilities",
      params: [account, hexChains],
    });

    // Decoding lives in @naculus/connect-core. Inline, this branch read
    // `Boolean(caps.atomicBatch)` — and `{ supported: false }` is truthy, so a
    // wallet that had explicitly said it cannot batch atomically was recorded
    // as able to. It also accepted only `status: "supported"`, dropping the
    // "ready" state that EIP-5792 2.0.0 also defines as support.
    //
    // A failed query is no longer swallowed into `supported: false` either: a
    // wallet that cannot answer has not answered no, and the caller needs that
    // difference to decide whether to fall back.
    return normalizeEip5792Capabilities(result);
  }

  /**
   * EIP-5792 `wallet_showCallsStatus`.
   *
   * Asks the wallet to show the bundle to the user. Nothing comes back, and a
   * refusal is cosmetic — the bundle is unaffected — so the error names that
   * rather than reading like the calls failed.
   */
  async showCallsStatus(
    session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<void> {
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const eip6963Session = this.findActiveSession(accounts);
    if (!eip6963Session?.wallet.provider?.request) {
      throw new WalletError(
        "wallet_unavailable",
        "No active injected wallet for this session.",
      );
    }
    try {
      await eip6963Session.wallet.provider.request({
        method: "wallet_showCallsStatus",
        params: [bundleHash],
      });
    } catch (error) {
      if (isUnsupportedSendCallsError(error)) {
        throw new WalletError(
          "method_unsupported",
          "This wallet cannot display call status. The bundle is unaffected.",
          error,
        );
      }
      throw error;
    }
  }

  async getCallsStatus(
    session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<import("@naculus/connect-core").CallsStatus> {
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const eip6963Session = this.findActiveSession(accounts);
    if (!eip6963Session?.wallet.provider?.request) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }
    return (await eip6963Session.wallet.provider.request({
      method: "wallet_getCallsStatus",
      params: [bundleHash],
    })) as import("@naculus/connect-core").CallsStatus;
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
    const requestedChain = chainId
      ? normalizeEip155ChainId(chainId)
      : undefined;
    if (chainId && !requestedChain) {
      throw new WalletError(
        "invalid_input",
        `Invalid EVM chain ID: ${chainId}`,
      );
    }
    const session = requestedChain
      ? activeWalletEntries.find((s) => s.chains.includes(requestedChain))
      : activeWalletEntries[0];
    if (!session)
      throw new WalletError(
        requestedChain ? "chain_unsupported" : "session_expired",
        requestedChain
          ? `No active wallet session for ${requestedChain}.`
          : CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    const accounts = session.accounts;
    if (accounts.length === 0)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNTS,
      );
    const address = accountForChain(
      accounts,
      requestedChain ?? session.chains[0] ?? "",
    );
    if (!address) {
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNTS,
      );
    }
    const provider = session.wallet.provider;
    const balance = (await provider.request({
      method: "eth_getBalance",
      params: [address, "latest"],
    })) as string;
    if (typeof balance !== "string") {
      throw new WalletError(
        "rpc_error",
        "Provider returned no balance result.",
      );
    }
    if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(balance)) {
      throw new WalletError(
        "rpc_error",
        "Provider returned a non-canonical eth_getBalance quantity.",
      );
    }
    try {
      return toHexValue(balance);
    } catch (error) {
      throw new WalletError(
        "rpc_error",
        "Provider returned a non-canonical eth_getBalance quantity.",
        error,
      );
    }
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
