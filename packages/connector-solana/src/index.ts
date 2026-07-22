import type {
  ConnectorSupport,
  UniversalConnector,
  UniversalWalletSession,
} from "@naculus/connect-core";
import { createEmptySession, WalletError } from "@naculus/connect-core";
import {
  createProviderFromWalletStandard,
  isPhantomInstalled,
  isSolflareInstalled,
  SOLANA_WALLET_META,
} from "./discovery";
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

class SolanaConnectorImpl implements UniversalConnector {
  readonly id = "solana";
  readonly name = "Solana Wallets";
  readonly kind = "solana" as const;
  readonly namespaces = ["solana"];
  readonly supports = SUPPORT;

  private defaultChain = "solana:0";
  private discoveredWallets: Map<string, DiscoveredSolanaWallet> = new Map();
  private listeners: Set<(wallets: DiscoveredSolanaWallet[]) => void> =
    new Set();
  private activeSession: SolanaConnectorSession | null = null;

  /** Configure the connector before use. */
  configure(config: { defaultChain?: string }): void {
    if (config.defaultChain && config.defaultChain in GENESIS_HASHES) {
      this.defaultChain = config.defaultChain;
    }
  }

  startDiscovery(): void {
    if (typeof window === "undefined") return;
    this.scanForProviders();
    this.listenForWalletStandard();
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

  private listenForWalletStandard(): void {
    const handler = (event: Event) => {
      const wallet = (event as CustomEvent<WalletStandardWallet>).detail;
      if (!wallet?.name) return;

      const id = `wallet-standard-${wallet.name.toLowerCase().replace(/\s+/g, "-")}`;
      if (this.discoveredWallets.has(id)) return;

      const discovered: DiscoveredSolanaWallet = {
        id,
        name: wallet.name,
        icon: wallet.icon,
        rdns: wallet.rdns,
        provider: createProviderFromWalletStandard(wallet),
        source: "wallet-standard",
      };
      this.discoveredWallets.set(id, discovered);
      this.notifyListeners();
    };
    this.walletStandardHandler = handler;
    if (typeof window !== "undefined" && "addEventListener" in window) {
      window.addEventListener("wallet-standard:register-wallet", handler);
    }
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

    if (phantomProvider && !this.discoveredWallets.has("phantom")) {
      console.warn(
        "Wallet Phantom discovered via legacy window.solana. For better compatibility, consider using @solana/wallet-standard.",
      );
      const wallet: DiscoveredSolanaWallet = {
        id: "phantom",
        name: SOLANA_WALLET_META["phantom"].name,
        icon: SOLANA_WALLET_META["phantom"].icon,
        rdns: SOLANA_WALLET_META["phantom"].rdns,
        provider: phantomProvider,
        source: "legacy",
      };
      this.discoveredWallets.set("phantom", wallet);
    }

    let solflareProvider: SolanaProvider | null = null;
    const solflareWin = win.solflare as SolanaProvider | undefined;
    if (solflareWin?.isSolflare) {
      solflareProvider = solflareWin;
    }
    if (solflareProvider && !this.discoveredWallets.has("solflare")) {
      console.warn(
        "Wallet Solflare discovered via legacy window.solflare. For better compatibility, consider using @solana/wallet-standard.",
      );
      const wallet: DiscoveredSolanaWallet = {
        id: "solflare",
        name: SOLANA_WALLET_META["solflare"].name,
        icon: SOLANA_WALLET_META["solflare"].icon,
        rdns: SOLANA_WALLET_META["solflare"].rdns,
        provider: solflareProvider,
        source: "legacy",
      };
      this.discoveredWallets.set("solflare", wallet);
    }

    const genericProvider = win.solana as SolanaProvider | undefined;
    if (
      genericProvider &&
      !genericProvider.isPhantom &&
      !genericProvider.isSolflare &&
      !this.discoveredWallets.has("generic")
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
    try {
      const result = await wallet.provider.connect();
      const publicKey = result.publicKey.toString();

      // Blocking genesis-hash lookup to detect the current Solana cluster.
      // This adds ~1-2 s to the connection UX but guarantees the correct
      // chain ID is used for balances, SIWx, and session metadata.
      const chainInfo = GENESIS_HASHES[this.defaultChain];
      const chain = chainInfo
        ? await resolveSolanaChain(chainInfo.rpc, this.defaultChain)
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

      this.activeSession = { wallet, publicKey };
      this.setupEventListeners(wallet);

      return session;
    } catch (err) {
      throw new WalletError(
        "user_rejected",
        "Connection rejected by user.",
        err,
      );
    }
  }

  private setupEventListeners(wallet: DiscoveredSolanaWallet): void {
    const accountsHandler = (...args: unknown[]) => {
      const accounts = args[0] as { publicKey?: { toString(): string } }[];
      if (!accounts || accounts.length === 0) {
        this.activeSession = null;
      }
    };

    wallet.provider.on("accountChanged", accountsHandler);
  }

  async disconnect(_session: UniversalWalletSession): Promise<void> {
    if (this.activeSession) {
      try {
        await this.activeSession.wallet.provider.disconnect();
      } catch {}
      this.activeSession = null;
    }
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    return session.namespaces.solana?.accounts ?? [];
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
    if (!chainId.startsWith("solana:")) {
      throw new WalletError(
        "unsupported_chain",
        "Unsupported chain: must use solana: namespace",
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
    this.discoveredWallets.clear();
    this.activeSession = null;
    this.listeners.clear();
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
