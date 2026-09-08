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
  SendCallsOptions,
  UniversalConnector,
  UniversalWalletSession,
} from "@naculus/connect-core";
import {
  createEmptySession,
  SOLANA_MAINNET,
  WalletError,
} from "@naculus/connect-core";
import type {
  PocketConfig,
  StorageSecurityFinding,
  StorageSecurityReport,
  WalletAccount,
  WalletData,
  WalletNamespace,
} from "@naculus/wallet-engine";

/**
 * Pull a serialized Solana transaction out of whatever shape the caller used.
 *
 * `UniversalConnector.sendTransaction` takes an opaque input because an EVM
 * transaction and a Solana one have nothing in common: one is a set of named
 * fields the wallet assembles, the other is bytes the application already
 * built. Accepting both shapes here is what lets one connector method serve
 * both without an EVM-shaped object being read as Solana bytes.
 */
function extractSolanaTransaction(input: unknown): Uint8Array | string {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") return input;
  const record = input as Record<string, unknown> | null;
  const candidate = record?.transaction ?? record?.tx ?? record?.message;
  if (candidate instanceof Uint8Array || typeof candidate === "string") {
    return candidate;
  }
  throw new WalletError(
    "invalid_input",
    "A Solana transaction must be supplied as base64 or bytes. Build and serialize it with @solana/kit or @solana/web3.js first.",
  );
}

const SUPPORT: ConnectorSupport = {
  desktop: true,
  mobile: true,
  deepLink: false,
  qr: false,
  trustedReconnect: true,
};

function normalizeEip155ChainId(chainId: string): string {
  if (typeof chainId !== "string" || !/^eip155:[1-9][0-9]*$/.test(chainId)) {
    throw new WalletError(
      "chain_unsupported",
      `Invalid EIP-155 chain ID: ${chainId}`,
    );
  }
  const reference = BigInt(chainId.slice("eip155:".length));
  if (reference <= 0n || reference > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WalletError(
      "chain_unsupported",
      `EIP-155 chain ID is outside the embedded signer's numeric range: ${chainId}`,
    );
  }
  return `eip155:${reference.toString(10)}`;
}

function extractTransactionInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    throw new WalletError("invalid_input", "Invalid transaction input");
  }
  const inputObject = input as Record<string, unknown>;
  if (!("transaction" in inputObject)) return inputObject;

  const transaction = inputObject.transaction;
  if (
    !transaction ||
    typeof transaction !== "object" ||
    Array.isArray(transaction)
  ) {
    throw new WalletError("invalid_input", "Transaction must be an object");
  }
  const transactionObject = transaction as Record<string, unknown>;
  const requestChainId = inputObject.chainId;
  const transactionChainId = transactionObject.chainId;
  if (requestChainId !== undefined && transactionChainId !== undefined) {
    const outer = parseRequestChainId(requestChainId);
    const inner = parseRequestChainId(transactionChainId);
    if (outer !== inner) {
      throw new WalletError(
        "chain_mismatch",
        "Transaction and request chain IDs do not match.",
      );
    }
  }
  if (transactionChainId === undefined && requestChainId !== undefined) {
    return { ...transactionObject, chainId: requestChainId };
  }
  return transactionObject;
}

function parseRequestChainId(value: unknown): bigint {
  let requested: bigint;
  try {
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      requested = BigInt(value);
    } else if (
      typeof value === "string" &&
      /^(?:eip155:[1-9][0-9]*|0x[0-9a-fA-F]+|[1-9][0-9]*)$/.test(value)
    ) {
      requested = BigInt(value.startsWith("eip155:") ? value.slice(7) : value);
    } else {
      throw new Error("invalid chain id");
    }
  } catch {
    throw new WalletError("chain_unsupported", "Invalid transaction chain ID.");
  }
  if (requested <= 0n || requested > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WalletError("chain_unsupported", "Invalid transaction chain ID.");
  }
  return requested;
}

function resolveRequestChainId(
  value: unknown,
  configuredChainId: string,
): number {
  const configured = Number(configuredChainId.slice("eip155:".length));
  if (value === undefined) return configured;
  const requested = parseRequestChainId(value);
  if (requested !== BigInt(configured)) {
    throw new WalletError(
      "chain_mismatch",
      `Transaction chain ID ${requested} does not match configured chain ${configuredChainId}.`,
    );
  }
  return Number(requested);
}

/**
 * Refuse a request that names an account other than the one that would sign.
 *
 * A wallet holding an EVM and a Solana account signs with whichever is active.
 * An application that says "sign as 0x9858…" and receives an ed25519 signature
 * has been told something false about what it holds, and nothing downstream
 * can tell: the signature is well-formed, it simply verifies against nothing.
 *
 * Compared case-insensitively for EVM (hex addresses are case-insensitive
 * apart from the EIP-55 checksum) and exactly for Solana (base58 is not).
 */
function validateRequestAccount(value: unknown, account: WalletAccount): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new WalletError(
      "invalid_input",
      "Requested account must be a string.",
    );
  }
  // Accept a CAIP-10 value by taking its address half, which is what a
  // session's account list contains.
  const requested = value.includes(":") ? value.split(":").pop()! : value;
  const matches =
    account.namespace === "eip155"
      ? requested.toLowerCase() === account.address.toLowerCase()
      : requested === account.address;
  if (!matches) {
    throw new WalletError(
      "invalid_input",
      `This wallet is signing as ${account.address} (${account.namespace}). Switch the active account before requesting a signature from ${requested}.`,
    );
  }
}

function validateRequestFrom(value: unknown, address: string): void {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(value) ||
    value.toLowerCase() !== address.toLowerCase()
  ) {
    throw new WalletError(
      "invalid_input",
      "Transaction 'from' must match the embedded wallet account.",
    );
  }
}

export type {
  PocketConfig,
  StorageSecurityFinding,
  StorageSecurityReport,
  WalletData,
};

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
  private readonly accountListeners = new Set<
    (accounts: string[]) => void
  >();
  private activeSessionId: string | null = null;

  private requireActiveSession(session: UniversalWalletSession): void {
    if (!this.activeSessionId || session.id !== this.activeSessionId) {
      throw new WalletError(
        "session_expired",
        "Embedded wallet session is not active.",
      );
    }
  }

  private validateSessionAccount(
    session: UniversalWalletSession,
    address: string,
  ): void {
    const namespace = session.namespaces.eip155;
    const account = namespace?.accounts?.[0];
    if (
      !namespace ||
      !Array.isArray(namespace.chains) ||
      namespace.chains.length !== 1 ||
      namespace.chains[0] !== this.cfg.chainId ||
      !account
    ) {
      throw new WalletError(
        "session_expired",
        "Embedded wallet session namespace does not match the configured chain.",
      );
    }
    const parts = account.split(":");
    const rawAddress = parts.length === 3 ? parts[2] : undefined;
    if (
      parts.length !== 3 ||
      `${parts[0]}:${parts[1]}` !== this.cfg.chainId ||
      !rawAddress ||
      rawAddress.toLowerCase() !== address.toLowerCase()
    ) {
      throw new WalletError(
        "session_expired",
        "Embedded wallet session account does not match the wallet.",
      );
    }
  }

  constructor(config: PocketConfig = {}) {
    this.cfg = {
      ...config,
      storageKey: config.storageKey ?? "naculus_pocket",
      derivationPath: config.derivationPath ?? "m/44'/60'/0'/0/0",
      autoSave: config.autoSave ?? true,
      chainId: normalizeEip155ChainId(config.chainId ?? "eip155:1"),
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
  /**
   * Import a raw key in any form the engine recognizes.
   *
   * Widened from `0x${string}` so the base58 and JSON forms Phantom and
   * solana-keygen export can reach the engine, which detects the chain.
   */
  async importFromPrivateKey(pkHex: string): Promise<WalletData> {
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
   * Session namespaces from the accounts this wallet actually holds.
   *
   * Previously this always emitted a single `eip155` namespace containing
   * `wallet.address`. Once a wallet could hold a Solana account too, that
   * published a base58 Solana address as an EIP-155 account whenever Solana
   * was active — a CAIP-10 string asserting the address lives on a chain it
   * has never existed on.
   */
  private buildNamespaces(): UniversalWalletSession["namespaces"] {
    const accounts = this.wallet?.accounts() ?? [];
    const namespaces: UniversalWalletSession["namespaces"] = {};
    const evm = accounts.find((a) => a.namespace === "eip155");
    if (evm) {
      namespaces.eip155 = {
        chains: [this.cfg.chainId],
        accounts: [`${this.cfg.chainId}:${evm.address}`],
        methods: [
          "eth_sendTransaction",
          "personal_sign",
          "eth_signTypedData",
          "eth_signTypedData_v4",
        ],
        events: [],
      };
    }
    const solana = accounts.find((a) => a.namespace === "solana");
    if (solana) {
      namespaces.solana = {
        chains: [SOLANA_MAINNET],
        accounts: [`${SOLANA_MAINNET}:${solana.address}`],
        methods: ["signMessage", "signTransaction", "signAndSendTransaction"],
        events: [],
      };
    }
    return namespaces;
  }

  /**
   * Report a change in which accounts this wallet exposes.
   *
   * The comment that used to sit in the client's dispatch — "neither wallet
   * can change account behind the dApp's back" — was true when the embedded
   * wallet held one key. `setActiveNamespace` and `backfillAccounts` rotate it
   * through an explicit call, and without this the provider kept publishing
   * the account from connect time while a different key signed.
   */
  onAccountsChanged(
    _session: UniversalWalletSession,
    handler: (accounts: string[]) => void,
  ): () => void {
    this.accountListeners.add(handler);
    return () => {
      this.accountListeners.delete(handler);
    };
  }

  private emitAccountsChanged(): void {
    if (this.accountListeners.size === 0) return;
    const accounts = Object.values(this.buildNamespaces()).flatMap(
      (ns) => ns?.accounts ?? [],
    );
    for (const handler of [...this.accountListeners]) {
      try {
        handler(accounts);
      } catch {
        // A listener that throws must not stop the others from being told,
        // and must not leave the wallet mid-switch.
      }
    }
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

  /**
   * The full storage security assessment, or null before a wallet exists.
   *
   * Null rather than a worst-case report: the storage backend is chosen when
   * the wallet is constructed, so before that there is nothing to assess, and
   * rendering "30/100" for a wallet that has not been created yet would be a
   * warning about a state that does not exist.
   */
  getStorageSecurityReport(): StorageSecurityReport | null {
    return this.wallet?.getStorageSecurityReport() ?? null;
  }

  /**
   * The private key for a namespace, in the form that ecosystem's wallets
   * accept — `0x` hex for EVM, base58 for Solana.
   *
   * The exit route. Without it a user's only way out is the recovery phrase,
   * and a wallet imported from a raw key does not have one.
   */
  exportPrivateKey(namespace?: WalletNamespace): string {
    if (!this.wallet) {
      throw new WalletError("no_wallet", "No wallet loaded.");
    }
    return this.wallet.exportPrivateKey(namespace);
  }

  /** The Solana key as the JSON byte array `solana-keygen` writes. */
  exportSolanaKeypairJson(): string {
    if (!this.wallet) {
      throw new WalletError("no_wallet", "No wallet loaded.");
    }
    return this.wallet.exportSolanaKeypairJson();
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
    const session = createEmptySession({
      id: `pocket-${addr}-${Date.now()}`,
      walletId: addr,
      walletType: "embedded",
      namespaces: this.buildNamespaces(),
      platform: "desktop-web",
    });
    this.activeSessionId = session.id;
    return session;
  }

  async reconnect(
    session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    const w = await this.ensureWallet();
    if (!(await w.load()) || !w.address) {
      throw new WalletError(
        "session_expired",
        "Embedded wallet is no longer available.",
      );
    }
    this.validateSessionAccount(session, w.address);
    this.activeSessionId = session.id;
    return session;
  }

  async disconnect(session?: UniversalWalletSession): Promise<void> {
    if (
      session &&
      this.activeSessionId &&
      session.id !== this.activeSessionId
    ) {
      throw new WalletError(
        "session_expired",
        "Embedded wallet session is not active.",
      );
    }
    this.wallet = null;
    this.activeSessionId = null;
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    if (!this.activeSessionId) return [];
    this.requireActiveSession(session);
    const w = await this.ensureWallet();
    if (!w.address) return [];
    this.validateSessionAccount(session, w.address);
    return [`${this.cfg.chainId}:${w.address}`];
  }

  /** Every account this wallet holds, one per namespace. */
  accounts(): WalletAccount[] {
    return this.wallet?.accounts() ?? [];
  }

  /** The account for a namespace, or null when this wallet holds none. */
  account(namespace: WalletNamespace): WalletAccount | null {
    return this.wallet?.account(namespace) ?? null;
  }

  /**
   * Choose which account signs by default.
   *
   * Throws for a namespace this wallet has no account for, rather than
   * leaving the wallet pointing at nothing.
   */
  setActiveNamespace(namespace: WalletNamespace): void {
    if (!this.wallet) {
      throw new WalletError("no_wallet", "No wallet loaded.");
    }
    this.wallet.setActiveNamespace(namespace);
    this.emitAccountsChanged();
  }

  /**
   * Derive accounts the phrase produces but the record does not yet hold.
   *
   * A wallet created before multi-namespace support has a mnemonic and
   * therefore already owns a Solana account — the same phrase in Phantom shows
   * it — so this makes it visible here too. Returns what was added.
   */
  async backfillAccounts(): Promise<WalletAccount[]> {
    if (!this.wallet) {
      throw new WalletError("no_wallet", "No wallet loaded.");
    }
    const added = await this.wallet.backfillAccounts();
    if (added.length > 0) {
      // Persisted here rather than left to the caller. A derived account that
      // is not written is gone on the next load, so the user would be asked
      // to backfill again every session and would reasonably conclude it does
      // not work.
      await this.wallet.save();
      this.emitAccountsChanged();
    }
    return added;
  }

  /** Persist the current wallet record. */
  async save(): Promise<void> {
    if (!this.wallet) {
      throw new WalletError("no_wallet", "No wallet loaded.");
    }
    await this.wallet.save();
  }

  /**
   * Sign a 32-byte digest, EIP-191 wrapped.
   *
   * Exposed so this wallet can own an ERC-4337 smart account. Routing a
   * userOpHash through `signMessage` would sign its hex spelling and produce a
   * signature the account rejects on chain, which is why the account
   * abstraction path previously refused embedded wallets outright.
   */
  async signHash(
    session: UniversalWalletSession,
    hash: `0x${string}`,
  ): Promise<`0x${string}`> {
    this.requireActiveSession(session);
    const w = await this.ensureWallet();
    const result = await w.signHash(hash);
    return result.signature as `0x${string}`;
  }

  async signMessage(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    this.requireActiveSession(session);
    const w = await this.ensureWallet();
    const raw =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : {};
    const message = raw.message as string;

    // An app naming an account it is not going to get a signature from must
    // be told, not quietly served a signature from a different curve.
    const active = w.getWalletData()?.accounts.find(
      (a) => a.namespace === w.getWalletData()?.activeNamespace,
    );
    if (active) validateRequestAccount(raw.address, active);

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
    this.requireActiveSession(session);
    const w = await this.ensureWallet();
    // Routed on the active namespace, not on the shape of the input. An
    // ed25519 signature over EVM-shaped fields, or an EIP-155 signature over
    // Solana bytes, is well-formed and verifies against nothing.
    if (w.getWalletData()?.activeNamespace === "solana") {
      return w.signSolanaTransaction(extractSolanaTransaction(input));
    }
    const raw = extractTransactionInput(input);
    validateRequestFrom(raw.from, w.address ?? "");
    const txInput = {
      to: raw.to as string,
      value: raw.value as string,
      data: raw.data as string,
      gas: raw.gas as string,
      gasPrice: raw.gasPrice as string,
      chainId: resolveRequestChainId(raw.chainId, this.cfg.chainId),
    };
    return w.signTransaction(txInput);
  }

  async sendTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    this.requireActiveSession(session);
    const w = await this.ensureWallet();
    if (w.getWalletData()?.activeNamespace === "solana") {
      return w.sendSolanaTransaction(extractSolanaTransaction(input));
    }
    const raw = extractTransactionInput(input);
    validateRequestFrom(raw.from, w.address ?? "");
    const txInput = {
      to: raw.to as string,
      value: raw.value as string,
      data: raw.data as string,
      gas: raw.gas as string,
      gasPrice: raw.gasPrice as string,
      chainId: resolveRequestChainId(raw.chainId, this.cfg.chainId),
    };
    return w.sendTransaction(txInput);
  }

  async switchChain(
    session: UniversalWalletSession,
    chainId: string,
  ): Promise<void> {
    this.requireActiveSession(session);
    this.cfg.chainId = normalizeEip155ChainId(
      chainId.startsWith("eip155:") ? chainId : `eip155:${chainId}`,
    );
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
    _options?: SendCallsOptions,
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
export type { WalletAccount, WalletNamespace } from "@naculus/wallet-engine";
export type { PocketConnectorImpl as PocketConnectorClass };
export { PocketConnectorImpl as PocketConnector };
