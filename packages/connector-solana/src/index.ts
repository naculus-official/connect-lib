import type {
  ConnectorSupport,
  UniversalConnector,
  UniversalWalletSession,
} from "@naculus/connect-core";
import {
  createEmptySession,
  isValidAddress,
  logger,
  WalletError,
} from "@naculus/connect-core";
import {
  createProviderFromWalletStandard,
  isPhantomInstalled,
  isSolflareInstalled,
  SOLANA_WALLET_META,
} from "./discovery";
import type { SolanaRoles } from "./roles";
import {
  featuresFromLegacyProvider,
  featuresFromWalletStandard,
  solanaRoles,
} from "./roles";
import type {
  DiscoveredSolanaWallet,
  SolanaConnectorSession,
  SolanaProvider,
  WalletStandardWallet,
} from "./types";
import { SOLANA_CHAINS } from "./types";
import { GENESIS_HASHES, resolveSolanaChain } from "./utils";

export { isPhantomInstalled, isSolflareInstalled } from "./discovery";
export type {
  SolanaIdentity,
  SolanaPayer,
  SolanaRoles,
  SolanaSigner,
  SolanaWalletFeatures,
} from "./roles";
export {
  featuresFromLegacyProvider,
  featuresFromWalletStandard,
  requireRole,
  solanaRoles,
} from "./roles";
export type {
  DiscoveredSolanaWallet,
  SolanaConnectorSession,
  SolanaProvider,
  WalletStandardWallet,
} from "./types";

const SUPPORT: ConnectorSupport = {
  desktop: true,
  mobile: false,
  deepLink: false,
  qr: false,
  trustedReconnect: true,
};

/**
 * Read a Solana address out of an `accountChanged` payload.
 *
 * Returns null for anything unrecognizable; the caller validates before use,
 * so a plain object's "[object Object]" can never reach the session.
 */
function readSolanaAccount(payload: unknown): string | null {
  if (payload == null) return null;
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return payload.length > 0 ? readSolanaAccount(payload[0]) : null;
  }
  if (typeof payload !== "object") return null;

  const candidate = payload as {
    publicKey?: unknown;
    address?: unknown;
    toBase58?: () => string;
  };
  if (candidate.publicKey != null && candidate.publicKey !== payload) {
    return readSolanaAccount(candidate.publicKey);
  }
  if (typeof candidate.address === "string") return candidate.address;
  if (typeof candidate.toBase58 === "function") {
    try {
      return candidate.toBase58();
    } catch {
      return null;
    }
  }
  return null;
}

/** Stable discovery ID for a Wallet Standard wallet. */
function walletStandardId(name: string): string {
  return `wallet-standard-${name.toLowerCase().replace(/\s+/g, "-")}`;
}

class SolanaConnectorImpl implements UniversalConnector {
  readonly id = "solana";
  readonly name = "Solana Wallets";
  readonly kind = "solana" as const;
  readonly namespaces = ["solana"];
  readonly supports = SUPPORT;

  private defaultChain: string = SOLANA_CHAINS.mainnet;
  private discoveredWallets: Map<string, DiscoveredSolanaWallet> = new Map();
  private listeners: Set<(wallets: DiscoveredSolanaWallet[]) => void> =
    new Set();
  private activeSession: SolanaConnectorSession | null = null;
  private attachedListener?: {
    wallet: DiscoveredSolanaWallet;
    handler: (...args: unknown[]) => void;
  };
  private readonly accountsSubscribers = new Set<
    (accounts: string[]) => void
  >();

  /** Configure the connector before use. */
  configure(config: { defaultChain?: string }): void {
    if (config.defaultChain !== undefined) {
      if (!(config.defaultChain in GENESIS_HASHES)) {
        throw new WalletError(
          "chain_unsupported",
          "Solana connector requires a canonical genesis-hash CAIP-2 chain.",
        );
      }
      this.defaultChain = config.defaultChain;
    }
  }

  startDiscovery(): void {
    if (typeof window === "undefined") return;
    // Wallet Standard first. The legacy window scan below only runs for
    // wallets the standard handshake did not already produce, so a wallet that
    // supports both is discovered once, through the better path.
    this.listenForWalletStandard();
    this.scanForProviders();
  }

  stopDiscovery(): void {
    if (
      this.walletStandardHandler &&
      typeof window !== "undefined" &&
      "removeEventListener" in window
    ) {
      window.removeEventListener(
        "wallet-standard:register-wallet",
        this.walletStandardHandler,
      );
      this.walletStandardHandler = undefined;
    }
  }

  private walletStandardHandler: ((event: Event) => void) | undefined;

  /**
   * Register one Wallet Standard wallet.
   *
   * Shared by both halves of the handshake, so a wallet that arrives by event
   * and one that answers `app-ready` are treated identically.
   */
  private registerWalletStandardWallet(
    wallet: WalletStandardWallet | undefined,
  ): void {
    if (!wallet?.name) return;

    const id = walletStandardId(wallet.name);
    if (this.discoveredWallets.has(id)) return;

    let provider: SolanaProvider;
    try {
      provider = createProviderFromWalletStandard(wallet);
    } catch {
      // A Wallet Standard registration can be emitted before all required
      // Solana features are present. Ignore unsupported registrations rather
      // than allowing an exception to escape from the DOM event handler.
      return;
    }

    const discovered: DiscoveredSolanaWallet = {
      id,
      name: wallet.name,
      icon: wallet.icon,
      rdns: wallet.rdns,
      provider,
      source: "wallet-standard",
      // The features record, not the adapter: the adapter defines every
      // method regardless of what this wallet actually implements.
      features: featuresFromWalletStandard(wallet.features),
    };
    this.discoveredWallets.set(id, discovered);
    this.notifyListeners();
  }

  /**
   * Both halves of the Wallet Standard discovery handshake.
   *
   * Listening for `wallet-standard:register-wallet` only catches wallets that
   * register *after* this runs. Extensions inject at document_start, so in
   * practice most of them have already registered by the time a dApp's code
   * executes, and they wait for the app to announce itself. Without the
   * `wallet-standard:app-ready` dispatch those wallets were never seen at all
   * — which is why the legacy `window.solana` scan was still doing the real
   * work despite the standard path being implemented.
   */
  private listenForWalletStandard(): void {
    if (typeof window === "undefined" || !("addEventListener" in window))
      return;

    const handler = (event: Event) => {
      this.registerWalletStandardWallet(
        (event as CustomEvent<WalletStandardWallet>).detail,
      );
    };
    this.walletStandardHandler = handler;
    window.addEventListener("wallet-standard:register-wallet", handler);

    // Wallets already present respond to this by calling `register`.
    try {
      window.dispatchEvent(
        new CustomEvent("wallet-standard:app-ready", {
          detail: {
            register: (...wallets: WalletStandardWallet[]) => {
              for (const wallet of wallets) {
                this.registerWalletStandardWallet(wallet);
              }
              // The standard expects an unregister callback. Nothing here
              // holds the wallet beyond the discovery map, so removing it is
              // the whole of it.
              return () => {
                for (const wallet of wallets) {
                  if (!wallet?.name) continue;
                  this.discoveredWallets.delete(walletStandardId(wallet.name));
                }
                this.notifyListeners();
              };
            },
          },
        }),
      );
    } catch {
      // A host without CustomEvent still gets the listener above.
    }
  }

  /**
   * Has this wallet already been found through Wallet Standard?
   *
   * The two paths use different ID namespaces (`phantom` vs
   * `wallet-standard-phantom`), so without this check a wallet supporting both
   * appears twice in the picker — once with full feature negotiation and once
   * through the legacy shim.
   */
  private discoveredViaWalletStandard(name: string): boolean {
    return this.discoveredWallets.has(walletStandardId(name));
  }

  private scanForProviders(): void {
    const win = window as unknown as Record<string, unknown>;

    let phantomProvider: SolanaProvider | null = null;
    const phantom = win.phantom as { solana?: SolanaProvider } | undefined;
    const solanaWin = win.solana as SolanaProvider | undefined;

    if (phantom?.solana) {
      phantomProvider = phantom.solana;
    } else if (solanaWin?.isPhantom) {
      phantomProvider = solanaWin;
    }

    if (
      phantomProvider &&
      !this.discoveredWallets.has("phantom") &&
      !this.discoveredViaWalletStandard("Phantom")
    ) {
      console.warn(
        "Wallet Phantom discovered via legacy window.solana. For better compatibility, consider using @solana/wallet-standard.",
      );
      const wallet: DiscoveredSolanaWallet = {
        id: "phantom",
        name: SOLANA_WALLET_META.phantom.name,
        icon: SOLANA_WALLET_META.phantom.icon,
        rdns: SOLANA_WALLET_META.phantom.rdns,
        provider: phantomProvider,
        source: "legacy",
        features: featuresFromLegacyProvider(phantomProvider),
      };
      this.discoveredWallets.set("phantom", wallet);
    }

    let solflareProvider: SolanaProvider | null = null;
    const solflareWin = win.solflare as SolanaProvider | undefined;
    if (solflareWin?.isSolflare) {
      solflareProvider = solflareWin;
    }
    if (
      solflareProvider &&
      !this.discoveredWallets.has("solflare") &&
      !this.discoveredViaWalletStandard("Solflare")
    ) {
      console.warn(
        "Wallet Solflare discovered via legacy window.solflare. For better compatibility, consider using @solana/wallet-standard.",
      );
      const wallet: DiscoveredSolanaWallet = {
        id: "solflare",
        name: SOLANA_WALLET_META.solflare.name,
        icon: SOLANA_WALLET_META.solflare.icon,
        rdns: SOLANA_WALLET_META.solflare.rdns,
        provider: solflareProvider,
        source: "legacy",
        features: featuresFromLegacyProvider(solflareProvider),
      };
      this.discoveredWallets.set("solflare", wallet);
    }

    const genericProvider = win.solana as SolanaProvider | undefined;
    if (
      genericProvider &&
      !genericProvider.isPhantom &&
      !genericProvider.isSolflare &&
      !this.discoveredWallets.has("generic") &&
      !this.discoveredViaWalletStandard("Solana Wallet")
    ) {
      console.warn(
        "Wallet Solana Wallet discovered via legacy window.solana. For better compatibility, consider using @solana/wallet-standard.",
      );
      const wallet: DiscoveredSolanaWallet = {
        id: "generic",
        name: "Solana Wallet",
        icon: "",
        rdns: "unknown.generic-solana-wallet",
        provider: genericProvider,
        source: "legacy",
        features: featuresFromLegacyProvider(genericProvider),
      };
      this.discoveredWallets.set("generic", wallet);
    }

    if (this.discoveredWallets.size > 0) {
      this.notifyListeners();
    }
  }

  getDiscoveredWallets(): DiscoveredSolanaWallet[] {
    return Array.from(this.discoveredWallets.values());
  }

  async connect(input?: unknown): Promise<UniversalWalletSession> {
    const walletId = typeof input === "string" ? input : undefined;
    let targetWallet = walletId
      ? this.discoveredWallets.get(walletId)
      : this.discoveredWallets.values().next().value;

    if (!targetWallet) {
      this.scanForProviders();
      targetWallet = walletId
        ? this.discoveredWallets.get(walletId)
        : this.discoveredWallets.values().next().value;

      if (!targetWallet) {
        throw new WalletError(
          "wallet_unavailable",
          "No Solana wallet found. Please install Phantom or Solflare extension.",
        );
      }
    }

    return this.doConnect(targetWallet);
  }

  private async doConnect(
    wallet: DiscoveredSolanaWallet,
  ): Promise<UniversalWalletSession> {
    let result: Awaited<ReturnType<SolanaProvider["connect"]>>;
    try {
      result = await wallet.provider.connect();
    } catch (err) {
      if (err instanceof WalletError) throw err;
      throw new WalletError(
        "user_rejected",
        "Connection rejected by user.",
        err,
      );
    }

    try {
      const publicKey = result.publicKey.toString();
      if (!isValidAddress(publicKey, "solana")) {
        throw new WalletError(
          "invalid_input",
          "Solana wallet returned an invalid base58 public key.",
        );
      }
      const publicKeyBytes = result.publicKey.toBytes?.();
      if (publicKeyBytes && publicKeyBytes.length !== 32) {
        throw new WalletError(
          "invalid_input",
          "Solana public keys must be exactly 32 bytes.",
        );
      }

      // Blocking genesis-hash lookup to detect the current Solana cluster.
      // This adds ~1-2 s to the connection UX but guarantees the correct
      // chain ID is used for balances, SIWx, and session metadata.
      const chainInfo = GENESIS_HASHES[this.defaultChain];
      const chain = chainInfo
        ? await resolveSolanaChain(chainInfo.rpc)
        : this.defaultChain;

      const session = createEmptySession({
        id: `solana-${wallet.id}-${Date.now()}`,
        walletId: wallet.id,
        walletType: "solana",
        namespaces: {
          solana: {
            chains: [chain],
            accounts: [`${chain}:${publicKey}`],
            methods: [
              "solana_signMessage",
              "solana_signTransaction",
              "solana_signAllTransactions",
              "solana_signAndSendTransaction",
            ],
            events: ["accountsChanged", "chainChanged"],
            capabilities: {},
          },
        },
        platform:
          typeof navigator !== "undefined" &&
          /mobile|android|iphone/i.test(navigator.userAgent)
            ? "mobile-web"
            : "desktop-web",
      });

      this.activeSession = { wallet, publicKey, session };
      this.setupEventListeners(wallet);

      return session;
    } catch (err) {
      if (err instanceof WalletError) throw err;
      throw new WalletError(
        "rpc_error",
        "Unable to verify the Solana network before creating a session.",
        err,
      );
    }
  }

  /**
   * Track account switches made inside the wallet.
   *
   * This handler previously only nulled the session on disconnect and had no
   * branch that recorded a new account at all — `accounts` was written once in
   * `connect()` and never again. Signing goes through the provider, so after a
   * switch the wallet signs with the new key while the session still reports
   * the old address: a SIWx message built from the session asserts an address
   * the returned signature does not belong to.
   *
   * The payload shape is read defensively rather than assumed. Wallets emit a
   * public key object, a base58 string, or an accounts array depending on the
   * implementation, and anything that does not validate as a Solana address is
   * treated as a disconnect instead of being written into the session.
   */
  /**
   * Detach the account listener attached by the previous connect.
   *
   * Without this, connect/disconnect/connect left two live handlers on the
   * same provider and every account change was reported once per connect that
   * had ever happened — duplicate notifications, and a session persisted once
   * per duplicate. `removeListener` was declared on SolanaProvider from the
   * start but never called.
   */
  private detachEventListeners(): void {
    const attached = this.attachedListener;
    if (!attached) return;
    this.attachedListener = undefined;
    const { provider } = attached.wallet;
    const remove = provider.off ?? provider.removeListener;
    if (!remove) return;
    try {
      remove.call(provider, "accountChanged", attached.handler);
    } catch {
      // A provider that throws on detach must not block disconnect.
    }
  }

  private setupEventListeners(wallet: DiscoveredSolanaWallet): void {
    // Re-connecting to the same or a different wallet must not stack handlers.
    this.detachEventListeners();

    const accountsHandler = (...args: unknown[]) => {
      const active = this.activeSession;
      if (!active || active.wallet !== wallet) return;

      const next = readSolanaAccount(args[0]);
      if (!next || !isValidAddress(next, "solana")) {
        // No usable account means the wallet is no longer authorizing us.
        this.activeSession = null;
        // An empty list is the disconnect signal in the shared contract.
        this.notifyAccountsChanged([]);
        return;
      }
      if (next === active.publicKey) return;

      active.publicKey = next;
      const namespace = active.session.namespaces.solana;
      if (!namespace) return;
      // Accounts are CAIP-10, keyed by the chains the session holds.
      namespace.accounts = namespace.chains.map((chain) => `${chain}:${next}`);
      active.session.updatedAt = new Date().toISOString();
      this.notifyAccountsChanged(namespace.accounts);
    };

    wallet.provider.on("accountChanged", accountsHandler);
    this.attachedListener = { wallet, handler: accountsHandler };
  }

  /**
   * UniversalConnector.onAccountsChanged.
   *
   * The session is already updated by the time subscribers run, so a consumer
   * can read `session.namespaces` rather than reconstruct anything from the
   * argument.
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

  private notifyAccountsChanged(accounts: string[]): void {
    for (const subscriber of [...this.accountsSubscribers]) {
      try {
        subscriber(accounts);
      } catch {
        // One bad subscriber must not stop the others from being told.
      }
    }
  }

  async disconnect(_session: UniversalWalletSession): Promise<void> {
    if (this.activeSession) {
      try {
        await this.activeSession.wallet.provider.disconnect();
      } catch (err) {
        // Logged, not surfaced, and deliberately not rethrown: the local
        // teardown below has to happen either way. A user who asks to
        // disconnect must end up disconnected here even when the wallet
        // refuses to hear it.
        logger.warn("connector-solana", "provider.disconnect failed", err);
      }
      this.detachEventListeners();
      this.activeSession = null;
    }
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    return session.namespaces.solana?.accounts ?? [];
  }

  /**
   * Which roles the connected account can actually fill.
   *
   * Ask before building a flow: `roles.signer === null` means this wallet will
   * not hand back a signed-but-unsent transaction, so a co-signing or
   * relayer-submitted flow has to offer a different wallet rather than
   * discover it at the approval prompt. `roles.payer === null` means the
   * opposite — it signs, but something else has to broadcast.
   *
   * Returns null when there is no live session, because the roles belong to a
   * connected account, not to the connector.
   */
  getRoles(session: UniversalWalletSession): SolanaRoles | null {
    const active = this.activeSession;
    if (!active) return null;
    // The session argument is the caller's view; the address and chain are
    // read from the live session so an in-wallet account switch is reflected.
    const chain =
      active.session.namespaces.solana?.chains[0] ??
      session.namespaces.solana?.chains[0] ??
      this.defaultChain;
    return solanaRoles(active.wallet, active.publicKey, chain);
  }

  async signMessage(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!this.activeSession) {
      throw new WalletError(
        "session_expired",
        "Session expired. Please reconnect your wallet.",
      );
    }

    if (
      !input ||
      typeof input !== "object" ||
      !("message" in input) ||
      typeof (input as Record<string, unknown>).message !== "string"
    ) {
      throw new WalletError(
        "method_not_allowed",
        "Missing message parameter for signing.",
      );
    }
    const message = (input as Record<string, unknown>).message as string;
    const messageBytes = new TextEncoder().encode(message);

    try {
      const result =
        await this.activeSession.wallet.provider.signMessage(messageBytes);
      return Array.from(result.signature);
    } catch (err) {
      if (err instanceof WalletError) throw err;
      throw new WalletError(
        "user_rejected",
        "Message signing rejected by user.",
        err,
      );
    }
  }

  async signTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!this.activeSession) {
      throw new WalletError(
        "session_expired",
        "Session expired. Please reconnect your wallet.",
      );
    }

    if (!input || typeof input !== "object" || !("transaction" in input))
      throw new WalletError(
        "method_not_allowed",
        "Missing transaction parameter.",
      );
    const inputObj = input as Record<string, unknown>;
    const transaction = inputObj.transaction as
      | { serialized?: number[] }
      | undefined;
    if (!transaction?.serialized || !Array.isArray(transaction.serialized))
      throw new WalletError("method_not_allowed", "Invalid transaction data.");
    const txBytes = new Uint8Array(transaction.serialized);

    try {
      const signedTx =
        await this.activeSession.wallet.provider.signTransaction(txBytes);
      return Array.from(signedTx);
    } catch (err) {
      if (err instanceof WalletError) throw err;
      throw new WalletError(
        "user_rejected",
        "Transaction signing rejected by user.",
        err,
      );
    }
  }

  async sendTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!this.activeSession) {
      throw new WalletError(
        "session_expired",
        "Session expired. Please reconnect your wallet.",
      );
    }

    if (!input || typeof input !== "object" || !("transaction" in input))
      throw new WalletError(
        "method_not_allowed",
        "Missing transaction parameter.",
      );
    const inputObj = input as Record<string, unknown>;
    const transaction = inputObj.transaction as
      | { serialized?: number[] }
      | undefined;
    if (!transaction?.serialized || !Array.isArray(transaction.serialized))
      throw new WalletError("method_not_allowed", "Invalid transaction data.");
    const txBytes = new Uint8Array(transaction.serialized);

    try {
      const result =
        await this.activeSession.wallet.provider.signAndSendTransaction(
          txBytes,
        );
      return result.signature;
    } catch (err) {
      if (err instanceof WalletError) throw err;
      throw new WalletError("tx_failed", "Transaction failed.", err);
    }
  }

  async switchChain(
    session: UniversalWalletSession,
    chainId: string,
  ): Promise<void> {
    const ns = session.namespaces?.solana;
    if (!ns) {
      throw new WalletError(
        "no_solana_session",
        "Session has no solana namespace",
      );
    }
    if (!(chainId in GENESIS_HASHES)) {
      throw new WalletError(
        "unsupported_chain",
        "Unsupported Solana chain. Use a canonical CAIP-2 genesis-hash chain ID.",
      );
    }
    if (ns.chains) {
      ns.chains = [chainId];
    }
  }

  onUpdate(callback: (wallets: DiscoveredSolanaWallet[]) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notifyListeners(): void {
    const wallets = this.getDiscoveredWallets();
    this.listeners.forEach((cb) => cb(wallets));
  }

  clear(): void {
    this.detachEventListeners();
    this.discoveredWallets.clear();
    this.activeSession = null;
    this.listeners.clear();
    this.accountsSubscribers.clear();
  }
}

export const solanaConnector = new SolanaConnectorImpl();
export { SolanaConnectorImpl as SolanaConnector };
export function createSolanaConnector(): SolanaConnectorImpl {
  return new SolanaConnectorImpl();
}

export function getSolanaProvider(walletId: string): SolanaProvider | null {
  const wallet = solanaConnector
    .getDiscoveredWallets()
    .find((w) => w.id === walletId);
  return wallet?.provider ?? null;
}
