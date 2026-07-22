/**
 * Pocket Connector — Bridge from @naculus/connect to @naculus/wallet-engine
 *
 * This is a thin adapter that wraps PocketWallet into a UniversalConnector
 * so the connect SDK can use the embedded wallet seamlessly.
 *
 * When @naculus/wallet-engine is published independently, this file is the
 * only bridge point between the two packages.
 */

import type {
  ConnectorSupport,
  UniversalConnector,
  UniversalWalletSession,
} from "@naculus/connect-core";
import { createEmptySession, WalletError } from "@naculus/connect-core";
import type { PocketConfig, WalletData } from "@naculus/wallet-engine";

const SUPPORT: ConnectorSupport = {
  desktop: true,
  mobile: true,
  deepLink: false,
  qr: false,
  trustedReconnect: true,
};

export type { PocketConfig, WalletData };

class PocketConnectorImpl implements UniversalConnector {
  readonly id = "pocket";
  readonly name = "Pocket Wallet";
  readonly kind = "embedded" as const;
  readonly namespaces = ["eip155"];
  readonly supports = SUPPORT;

  private cfg: PocketConfig & {
    storageKey: string;
    derivationPath: string;
    autoSave: boolean;
    chainId: string;
    rpcUrl: string;
  };
  private wallet: import("@naculus/wallet-engine").PocketWallet | null = null;

  constructor(config: PocketConfig = {}) {
    this.cfg = {
      storageKey: config.storageKey ?? "naculus_pocket",
      derivationPath: config.derivationPath ?? "m/44'/60'/0'/0/0",
      autoSave: config.autoSave ?? true,
      chainId: config.chainId ?? "eip155:1",
      rpcUrl: config.rpcUrl ?? "",
    };
  }

  private async ensureWallet(): Promise<
    import("@naculus/wallet-engine").PocketWallet
  > {
    if (!this.wallet) {
      const { PocketWallet } = await import("@naculus/wallet-engine");
      this.wallet = new PocketWallet(this.cfg);
    }
    return this.wallet;
  }

  // ── Wallet Lifecycle ──────────────────────────────────────────

  /** Generate a new random wallet */
  async generateWallet(): Promise<WalletData> {
    const w = await this.ensureWallet();
    return w.generate();
  }

  /** Import from mnemonic */
  async importFromMnemonic(mnemonic: string): Promise<WalletData> {
    const w = await this.ensureWallet();
    return w.importMnemonic(mnemonic);
  }

  /** Import from private key */
  async importFromPrivateKey(pkHex: `0x${string}`): Promise<WalletData> {
    const w = await this.ensureWallet();
    return w.importPrivateKey(pkHex);
  }

  /** Load wallet from storage */
  async load(): Promise<boolean> {
    const w = await this.ensureWallet();
    return w.load();
  }

  /** Get current wallet data */
  getWallet(): WalletData | null {
    return this.wallet?.getWalletData() ?? null;
  }

  /** Check if wallet exists */
  hasWallet(): boolean {
    return this.wallet?.hasWallet ?? false;
  }

  /** Get wallet address */
  getAddress(): string | null {
    return this.wallet?.address ?? null;
  }

  /**
   * Storage security tier — delegates to PocketWallet.getStorageSecurityLevel().
   *
   *   1 = IndexedDB + AES-GCM  (highest)
   *   2 = IndexedDB             (default)
   *   3 = localStorage + AES-GCM(warning)
   *   4 = localStorage          (critical — switch browser)
   */
  getStorageSecurityLevel(): number {
    return this.wallet?.getStorageSecurityLevel() ?? 4;
  }

  /** Securely wipe wallet */
  async wipe(): Promise<void> {
    const w = await this.ensureWallet();
    await w.wipe();
  }

  // ── UniversalConnector Implementation ─────────────────────────

  async connect(): Promise<UniversalWalletSession> {
    const w = await this.ensureWallet();
    const loaded = await w.load();
    if (!loaded) await w.generate();
    if (!w.address)
      throw new WalletError("tx_failed", "Failed to create pocket wallet");

    const addr = w.address;
    const cid = this.cfg.chainId;
    return createEmptySession({
      id: `pocket-${addr}-${Date.now()}`,
      walletId: addr,
      walletType: "embedded",
      namespaces: {
        eip155: {
          chains: [cid],
          accounts: [`${cid}:${addr}`],
          methods: [
            "eth_sendTransaction",
            "personal_sign",
            "eth_signTypedData",
            "eth_signTypedData_v4",
          ],
          events: [],
        },
      },
      platform: "desktop-web",
    });
  }

  async reconnect(
    session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    return session;
  }

  async disconnect(): Promise<void> {
    this.wallet = null;
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    const w = await this.ensureWallet();
    if (!w.address) return [];
    return [`${this.cfg.chainId}:${w.address}`];
  }

  async signMessage(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    const w = await this.ensureWallet();
    const raw = input as Record<string, unknown>;
    const message = raw.message as string;

    // Route to typed data signing if typed data is provided
    const typedData = raw.typedData as string | undefined;
    if (typedData) {
      if (!w.signTypedData)
        throw new WalletError(
          "method_not_allowed",
          "signTypedData not supported",
        );
      const result = await w.signTypedData(typedData);
      return result.signature;
    }

    if (!message)
      throw new WalletError("invalid_input", "Message is required for signing");
    const result = await w.signMessage(message);
    return result.signature;
  }

  async signTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    const w = await this.ensureWallet();
    const raw = input as Record<string, unknown>;
    const txInput = {
      to: raw.to as string,
      value: raw.value as string,
      data: raw.data as string,
      gas: raw.gas as string,
      gasPrice: raw.gasPrice as string,
      chainId: parseInt(this.cfg.chainId.split(":")[1], 10),
    };
    return w.signTransaction(txInput);
  }

  async sendTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    const w = await this.ensureWallet();
    const raw = input as Record<string, unknown>;
    const txInput = {
      to: raw.to as string,
      value: raw.value as string,
      data: raw.data as string,
      gas: raw.gas as string,
      gasPrice: raw.gasPrice as string,
    };
    return w.sendTransaction(txInput);
  }

  async switchChain(
    session: UniversalWalletSession,
    chainId: string,
  ): Promise<void> {
    this.cfg.chainId = chainId.startsWith("eip155:")
      ? chainId
      : `eip155:${chainId}`;
    const w = await this.ensureWallet();
    w.setChain(this.cfg.chainId);
    session.namespaces.eip155.chains = [this.cfg.chainId];
    if (w.address) {
      session.namespaces.eip155.accounts = [`${this.cfg.chainId}:${w.address}`];
    }
  }

  async sendCalls(
    session: UniversalWalletSession,
    calls: any[],
    chainId?: string,
  ): Promise<string> {
    throw new WalletError(
      "method_unsupported",
      "sendCalls not supported via Pocket connector",
    );
  }

  async getCapabilities(
    session: UniversalWalletSession,
  ): Promise<Record<string, any>> {
    return {};
  }
}

// ── Exports (New API) ─────────────────────────────────────────
export function createPocketConnector(
  config?: PocketConfig,
): PocketConnectorImpl {
  return new PocketConnectorImpl(config);
}
export type { PocketConnectorImpl as PocketConnectorClass };
export { PocketConnectorImpl as PocketConnector };
