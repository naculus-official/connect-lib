import * as erc20 from "./erc20-utils";
import { WalletError } from "./errors";
import type {
  EstimatedFeeResult,
  FeeBumpOptions,
  FeeOptions,
} from "./fee-oracle";
import {
  applyMultiplier,
  estimateFee as oracleEstimateFee,
  resolveFeeOptions,
  shouldUseEIP1559,
  validateFeeParams,
} from "./fee-oracle";
import { SessionKeyManager } from "./session-keys/SessionKeyManager";
import type {
  ScopeCheckResult,
  SessionKeyInfo,
  SessionKeyScope,
  SessionSignResult,
} from "./session-keys/types";
import { Ed25519Signer } from "./signers/ed25519";
import { EVMSigner } from "./signers/evm";
import { IsolatedSigner } from "./signers/isolated-signer";
import type {
  Signer,
  SignRequest,
  SignResult,
  TransactionRequest,
  TransactionResult,
} from "./signers/types";
import { SimulationManager } from "./simulation/SimulationManager";
import type { SimulationConfig, SimulationResult } from "./simulation/types";
import { ed25519 } from "@noble/curves/ed25519";
import {
  toSolanaKeypairJson,
  toSolanaPrivateKeyBase58,
} from "./derivation/key-formats";
import {
  isFullySigned,
  signSolanaTransaction,
  solanaSecretSeed,
  toBase64,
  toWireBytes,
} from "./solana/transaction";
import { EncryptedStorageAdapter } from "./storage/encrypted";
import {
  assessStorageSecurity,
  type StorageSecurityReport,
} from "./storage/security";
import type { PrfUnlockProvider, UnlockState } from "./storage/unlock";
import { IndexedDbStorageAdapter } from "./storage/indexed-db";
import { LocalStorageAdapter } from "./storage/local-storage";
import type {
  StorageAdapter,
  StorageSecurityLevel,
  StorageType,
} from "./storage/types";
import {
  buildTransaction,
  cloneForBumping,
  resolveChainId,
} from "./transaction";
import { MemoryHistoryStorage } from "./tx-monitor/TxHistoryStore";
import { TxMonitor } from "./tx-monitor/TxMonitor";
import type {
  ProviderLike,
  TxStatusEntry,
  WatchTxOptions,
} from "./tx-monitor/types";
import * as sim from "./wallet-simulation";

export type { EstimatedFeeResult, FeeBumpOptions, FeeOptions };

export interface PocketConfig {
  /** Storage key prefix (default: "naculus_pocket") */
  storageKey?: string;
  /** BIP44 derivation path (default: "m/44'/60'/0'/0/0") */
  derivationPath?: string;
  /** Auto-save wallet after generate/import (default: true) */
  autoSave?: boolean;
  /** Default chain ID (CAIP-10 format, default: "eip155:1") */
  chainId?: string;
  /** RPC URL for transaction broadcasting */
  rpcUrl?: string;
  /**
   * Solana JSON-RPC endpoint, for submitting signed Solana transactions.
   *
   * Separate from `rpcUrl` on purpose: that one is an EIP-155 endpoint, and
   * pointing Solana traffic at it would fail in a way whose error message
   * blames the transaction.
   */
  solanaRpcUrl?: string;
  /**
   * Storage backend selection.
   *
   * - undefined (default): auto-picks IndexedDB. Falls back to localStorage
   *   only when IndexedDB is unavailable, with a warning flag set.
   * - "indexedDb": force IndexedDB (throws if unavailable)
   * - "localStorage": force localStorage (⚠️ insecure — only for dev/testing)
   *
   * Dev override: set this to "localStorage" to test localStorage behavior
   * without the IndexedDB dependency.
   */
  storageType?: StorageType;
  /**
   * Allow unencrypted localStorage fallback. Disabled in browser contexts by
   * default; only enable this for controlled development/test environments.
   */
  allowInsecureStorage?: boolean;
  /**
   * Optional AES-256-GCM encryption passphrase callback.
   *
   * When provided, the storage backend is wrapped with EncryptedStorageAdapter
   * regardless of which backend (IndexedDB/localStorage) is active.
   * The callback is invoked once at wallet creation to derive the encryption key.
   *
   * Without this, data is stored as base64 plaintext (default).
   *
   * Example:
   * ```ts
   * const wallet = new PocketWallet({
   *   encryptionPassphrase: async () => prompt("Enter passphrase:") ?? "",
   * });
   * ```
   */
  encryptionPassphrase?: () => Promise<string>;
  /**
   * WebAuthn PRF provider for unlocking encrypted storage.
   *
   * Supplying one turns passkey protection on by itself — there is no separate
   * enable step, because a protection that has to be switched on protects
   * only the people who already knew to look for it. When the authenticator
   * cannot answer, writes silently stay passphrase-only rather than failing.
   *
   * Requires `encryptionPassphrase`: the passphrase wrap is the route back
   * when the authenticator is lost, and is always written alongside.
   *
   * `@naculus/connector-passkeys` supplies one via
   * `createPasskeyUnlockProvider(connector)`.
   */
  prfUnlock?: PrfUnlockProvider;
  /** Custom storage adapter (overrides storageType auto-selection) */
  storage?: StorageAdapter;
  /** Custom signer for transaction signing (default: EVMSigner) */
  signer?: Signer;
  /**
   * External simulation capability function.
   *
   * When provided, enables wallet.simulateTransaction().
   * The connect-core package provides SimulationManager.simulate() which
   * can be used here for production simulation.
   */
  /**
   * External simulation capability function.
   *
   * When provided, enables wallet.simulateTransaction().
   * The connect-core package provides SimulationManager.simulate() which
   * can be used here for production simulation.
   */
  simulateFn?: (
    tx: {
      to: string;
      data?: string;
      value?: string;
    },
    from: string,
    options?: {
      chainId?: number;
      origin?: string;
      rpcUrl?: string;
    },
  ) => Promise<{
    status: "success" | "reverted" | "unavailable";
    revertReason?: string;
    balanceChanges: Array<{
      tokenAddress: string;
      tokenSymbol: string;
      tokenDecimals: number;
      amount: string;
      direction: "in" | "out";
      from: string;
      to: string;
      humanReadable: string;
    }>;
    approvalChanges: Array<{
      tokenAddress: string;
      tokenSymbol: string;
      owner: string;
      spender: string;
      amount: string;
      isUnlimited: boolean;
      humanReadable: string;
    }>;
    riskAssessment: {
      level: "safe" | "warning" | "malicious" | "unknown";
      score: number;
      warnings: Array<{ category: string; severity: string; message: string }>;
    };
    gasInfo?: {
      gasLimit: bigint;
      gasPrice?: bigint;
      estimatedFeeEth?: string;
      estimatedFeeUsd?: string;
    };
    provider: string;
    summary?: string;
    changesDetected: boolean;
  }>;

  // ── Built-in Simulation (P0, no API key required) ────────────

  /**
   * Whether to automatically simulate transactions before sending.
   * When enabled, every sendTransaction() call will run eth_call first
   * and reject if the simulation reverts. Default: false
   */
  autoSimulate?: boolean;

  /**
   * Simulation configuration for the built-in SimulationManager.
   * Provide an rpcUrl here (or rely on the wallet's main rpcUrl).
   */
  simulation?: SimulationConfig;

  /**
   * Memory isolation mode for sensitive data.
   * - undefined: default (EVMSigner, plaintext in memory)
   * - "worker": run signing in a Web Worker (IsolatedSigner)
   * - "secure": encrypt in-memory secrets, zero-fill after use
   */
  isolation?: "worker" | "secure";
}

/** Namespaces this wallet can hold keys for. */
export type WalletNamespace = "eip155" | "solana";

/**
 * One account, on one namespace.
 *
 * A wallet holds several because one seed derives a separate, independent key
 * per BIP-44 coin type. They are not variants of one key: holding the Solana
 * key does not let anyone compute the EVM key, and vice versa.
 */
export interface WalletAccount {
  namespace: WalletNamespace;
  /** secp256k1 key, or ed25519 seed, hex with an 0x prefix. */
  privateKey: string;
  /** Checksummed 0x address, or base58 public key. */
  address: string;
  /**
   * Where this was derived.
   *
   * Absent for a raw imported key, and that absence matters: such an account
   * cannot be recovered from the mnemonic, so losing the key loses it.
   */
  derivationPath?: string;
}

export interface WalletData {
  /** Empty when the wallet was imported from a raw key. */
  mnemonic: string;
  /**
   * Every account this wallet holds.
   *
   * Replaced the single `privateKey` / `address` pair in version 2. A record
   * without `version` is version 1 and is migrated on read; see
   * `migrateWalletData`.
   */
  accounts: WalletAccount[];
  /** Which account signs when no namespace is named. */
  activeNamespace: WalletNamespace;
  createdAt: number;
  /** Last used chain ID */
  chainId?: string;
  /** Absent means version 1. */
  version?: 2;
  /**
   * The active account's address.
   *
   * A view over `accounts`, not a second copy — assigning to it does nothing.
   * Kept so the many call sites that only ever wanted "the address" keep
   * reading, while `accounts` stays the one place a value lives.
   */
  readonly address?: string;
  /** The active account's private key. Same contract as `address`. */
  readonly privateKey?: string;
}

/**
 * Attach the derived `address` and `privateKey` views to a record.
 *
 * Defined as getters so they cannot drift from `accounts`, and marked
 * non-enumerable so serializing the record stores the account list rather than
 * a snapshot that could later disagree with it.
 */
function withActiveViews(data: WalletData): WalletData {
  const active = () =>
    data.accounts.find((a) => a.namespace === data.activeNamespace);
  Object.defineProperties(data, {
    address: {
      get: () => active()?.address,
      enumerable: false,
      configurable: true,
    },
    privateKey: {
      get: () => active()?.privateKey,
      enumerable: false,
      configurable: true,
    },
  });
  return data;
}

/** The version 1 shape, kept so migration has something to name. */
export interface WalletDataV1 {
  mnemonic: string;
  privateKey: string;
  address: string;
  createdAt: number;
  chainId?: string;
}

/**
 * Bring a stored record up to the current shape.
 *
 * Version 1 held one EVM key, because that was the only thing this wallet
 * could produce. The migration wraps it in an account list and changes nothing
 * else — in particular it does not derive a Solana account here, even when a
 * mnemonic is present. Deriving takes async work and this must stay a pure,
 * total function: a migration that can fail partway is a migration that can
 * lose a wallet.
 */
export function migrateWalletData(raw: unknown): WalletData | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<WalletData> & Partial<WalletDataV1>;

  if (record.version === 2 && Array.isArray(record.accounts)) {
    return record as WalletData;
  }

  if (
    typeof record.privateKey !== "string" ||
    typeof record.address !== "string"
  ) {
    return null;
  }

  return {
    mnemonic: typeof record.mnemonic === "string" ? record.mnemonic : "",
    accounts: [
      {
        namespace: "eip155",
        privateKey: record.privateKey,
        address: record.address,
        derivationPath: DEFAULTS.derivationPath,
      },
    ],
    activeNamespace: "eip155",
    createdAt:
      typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    ...(record.chainId ? { chainId: record.chainId } : {}),
    version: 2,
  };
}

export interface WalletState {
  address: string | null;
  chainId: string;
  hasWallet: boolean;
  isConnected: boolean;
}

const DEFAULTS: Required<
  Pick<PocketConfig, "storageKey" | "derivationPath" | "autoSave" | "chainId">
> = {
  storageKey: "naculus_pocket",
  derivationPath: "m/44'/60'/0'/0/0",
  autoSave: true,
  chainId: "eip155:1",
};

/**
 * Every account a seed produces.
 *
 * A phrase deterministically yields an account on each namespace, so both are
 * built. Enabling only one would hide funds the user already owns: they could
 * receive on their Solana address from anywhere and this wallet would show
 * nothing, while the same phrase in Phantom shows the balance.
 */
/**
 * A record safe to hand to storage.
 *
 * `{ ...data }` is shallow, so the copy shares the `accounts` array. A secure
 * wipe overwrites each account's key in place, which through a shared
 * reference reaches whatever the storage adapter kept — measured: after
 * `destroySession()` the persisted key had been replaced with the wipe
 * pattern, so the next `load()` found a wallet it could not open. The accounts
 * are copied one level deeper so the two can never be the same objects.
 *
 * The derived `address` and `privateKey` views are left out deliberately: they
 * are a view over `accounts`, and persisting a snapshot of them would create a
 * second copy that can disagree with the list it came from.
 */
function toStorableRecord(data: WalletData): WalletData {
  return {
    mnemonic: data.mnemonic,
    accounts: data.accounts.map((account) => ({ ...account })),
    activeNamespace: data.activeNamespace,
    createdAt: data.createdAt,
    ...(data.chainId ? { chainId: data.chainId } : {}),
    version: 2,
  };
}

async function accountsFromSeed(
  seed: Uint8Array,
  evmPath: string,
): Promise<WalletAccount[]> {
  const { privateKey, address } = await deriveWallet(seed, evmPath);
  const { deriveSolanaKeypair, SOLANA_DERIVATION_PATH } = await import(
    "./derivation/solana"
  );
  const { bytesToHex } = await import("@noble/hashes/utils");
  const solana = deriveSolanaKeypair(seed);

  return [
    {
      namespace: "eip155",
      privateKey,
      address,
      derivationPath: evmPath,
    },
    {
      namespace: "solana",
      privateKey: `0x${bytesToHex(solana.secretKey)}`,
      address: solana.address,
      derivationPath: SOLANA_DERIVATION_PATH,
    },
  ];
}

async function deriveWallet(
  seed: Uint8Array,
  path: string,
): Promise<{ privateKey: `0x${string}`; address: `0x${string}` }> {
  const [{ HDKey }, { secp256k1 }, { keccak_256 }, { bytesToHex }] =
    await Promise.all([
      import("@scure/bip32"),
      import("@noble/curves/secp256k1"),
      import("@noble/hashes/sha3"),
      import("@noble/hashes/utils"),
    ]);

  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  if (!child.privateKey)
    throw new WalletError(
      "derivation_failed",
      "Failed to derive private key from seed",
    );

  const pub = secp256k1.getPublicKey(child.privateKey, false);
  const hash = keccak_256(pub.slice(1));
  const addr = `0x${bytesToHex(hash.slice(-20))}` as `0x${string}`;
  const pk = `0x${bytesToHex(child.privateKey)}` as `0x${string}`;
  return { privateKey: pk, address: addr };
}

/**
 * Pocket Wallet — the core wallet class.
 *
 * Usage:
 * ```ts
 * const wallet = new PocketWallet({ rpcUrl: "https://..." });
 * await wallet.generate();            // create new wallet
 * await wallet.importMnemonic("..."); // recover from seed phrase
 * await wallet.signMessage("hello");  // sign a message
 * ```
 */
export class PocketWallet {
  private cfg: PocketConfig & {
    storageKey: string;
    derivationPath: string;
    autoSave: boolean;
    chainId: string;
  };
  private data: WalletData | null = null;
  private _signer: Signer;
  private _ed25519Signer?: Ed25519Signer;
  private _storage: StorageAdapter;

  private _sessionMgr: SessionKeyManager | null = null;
  private _txMonitor: TxMonitor | null = null;
  private _simulateFn: PocketConfig["simulateFn"];
  private _simManager: SimulationManager | null = null;

  /** Set when storage degraded to localStorage (IndexedDB unavailable) */
  private _storageDegraded: boolean = false;

  constructor(config: PocketConfig = {}) {
    const configuredChainId = config.chainId ?? DEFAULTS.chainId;
    // PocketWallet signs EVM transactions; reject malformed/non-EVM CAIP-2
    // values instead of silently parsing a prefix or a partial number.
    sim.parseChainIdNumber(configuredChainId);
    this.cfg = {
      ...DEFAULTS,
      ...config,
      storageKey: config.storageKey ?? DEFAULTS.storageKey,
      derivationPath: config.derivationPath ?? DEFAULTS.derivationPath,
      autoSave: config.autoSave ?? DEFAULTS.autoSave,
      chainId: configuredChainId,
    };
    this._signer =
      config.signer ??
      (config.isolation === "worker" ? new IsolatedSigner() : new EVMSigner());
    this._storage = config.storage ?? this.resolveStorage(config);
    this._simulateFn = config.simulateFn;

    // Initialize built-in SimulationManager if rpcUrl is available
    const simConfig = config.simulation ?? {};
    const simRpcUrl = simConfig.rpcUrl ?? config.rpcUrl;
    if (simRpcUrl || this._simulateFn) {
      this._simManager = new SimulationManager({
        ...simConfig,
        rpcUrl: simRpcUrl,
        autoSimulate: simConfig.autoSimulate ?? config.autoSimulate ?? false,
      });
    }
  }

  /**
   * Resolve storage adapter based on config and environment capability.
   *
   * Priority chain:
   *   1. Custom adapter (config.storage) → use directly
   *   2. Explicit storageType → force specific backend
   *   3. Auto-detect:
   *      a. IndexedDB (available) → default, origin-scoped but not encrypted
   *      b. localStorage + encrypted (if passphrase provided) → XSS-resistant
   *      c. localStorage → last resort, set _storageDegraded = true
   *
   * AES-GCM encryption is applied when config.encryptionPassphrase is provided.
   * The passphrase callback is called once at wallet creation.
   */
  private resolveStorage(config: PocketConfig): StorageAdapter {
    if (config.storage) return config.storage;

    const explicitType = config.storageType;
    const passphrase = config.encryptionPassphrase;
    const allowInsecureStorage =
      config.allowInsecureStorage ?? typeof window === "undefined";

    if (explicitType === "indexedDb") {
      return this.wrapWithEncryption(
        new IndexedDbStorageAdapter(this.cfg.storageKey),
        passphrase,
        true,
      );
    }

    if (explicitType === "localStorage") {
      if (!passphrase && !allowInsecureStorage) {
        throw new WalletError(
          "storage_unavailable",
          "Unencrypted localStorage is disabled. Provide encryptionPassphrase or explicitly set allowInsecureStorage: true.",
        );
      }
      this._storageDegraded = true;
      return this.wrapWithEncryption(
        new LocalStorageAdapter(this.cfg.storageKey),
        passphrase,
        false,
      );
    }

    // Auto-detect chain: IndexedDB → localStorage (encrypted if configured)
    const idbAdapter = new IndexedDbStorageAdapter(this.cfg.storageKey);
    if (idbAdapter.isAvailable()) {
      return this.wrapWithEncryption(idbAdapter, passphrase, true);
    }

    // IndexedDB unavailable — fall back to localStorage
    if (!passphrase && !allowInsecureStorage) {
      throw new WalletError(
        "storage_unavailable",
        "IndexedDB is unavailable and unencrypted localStorage fallback is disabled. Provide encryptionPassphrase or explicitly set allowInsecureStorage: true.",
      );
    }
    this._storageDegraded = true;
    const lsAdapter = new LocalStorageAdapter(this.cfg.storageKey);
    // Wrap with encryption if passphrase provided (mitigates XSS risk)
    if (passphrase) {
      return new EncryptedStorageAdapter(lsAdapter, passphrase, {
        prf: this.cfg.prfUnlock,
      });
    }
    return lsAdapter;
  }

  /**
   * Wrap adapter with AES-256-GCM encryption if passphrase is provided.
   * If required=true and no passphrase, throws.
   */
  private wrapWithEncryption(
    adapter: StorageAdapter,
    passphrase: (() => Promise<string>) | undefined,
    required: boolean,
  ): StorageAdapter {
    if (passphrase) {
      return new EncryptedStorageAdapter(adapter, passphrase, {
        prf: this.cfg.prfUnlock,
      });
    }
    if (required) return adapter; // Origin-scoped backend, still not XSS-proof
    return adapter;
  }

  /**
   * Returns the current storage type for UI warnings.
   *
   * connect-react can call this to determine if a security warning
   * should be shown to the user.
   */
  /**
   * The account that signs when no namespace is named.
   *
   * Throws rather than returning null: every caller below is on a signing or
   * transaction path where continuing without a key would mean sending
   * something built from undefined.
   */
  private activeAccount(): WalletAccount {
    if (!this.data) {
      throw new WalletError(
        "no_wallet",
        "No wallet loaded. Generate, import, or load a wallet first.",
      );
    }
    const active = this.data.accounts.find(
      (a) => a.namespace === this.data?.activeNamespace,
    );
    if (!active) {
      throw new WalletError(
        "no_wallet",
        `This wallet holds no ${this.data.activeNamespace} account.`,
      );
    }
    return active;
  }

  /** The account for a namespace, or null when this wallet holds none. */
  account(namespace: WalletNamespace): WalletAccount | null {
    return this.data?.accounts.find((a) => a.namespace === namespace) ?? null;
  }

  /** Every account this wallet holds. */
  accounts(): WalletAccount[] {
    return this.data ? [...this.data.accounts] : [];
  }

  /**
   * Choose which account signs by default.
   *
   * Refuses a namespace this wallet has no account for, rather than leaving
   * the wallet pointing at nothing.
   */
  setActiveNamespace(namespace: WalletNamespace): void {
    if (!this.data) {
      throw new WalletError("no_wallet", "No wallet loaded.");
    }
    if (!this.data.accounts.some((a) => a.namespace === namespace)) {
      throw new WalletError(
        "no_wallet",
        `This wallet holds no ${namespace} account.`,
      );
    }
    this.data.activeNamespace = namespace;
  }

  getStorageType(): StorageType {
    return this._storage.type;
  }

  /**
   * Single source of truth for storage security tier. Use this in connect-react
   * instead of checking multiple boolean flags.
   *
   *   1 = IndexedDB + AES-GCM  (🔒 highest)
   *   2 = IndexedDB             (✅ default)
   *   3 = localStorage + AES-GCM(⚠️  encrypted but weak backend)
   *   4 = localStorage          (🚫 XSS-vulnerable, warn user to switch browser)
   */
  getStorageSecurityLevel(): StorageSecurityLevel {
    const encrypted = this._storage.type === "encrypted";
    const isIndexedDB =
      this._storage.type === "indexedDb" ||
      (encrypted && !this._storageDegraded);
    const isCustom =
      this._storage.type === "custom" || this._storage.type === "memory";

    if (encrypted && !this._storageDegraded) return 1;
    if (isIndexedDB || isCustom) return 2;
    if (encrypted) return 3;
    return 4;
  }

  /**
   * The same tier, plus the findings behind it.
   *
   * A number from 1 to 4 tells a user where they stand and nothing about why.
   * This is what a security panel renders: the score, and the specific
   * sentences explaining the points it is missing.
   */
  getStorageSecurityReport(): StorageSecurityReport {
    const level = this.getStorageSecurityLevel();
    const encrypted = this._storage.type === "encrypted";
    // Duck-typed so a custom adapter that reports its own unlock state is
    // read rather than assumed to have none.
    const readUnlock = (
      this._storage as StorageAdapter & {
        getUnlockState?: () => UnlockState;
      }
    ).getUnlockState;
    const unlock: UnlockState =
      typeof readUnlock === "function"
        ? readUnlock.call(this._storage)
        : { prf: "none", sealedWith: null };

    // `type` reports the wrapper, so an encrypted record over IndexedDB
    // reads as "encrypted" and would name the encryption as its own backend.
    // Report the store underneath instead, which is what the finding is about.
    const backend: StorageType = this._storageDegraded
      ? "localStorage"
      : encrypted
        ? "indexedDb"
        : this._storage.type;

    return assessStorageSecurity({ level, backend, encrypted, unlock });
  }

  /** @deprecated Use getStorageSecurityLevel() instead */
  isSecureStorage(): boolean {
    const level = this.getStorageSecurityLevel();
    return level <= 3;
  }

  /** @deprecated Use getStorageSecurityLevel() instead */
  isEncrypted(): boolean {
    return (
      this.getStorageSecurityLevel() === 1 ||
      this.getStorageSecurityLevel() === 3
    );
  }

  /** @deprecated Use getStorageSecurityLevel() instead */
  isStorageDegraded(): boolean {
    return this._storageDegraded;
  }

  // ── Wallet Lifecycle ────────────────────────────────────────────

  /** Helper: initialize signer with wallet's private key */
  /**
   * The signer for the active namespace.
   *
   * Routed rather than fixed at construction. The EVM signer applies EIP-191
   * and produces a recoverable secp256k1 signature; Solana signs raw bytes on
   * ed25519 with nothing to recover. Using one for the other does not fail
   * loudly — it produces a well-formed signature that verifies against
   * nothing, which is the worst kind of wrong for a signing path.
   *
   * A caller-supplied `config.signer` still wins, so an integration that
   * brings its own is not silently overridden.
   */
  private signerFor(namespace: WalletNamespace): Signer {
    if (this.cfg.signer) return this.cfg.signer;
    if (namespace === "solana") {
      if (!this._ed25519Signer) {
        this._ed25519Signer = new Ed25519Signer();
      }
      return this._ed25519Signer;
    }
    return this._signer;
  }

  /** The signer for whichever namespace is active. */
  private activeSigner(): Signer {
    return this.signerFor(this.data?.activeNamespace ?? "eip155");
  }

  private async initSignerWithKey(privateKey: string): Promise<void> {
    if (this._signer instanceof IsolatedSigner) {
      await this._signer.initWithKey(privateKey);
    }
  }

  /** Generate a new random wallet (BIP39 mnemonic) */
  async generate(): Promise<WalletData> {
    const bip39 = await import("@scure/bip39");
    const wl = await import("@scure/bip39/wordlists/english");

    const mnemonic = bip39.generateMnemonic(wl.wordlist, 128);
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const accounts = await accountsFromSeed(seed, this.cfg.derivationPath);

    this.data = withActiveViews({
      mnemonic,
      accounts,
      activeNamespace: "eip155",
      createdAt: Date.now(),
      chainId: this.cfg.chainId,
      version: 2,
    });
    await this.initSignerWithKey(this.activeAccount().privateKey);
    if (this.cfg.autoSave)
      await this._storage.save(toStorableRecord(this.data));
    return this.data;
  }

  /** Recover wallet from a BIP39 mnemonic phrase */
  async importMnemonic(mnemonic: string): Promise<WalletData> {
    const bip39 = await import("@scure/bip39");
    const wl = await import("@scure/bip39/wordlists/english");

    if (!bip39.validateMnemonic(mnemonic, wl.wordlist)) {
      throw new WalletError(
        "invalid_mnemonic",
        "Invalid mnemonic phrase. Please check your recovery words.",
      );
    }

    const seed = await bip39.mnemonicToSeed(mnemonic);
    const accounts = await accountsFromSeed(seed, this.cfg.derivationPath);

    this.data = withActiveViews({
      mnemonic,
      accounts,
      activeNamespace: "eip155",
      createdAt: Date.now(),
      chainId: this.cfg.chainId,
      version: 2,
    });
    await this.initSignerWithKey(this.activeAccount().privateKey);
    if (this.cfg.autoSave)
      await this._storage.save(toStorableRecord(this.data));
    return this.data;
  }

  /**
   * Import a wallet from a raw private key, in whatever form the user has.
   *
   * Accepts what MetaMask, Phantom and `solana-keygen` export — `0x` hex,
   * base58, or a 64-byte JSON array — and works out which chain the key
   * belongs to rather than asking. For the Solana forms that is a proof: the
   * trailing 32 bytes must be the ed25519 public key of the leading 32.
   *
   * Only the detected namespace is enabled. A raw key is on exactly one curve,
   * so an account for the other would be an address the key cannot control and
   * the user cannot recover, with nothing to say why it stays empty.
   */
  async importPrivateKey(pkHex: string): Promise<WalletData> {
    const { detectPrivateKey } = await import("./derivation/key-formats");
    const detected = detectPrivateKey(pkHex);

    if (detected.namespace === "solana") {
      const { bytesToHex } = await import("@noble/hashes/utils");
      const { ed25519 } = await import("@noble/curves/ed25519");
      const { base58 } = await import("@scure/base");

      const address = base58.encode(ed25519.getPublicKey(detected.secret));
      this.data = withActiveViews({
        mnemonic: "",
        accounts: [
          {
            namespace: "solana",
            privateKey: `0x${bytesToHex(detected.secret)}`,
            address,
            // No derivationPath: a raw key came from nowhere derivable, so it
            // cannot be recovered from a phrase.
          },
        ],
        activeNamespace: "solana",
        createdAt: Date.now(),
        chainId: this.cfg.chainId,
        version: 2,
      });
      if (this.cfg.autoSave)
        await this._storage.save(toStorableRecord(this.data));
      return this.data;
    }

    const { keccak_256 } = await import("@noble/hashes/sha3");
    const { bytesToHex } = await import("@noble/hashes/utils");
    const priv = detected.secret;
    pkHex = `0x${bytesToHex(priv)}`;

    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const pub = secp256k1.getPublicKey(priv, false);
    const hash = keccak_256(pub.slice(1));
    const addr = `0x${bytesToHex(hash.slice(-20))}` as `0x${string}`;

    // Only the namespace this key belongs to. A raw key is on exactly one
    // curve, so showing a Solana account here would show an address the key
    // cannot control and the user cannot recover — worse than showing nothing,
    // because there is no way to tell why it stays empty.
    this.data = withActiveViews({
      mnemonic: "",
      accounts: [
        {
          namespace: "eip155",
          privateKey: pkHex,
          address: addr,
          // No derivationPath: this key came from nowhere derivable, so it
          // cannot be recovered from a phrase.
        },
      ],
      activeNamespace: "eip155",
      createdAt: Date.now(),
      chainId: this.cfg.chainId,
      version: 2,
    });
    await this.initSignerWithKey(pkHex);
    if (this.cfg.autoSave)
      await this._storage.save(toStorableRecord(this.data));
    return this.data;
  }

  /**
   * Load wallet from persistent storage.
   *
   * A version 1 record is migrated in memory. Nothing is written back here:
   * turning a successful read into a write gives it a way to fail, and the one
   * thing this method must never do is leave a user without a wallet. The
   * migrated shape is persisted on the next explicit save.
   */
  async load(): Promise<boolean> {
    const raw = await this._storage.load();
    if (!raw) return false;

    const data = migrateWalletData(raw);
    if (!data || data.accounts.length === 0) {
      throw new WalletError("invalid_key", "Stored wallet data is malformed.");
    }

    const evm = data.accounts.find((a) => a.namespace === "eip155");
    if (evm) {
      // The integrity check that has always been here: an address that does
      // not match its key means the record was corrupted or tampered with,
      // and signing with it would produce transactions from an account the
      // user does not control.
      if (
        !/^0x[0-9a-fA-F]{64}$/.test(evm.privateKey) ||
        !/^0x[0-9a-fA-F]{40}$/.test(evm.address)
      ) {
        throw new WalletError(
          "invalid_key",
          "Stored wallet data is malformed.",
        );
      }
      const { secp256k1 } = await import("@noble/curves/secp256k1");
      const { keccak_256 } = await import("@noble/hashes/sha3");
      const { hexToBytes, bytesToHex } = await import("@noble/hashes/utils");
      const privateKeyBytes = hexToBytes(evm.privateKey.slice(2));
      if (!secp256k1.utils.isValidPrivateKey(privateKeyBytes)) {
        throw new WalletError("invalid_key", "Stored private key is invalid.");
      }
      const publicKey = secp256k1.getPublicKey(privateKeyBytes, false);
      const expectedAddress = `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
      if (expectedAddress.toLowerCase() !== evm.address.toLowerCase()) {
        throw new WalletError(
          "invalid_key",
          "Stored wallet address does not match its private key.",
        );
      }
    }

    this.data = withActiveViews(data);
    await this.initSignerWithKey(this.activeAccount().privateKey);
    return true;
  }

  /**
   * Derive the accounts this wallet's phrase produces but the record does not
   * yet hold.
   *
   * Separate from `load` on purpose. A migrated version 1 wallet has a
   * mnemonic and therefore already owns a Solana account — anyone importing
   * that phrase into Phantom would see it — so hiding it would mean the
   * balance is visible everywhere except here. Deriving needs async work,
   * though, and `load` has to stay total: a read that can fail partway is a
   * read that can lose a wallet.
   *
   * Returns the accounts that were added. Safe to call repeatedly.
   */
  async backfillAccounts(): Promise<WalletAccount[]> {
    if (!this.data) {
      throw new WalletError("no_wallet", "No wallet loaded.");
    }
    if (!this.data.mnemonic) {
      // Imported from a raw key. There is nothing to derive from, and that is
      // permanent rather than a temporary gap.
      return [];
    }

    const bip39 = await import("@scure/bip39");
    const seed = await bip39.mnemonicToSeed(this.data.mnemonic);
    const derived = await accountsFromSeed(seed, this.cfg.derivationPath);

    const added: WalletAccount[] = [];
    for (const account of derived) {
      if (this.data.accounts.some((a) => a.namespace === account.namespace)) {
        continue;
      }
      this.data.accounts.push(account);
      added.push(account);
    }
    return added;
  }

  /** Save current wallet to persistent storage */
  async save(): Promise<void> {
    if (!this.data)
      throw new WalletError("no_wallet", "No wallet data to save");
    await this._storage.save(toStorableRecord(this.data));
  }

  /** Clear wallet from memory and storage */
  async clear(): Promise<void> {
    this.data = null;
    await this._storage.clear();
    if (typeof (this._signer as any).clear === "function") {
      await (this._signer as any).clear();
    }
  }

  /**
   * Generate crypto-random hex string of given byte length.
   * Used for secure data wiping — overwrites sensitive strings
   * with unpredictable bytes before discarding.
   */
  private randomHex(len: number): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }

  /** Overwrite sensitive data then clear (for secure wipe) */
  async wipe(): Promise<void> {
    if (this.data) {
      // Every account, not just the active one. Overwriting a single key
      // would leave the others in memory for the garbage collector to release
      // whenever it feels like it, which is the opposite of a secure wipe.
      this.data.mnemonic = this.randomHex(256);
      for (const account of this.data.accounts) {
        account.privateKey = this.randomHex(128);
      }
    }
    this.data = null;
    await this._storage.clear();
  }

  /**
   * Destroy the in-memory session, zero-filling sensitive data.
   * Does NOT clear persistent storage (allows reload).
   * Safe to call multiple times or on uninitialized wallet.
   */
  destroySession(): void {
    if (this.data) {
      // Every account, not just the active one. Overwriting a single key
      // would leave the others in memory for the garbage collector to release
      // whenever it feels like it, which is the opposite of a secure wipe.
      this.data.mnemonic = this.randomHex(256);
      for (const account of this.data.accounts) {
        account.privateKey = this.randomHex(128);
      }
    }
    this.data = null;
  }

  // ── Signing ─────────────────────────────────────────────────────

  /** Sign a personal message (Ethereum personal_sign style) */
  /**
   * Sign a 32-byte digest as an EIP-191 message.
   *
   * The primitive an ERC-4337 SimpleAccount needs to accept this wallet as its
   * owner. `signMessage` cannot stand in: it prefixes the text it is given, so
   * a userOpHash passed as "0x…" is signed as 66 characters rather than the 32
   * bytes the account will hash.
   */
  async signHash(hash: `0x${string}`): Promise<SignResult> {
    if (!this.data)
      throw new WalletError(
        "no_wallet",
        "No wallet loaded. Generate, import, or load a wallet first.",
      );
    if (!this.activeSigner().signHash) {
      throw new WalletError(
        "method_unsupported",
        `The ${this.activeSigner().chainType} signer cannot sign a raw digest.`,
      );
    }
    const signer = this.activeSigner();
    if (!signer.signHash) {
      throw new WalletError(
        "method_unsupported",
        `The ${signer.chainType} signer cannot sign a raw digest.`,
      );
    }
    return signer.signHash(
      hash,
      this.activeAccount().privateKey as `0x${string}`,
    );
  }

  async signMessage(message: string): Promise<SignResult> {
    if (!this.data)
      throw new WalletError(
        "no_wallet",
        "No wallet loaded. Generate, import, or load a wallet first.",
      );
    return this.activeSigner().signMessage(
      { message, chainId: this.cfg.chainId },
      this.activeAccount().privateKey as `0x${string}`,
    );
  }

  /**
   * Sign EIP-712 typed structured data (eth_signTypedData_v4).
   * Accepts JSON-stringified typed data.
   */
  async signTypedData(typedData: string): Promise<SignResult> {
    if (!this.data) throw new WalletError("no_wallet", "No wallet loaded.");
    const typedSigner = this.activeSigner();
    if (!typedSigner.signTypedData)
      throw new WalletError(
        "method_not_allowed",
        "signTypedData not supported by current signer",
      );
    return typedSigner.signTypedData(
      typedData,
      this.activeAccount().privateKey as `0x${string}`,
    );
  }

  /** Sign and encode a transaction (Ethereum RLP-signed) */
  async signTransaction(tx: TransactionRequest): Promise<SignResult> {
    if (!this.data)
      throw new WalletError(
        "no_wallet",
        "No wallet loaded. Generate, import, or load a wallet first.",
      );
    // Keep the direct signing API on the configured EIP-155 chain as well as
    // sendTransaction().  EVMSigner cannot safely infer a chain from a
    // transaction, so never let an omitted chain silently become mainnet.
    const chainId = this.assertConfiguredChain(tx);
    return this.activeSigner().signTransaction(
      { ...tx, chainId },
      this.activeAccount().privateKey as `0x${string}`,
    );
  }

  // ── Export ──────────────────────────────────────────────────────

  /**
   * The private key for a namespace, in the form that namespace's wallets
   * accept.
   *
   * This is the exit. A self-custodial wallet that cannot hand the user their
   * key in a form another wallet reads is custodial in every way that matters,
   * whatever the architecture diagram says.
   *
   * The stored form is hex for both namespaces, which MetaMask reads and
   * Phantom does not. Leaving a caller to work that out — read the account,
   * know the encoding, hex-decode it, find the base58 helper — is the same as
   * not offering the export at all.
   *
   * - `eip155` → `0x`-prefixed hex, what MetaMask's "Import Account" takes
   * - `solana` → base58 of the 64-byte secret‖public, what Phantom takes
   *
   * The recovery phrase remains the better backup: it carries every account,
   * and a raw key carries one.
   */
  exportPrivateKey(namespace?: WalletNamespace): string {
    const target = namespace ?? this.data?.activeNamespace;
    if (!this.data || !target) {
      throw new WalletError("no_wallet", "No wallet loaded.");
    }
    const account = this.data.accounts.find((a) => a.namespace === target);
    if (!account) {
      throw new WalletError(
        "no_wallet",
        `This wallet holds no ${target} account.`,
      );
    }
    if (target === "solana") {
      return toSolanaPrivateKeyBase58(solanaSecretSeed(account.privateKey));
    }
    return account.privateKey;
  }

  /**
   * The Solana key as the JSON byte array `solana-keygen` writes.
   *
   * The form the Solana CLI and most tooling read from a file, which base58
   * is not.
   */
  exportSolanaKeypairJson(): string {
    const account = this.data?.accounts.find((a) => a.namespace === "solana");
    if (!account) {
      throw new WalletError(
        "no_wallet",
        "This wallet holds no solana account.",
      );
    }
    return toSolanaKeypairJson(solanaSecretSeed(account.privateKey));
  }

  // ── Solana ──────────────────────────────────────────────────────

  /**
   * Add this wallet's signature to a serialized Solana transaction.
   *
   * The caller builds and serializes the transaction — with `@solana/kit`,
   * `@solana/web3.js`, or whatever produced it — exactly as they would for
   * Phantom. What this does is the part only the key holder can: sign the
   * message and put the signature in the slot that belongs to this account.
   *
   * Accepts base64 (what an RPC and most APIs hand you) or raw bytes, and
   * returns raw bytes.
   */
  async signSolanaTransaction(
    transaction: Uint8Array | string,
  ): Promise<Uint8Array> {
    const account = this.data?.accounts.find((a) => a.namespace === "solana");
    if (!account) {
      throw new WalletError(
        "no_wallet",
        "This wallet holds no solana account.",
      );
    }
    const seed = solanaSecretSeed(account.privateKey);
    const publicKey = ed25519.getPublicKey(seed);
    return signSolanaTransaction(toWireBytes(transaction), seed, publicKey);
  }

  /**
   * Sign and broadcast a Solana transaction.
   *
   * Refuses a transaction still missing a co-signer rather than submitting it.
   * The cluster's rejection for that case does not say which signature was
   * missing, so the round trip costs a confusing error instead of a clear one.
   *
   * Returns the transaction signature, base58, as the cluster reports it.
   */
  async sendSolanaTransaction(
    transaction: Uint8Array | string,
  ): Promise<string> {
    if (!this.cfg.solanaRpcUrl) {
      throw new WalletError(
        "no_rpc",
        "Solana RPC URL not configured. Set solanaRpcUrl in config.",
      );
    }
    const signed = await this.signSolanaTransaction(transaction);
    if (!isFullySigned(signed)) {
      throw new WalletError(
        "invalid_input",
        "This transaction still needs another signature before it can be sent.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(this.cfg.solanaRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          params: [toBase64(signed), { encoding: "base64" }],
        }),
        signal: controller.signal,
      });
      const json = await res.json();
      if (json.error) {
        throw new WalletError(
          "rpc_error",
          `Solana RPC error: ${json.error.message}`,
        );
      }
      if (typeof json.result !== "string") {
        throw new WalletError(
          "rpc_error",
          "Solana RPC returned no transaction signature",
        );
      }
      return json.result;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new WalletError(
          "rpc_timeout",
          "Solana sendTransaction timed out after 15000ms",
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── RPC Methods ─────────────────────────────────────────────────

  private async rpcCall(
    method: string,
    params: unknown[] = [],
    timeoutMs = 10_000,
  ): Promise<unknown> {
    if (!this.cfg.rpcUrl)
      throw new WalletError(
        "no_rpc",
        "RPC URL not configured. Set rpcUrl in config.",
      );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(this.cfg.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      const json = await res.json();
      if (json.error)
        throw new WalletError("rpc_error", `RPC error: ${json.error.message}`);
      return json.result;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new WalletError(
          "rpc_timeout",
          `RPC call "${method}" timed out after ${timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Send a transaction with optional fee estimation override.
   *
   * Supports:
   * - EIP-1559 (type 2) with auto fee estimation
   * - Legacy (type 0) with auto fee estimation
   * - User-specified fee override (via tx fields or feeOptions)
   *
   * @param tx - Transaction request
   * @param feeOptions - Optional fee estimation configuration
   * @returns Transaction result with fee info
   */
  async sendTransaction(
    tx: TransactionRequest,
    feeOptions?: FeeOptions,
  ): Promise<TransactionResult> {
    if (!this.data) throw new WalletError("no_wallet", "No wallet loaded.");
    if (!tx.to)
      throw new WalletError(
        "invalid_input",
        "Missing 'to' address for transaction.",
      );

    const configuredChainId = this.assertConfiguredChain(tx);

    // Get nonce if not provided
    if (!tx.nonce) {
      const nonceHex = (await this.rpcCall("eth_getTransactionCount", [
        this.activeAccount().address,
        "pending",
      ])) as string;
      tx.nonce = nonceHex;
    }

    // Estimate gas if not provided
    if (!tx.gas) {
      const estimated = (await this.rpcCall("eth_estimateGas", [
        {
          from: this.activeAccount().address,
          to: tx.to,
          value: tx.value ?? "0x0",
          data: tx.data ?? "0x",
        },
      ])) as string;
      tx.gas = estimated;
    }

    // Auto-simulate before sending (opt-in via autoSimulate config)
    if (this._simManager?.autoSimulate) {
      const simResult = await this._simManager.simulateTransaction(
        { to: tx.to, data: tx.data, value: tx.value, gas: tx.gas },
        this.activeAccount().address as `0x${string}`,
        {
          chainId: sim.parseChainIdNumber(this.cfg.chainId),
          rpcUrl: this.cfg.rpcUrl,
        },
      );

      if (simResult.status === "reverted") {
        throw new WalletError(
          "simulation_reverted",
          simResult.revertReason
            ? `Transaction would revert: ${simResult.revertReason}`
            : "Transaction would revert when simulated",
        );
      }

      if (simResult.riskAssessment.level === "malicious") {
        throw new WalletError(
          "simulation_malicious",
          "Simulation detected a malicious transaction. If you trust this dApp, disable auto-simulation.",
        );
      }
    }

    // Resolve fee options (EIP-1559 or Legacy)
    const resolvedFees = await resolveFeeOptions(
      tx,
      this.cfg.rpcUrl!,
      this.cfg.chainId,
      feeOptions,
    );

    // Validate resolved fees
    validateFeeParams(resolvedFees);

    // Build the final transaction with clean fee fields
    const builtTx = buildTransaction(tx, resolvedFees);

    // Set chain ID
    builtTx.chainId = configuredChainId;

    // Sign the transaction
    const { signature } = await this.activeSigner().signTransaction(
      builtTx,
      this.activeAccount().privateKey as `0x${string}`,
    );

    // Broadcast
    const txHash = (await this.rpcCall("eth_sendRawTransaction", [
      signature,
    ])) as string;

    if (!txHash)
      throw new WalletError("tx_failed", "Failed to broadcast transaction.");

    // Auto-register with TxMonitor if available
    if (this._txMonitor) {
      const parsedChainId = sim.parseChainIdNumber(this.cfg.chainId);
      this._txMonitor
        .watchTx(txHash, parsedChainId, {
          initialEntry: {
            from: this.activeAccount().address,
            to: tx.to,
            value: tx.value ?? "0x0",
            data: tx.data,
            nonce: tx.nonce ? parseInt(tx.nonce, 16) : undefined,
            gasUsed: builtTx.gas,
            effectiveGasPrice: builtTx.gasPrice ?? builtTx.maxFeePerGas,
          },
        })
        .catch(() => {
          /* non-critical: monitor best-effort */
        });
    }

    return {
      hash: txHash,
      from: this.activeAccount().address,
      to: tx.to,
      value: tx.value ?? "0x0",
      data: tx.data ?? "0x",
      chainId: this.cfg.chainId,
      ...(resolvedFees.type === "eip1559"
        ? {
            maxFeePerGas: resolvedFees.maxFeePerGas,
            maxPriorityFeePerGas: resolvedFees.maxPriorityFeePerGas,
          }
        : { gasPrice: resolvedFees.gasPrice }),
    };
  }

  /** Ensure a transaction cannot be signed for a chain different from the wallet context. */
  private assertConfiguredChain(tx: TransactionRequest): number {
    const chainId = resolveChainId(tx, this.cfg.chainId);
    const configuredChainId = sim.parseChainIdNumber(this.cfg.chainId);
    if (chainId !== configuredChainId) {
      throw new WalletError(
        "chain_mismatch",
        `Transaction chain ID ${chainId} does not match configured chain ${this.cfg.chainId}.`,
      );
    }
    return configuredChainId;
  }

  /**
   * Estimate current chain fees (query only, no transaction).
   *
   * @param feeOptions - Optional estimation config
   * @returns Estimated fee values
   */
  async estimateFee(
    feeOptions?: Partial<FeeOptions>,
  ): Promise<EstimatedFeeResult> {
    if (!this.cfg.rpcUrl) {
      throw new WalletError(
        "no_rpc",
        "RPC URL not configured. Set rpcUrl in config.",
      );
    }
    return oracleEstimateFee(this.cfg.rpcUrl, this.cfg.chainId, feeOptions);
  }

  /**
   * Bump the fee on a previously sent (stuck) transaction.
   * Creates a replacement with the same nonce but higher fee.
   *
   * @param originalTx - The original transaction request
   * @param options - Fee bump strategy (default: percentage +10%)
   * @returns Transaction result for the bumped transaction
   */
  async bumpFee(
    originalTx: TransactionRequest,
    options: FeeBumpOptions = { strategy: "percentage", multiplier: 1.1 },
  ): Promise<TransactionResult> {
    if (!this.data) throw new WalletError("no_wallet", "No wallet loaded.");

    // Clone the transaction without fee fields
    const bumpedTx = cloneForBumping(originalTx);

    switch (options.strategy) {
      case "percentage": {
        const multiplier = options.multiplier ?? 1.1;
        if (!Number.isFinite(multiplier) || multiplier <= 0) {
          throw new WalletError(
            "invalid_multiplier",
            "Fee bump multiplier must be greater than zero.",
          );
        }

        if (originalTx.maxFeePerGas) {
          bumpedTx.maxFeePerGas = applyMultiplier(
            originalTx.maxFeePerGas,
            multiplier,
          );
          bumpedTx.maxPriorityFeePerGas = originalTx.maxPriorityFeePerGas
            ? applyMultiplier(originalTx.maxPriorityFeePerGas, multiplier)
            : undefined;
          bumpedTx.type = "eip1559";
        } else if (originalTx.gasPrice) {
          bumpedTx.gasPrice = applyMultiplier(originalTx.gasPrice, multiplier);
        } else {
          // No fee info in original — re-estimate
          const fees = await resolveFeeOptions(
            bumpedTx,
            this.cfg.rpcUrl!,
            this.cfg.chainId,
          );
          validateFeeParams(fees);
          Object.assign(
            bumpedTx,
            fees.type === "eip1559"
              ? {
                  maxFeePerGas: fees.maxFeePerGas,
                  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                }
              : { gasPrice: fees.gasPrice },
          );
        }
        break;
      }

      case "absolute": {
        if (!options.absolute) {
          throw new WalletError(
            "invalid_fee",
            "Absolute fee bump requires fee values.",
          );
        }
        Object.assign(bumpedTx, options.absolute);
        break;
      }

      case "reestimate": {
        const fees = await resolveFeeOptions(
          bumpedTx,
          this.cfg.rpcUrl!,
          this.cfg.chainId,
        );
        validateFeeParams(fees);
        Object.assign(
          bumpedTx,
          fees.type === "eip1559"
            ? {
                maxFeePerGas: fees.maxFeePerGas,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
              }
            : { gasPrice: fees.gasPrice },
        );
        break;
      }
    }

    return this.sendTransaction(bumpedTx);
  }

  /** Get ETH balance for the current wallet address */
  async getBalance(): Promise<string> {
    if (!this.data) throw new WalletError("no_wallet", "No wallet loaded.");
    const balance = await this.rpcCall("eth_getBalance", [
      this.activeAccount().address,
      "latest",
    ]);
    // EIP-1474 quantities must be `0x0` or a non-zero hexadecimal value
    // without leading zeroes.  Do not let malformed provider output leak
    // through the public wallet API as if it were a valid wei balance.
    if (
      typeof balance !== "string" ||
      !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(balance)
    ) {
      throw new WalletError(
        "rpc_error",
        "RPC returned a non-canonical eth_getBalance quantity.",
      );
    }
    return balance;
  }

  // ── Getters ─────────────────────────────────────────────────────

  /** The active account's address. Use `account(namespace)` for a specific one. */
  get address(): string | null {
    if (!this.data) return null;
    return (
      this.data.accounts.find((a) => a.namespace === this.data?.activeNamespace)
        ?.address ?? null
    );
  }

  get mnemonic(): string | null {
    return this.data?.mnemonic ?? null;
  }

  get hasWallet(): boolean {
    return this.data !== null;
  }

  get state(): WalletState {
    return {
      address: this.address,
      chainId: this.cfg.chainId,
      hasWallet: this.data !== null,
      isConnected: this.data !== null,
    };
  }

  /** Switch the active chain */
  setChain(chainId: string): void {
    const normalized = chainId.startsWith("eip155:")
      ? chainId
      : `eip155:${chainId}`;
    sim.parseChainIdNumber(normalized);
    this.cfg.chainId = normalized;
    if (this.data) this.data.chainId = this.cfg.chainId;
  }

  /** Get the raw wallet data (for adapter/bridge use) */
  get data_(): WalletData | null {
    return this.data;
  }

  /**
   * Get the wallet data object.
   * Returns the raw WalletData or null if wallet is not initialized.
   */
  getWalletData(): WalletData | null {
    return this.data;
  }

  // ── TxMonitor Integration ───────────────────────────────────────

  /**
   * Initialize the TxMonitor. Must be called before using tx monitoring features.
   * Called automatically on first sendTransaction() if txMonitor config is available.
   */
  initTxMonitor(): void {
    if (this._txMonitor) return;

    if (!this.cfg.rpcUrl) {
      throw new WalletError(
        "no_rpc",
        "RPC URL required for TxMonitor initialization.",
      );
    }

    this._txMonitor = new TxMonitor({
      getProvider: (_chainId: number): ProviderLike => ({
        request: async ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) => {
          if (!this.cfg.rpcUrl)
            throw new WalletError("no_rpc", "RPC URL not configured.");
          const res = await fetch(this.cfg.rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          const json = await res.json();
          if (json.error)
            throw new WalletError(
              "rpc_error",
              `RPC error: ${json.error.message}`,
            );
          return json.result;
        },
      }),
      historyStore: undefined,
    });
    this._txMonitor.start();
  }

  /** Get the TxMonitor instance */
  get txMonitor(): TxMonitor | null {
    return this._txMonitor;
  }

  /**
   * Query current status of a transaction.
   */
  getTxStatus(hash: string): TxStatusEntry | null {
    return this._txMonitor?.getTxStatus(hash) ?? null;
  }

  /**
   * Query transaction history for the current address.
   */
  async getTxHistory(
    address?: string,
    chainId?: number,
  ): Promise<TxStatusEntry[]> {
    if (!this._txMonitor) return [];
    return this._txMonitor.getTxHistory(
      address ?? this.address ?? undefined,
      chainId ?? sim.parseChainIdNumber(this.cfg.chainId),
    );
  }

  /**
   * Manually watch a transaction (for externally-created txs).
   */
  async watchTx(
    hash: string,
    chainId?: number,
    options?: WatchTxOptions,
  ): Promise<TxStatusEntry> {
    if (!this._txMonitor) this.initTxMonitor();
    const safeChainId = chainId ?? sim.parseChainIdNumber(this.cfg.chainId);
    return this._txMonitor!.watchTx(hash, safeChainId, options);
  }

  // ── Transaction Simulation ──────────────────────────────────

  /**
   * Simulate a transaction before sending it.
   * Delegates to wallet-simulation module.
   */
  async simulateTransaction(
    tx: { to: string; data?: string; value?: string; gas?: string },
    options?: { chainId?: number; origin?: string; rpcUrl?: string },
  ): Promise<SimulationResult> {
    return sim.simulateTransaction(
      {
        address: this.address,
        simManager: this._simManager,
        customSimulate: this._simulateFn,
        rpcUrl: this.cfg.rpcUrl,
        chainId: this.cfg.chainId,
      },
      tx,
      options,
    );
  }

  /**
   * Simulate an ERC-20 token transfer.
   * Delegates to wallet-simulation module.
   */
  async simulateERC20Transfer(
    tokenAddress: `0x${string}`,
    to: `0x${string}`,
    amount: string,
    options?: { chainId?: number; rpcUrl?: string; decimals?: number },
  ): Promise<SimulationResult> {
    return sim.simulateERC20Transfer(
      {
        address: this.address,
        simManager: this._simManager,
        customSimulate: this._simulateFn,
        rpcUrl: this.cfg.rpcUrl,
        chainId: this.cfg.chainId,
      },
      tokenAddress,
      to,
      amount,
      options,
    );
  }

  // ── ERC-20 Token Methods ──────────────────────────────────────────

  /**
   * Send an ERC-20 token transfer.
   * Delegates to erc20-utils module.
   */
  async sendERC20Transfer(
    chainId: number,
    tokenAddress: `0x${string}`,
    to: `0x${string}`,
    amount: string,
  ): Promise<TransactionResult> {
    const prevChainId = this.cfg.chainId;
    this.setChain(`eip155:${chainId}`);
    try {
      return await erc20.sendERC20Transfer(
        {
          address: this.address,
          rpcUrl: this.cfg.rpcUrl,
          chainId: this.cfg.chainId,
          sendTransaction: (tx) => this.sendTransaction(tx),
        },
        chainId,
        tokenAddress,
        to,
        amount,
      );
    } finally {
      this.cfg.chainId = prevChainId;
    }
  }

  /**
   * Approve a spender to spend the user's ERC-20 tokens.
   * Delegates to erc20-utils module.
   */
  async sendERC20Approve(
    chainId: number,
    tokenAddress: `0x${string}`,
    spender: `0x${string}`,
    amount: string,
  ): Promise<TransactionResult> {
    const prevChainId = this.cfg.chainId;
    this.setChain(`eip155:${chainId}`);
    try {
      return await erc20.sendERC20Approve(
        {
          address: this.address,
          rpcUrl: this.cfg.rpcUrl,
          chainId: this.cfg.chainId,
          sendTransaction: (tx) => this.sendTransaction(tx),
        },
        chainId,
        tokenAddress,
        spender,
        amount,
      );
    } finally {
      this.cfg.chainId = prevChainId;
    }
  }

  /**
   * Check the ERC-20 allowance for a given owner + spender pair.
   */
  async getERC20Allowance(
    chainId: number,
    tokenAddress: `0x${string}`,
    owner: `0x${string}`,
    spender: `0x${string}`,
  ): Promise<bigint> {
    return erc20.getERC20Allowance(
      {
        address: this.address,
        rpcUrl: this.cfg.rpcUrl,
        chainId: this.cfg.chainId,
        sendTransaction: (tx) => this.sendTransaction(tx),
      },
      chainId,
      tokenAddress,
      owner,
      spender,
    );
  }

  /**
   * Fetch full ERC-20 token info (name, symbol, decimals, totalSupply).
   */
  async getERC20TokenInfo(
    chainId: number,
    tokenAddress: `0x${string}`,
  ): Promise<{
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: bigint;
  }> {
    return erc20.getERC20TokenInfo(
      {
        address: this.address,
        rpcUrl: this.cfg.rpcUrl,
        chainId: this.cfg.chainId,
        sendTransaction: (tx) => this.sendTransaction(tx),
      },
      chainId,
      tokenAddress,
    );
  }

  // ── Session Key Management ────────────────────────────────────

  /**
   * Get or lazily initialize the SessionKeyManager.
   * Requires an active wallet with mnemonic to derive the encryption seed.
   */
  private async _getSessionMgr(): Promise<SessionKeyManager> {
    if (this._sessionMgr) return this._sessionMgr;
    if (!this.data?.mnemonic) {
      throw new WalletError(
        "no_wallet",
        "Wallet must be loaded with a mnemonic to use session keys. Import via mnemonic, not private key.",
      );
    }

    const bip39 = await import("@scure/bip39");
    const seed = await bip39.mnemonicToSeed(this.data.mnemonic);
    this._sessionMgr = new SessionKeyManager(
      seed,
      this.activeAccount().address as `0x${string}`,
      this._storage,
    );
    return this._sessionMgr;
  }

  /**
   * Create a new session key.
   *
   * Session keys are short-lived, scoped key pairs stored encrypted in localStorage.
   * They allow automatic transaction signing without popping the wallet modal.
   *
   * @param scope - Authorization scope definition (expiry, spending limits, allowed contracts, etc.)
   * @returns Session key public info (no private key exposed)
   */
  async createSessionKey(scope: SessionKeyScope): Promise<SessionKeyInfo> {
    return (await this._getSessionMgr()).createSessionKey(scope);
  }

  /**
   * List all active session keys (auto-cleans expired ones).
   */
  async listSessions(): Promise<SessionKeyInfo[]> {
    if (!this._sessionMgr) return [];
    return this._sessionMgr.listSessions();
  }

  /**
   * Revoke a session key by ID.
   * Marks it as revoked (retains record for audit trail).
   */
  async revokeSession(sessionId: string): Promise<void> {
    return (await this._getSessionMgr()).revokeSession(sessionId);
  }

  /**
   * Send a transaction using a session key (no wallet prompt).
   *
   * Automatically checks:
   * - Session exists and is active
   * - Session has not expired
   * - Transaction is within scope limits
   *
   * @param sessionId - The session key to use
   * @param tx - Transaction request
   * @param feeOptions - Optional fee estimation params
   */
  async sendWithSession(
    sessionId: string,
    tx: TransactionRequest,
    feeOptions?: FeeOptions,
  ): Promise<TransactionResult> {
    if (!this.data) throw new WalletError("no_wallet", "No wallet loaded.");
    if (!tx.to)
      throw new WalletError(
        "invalid_input",
        "Missing 'to' address for transaction.",
      );

    // Get nonce if not provided
    if (!tx.nonce) {
      const nonceHex = (await this.rpcCall("eth_getTransactionCount", [
        this.activeAccount().address,
        "pending",
      ])) as string;
      tx.nonce = nonceHex;
    }

    // Estimate gas if not provided
    if (!tx.gas) {
      const estimated = (await this.rpcCall("eth_estimateGas", [
        {
          from: this.activeAccount().address,
          to: tx.to,
          value: tx.value ?? "0x0",
          data: tx.data ?? "0x",
        },
      ])) as string;
      tx.gas = estimated;
    }

    // Resolve fee options (EIP-1559 or Legacy)
    const resolvedFees = await resolveFeeOptions(
      tx,
      this.cfg.rpcUrl!,
      this.cfg.chainId,
      feeOptions,
    );
    validateFeeParams(resolvedFees);

    // Build the final transaction
    const builtTx = buildTransaction(tx, resolvedFees);
    builtTx.chainId = resolveChainId(tx, this.cfg.chainId);

    // Sign with session key (no wallet modal)
    const { signature } = await (await this._getSessionMgr()).signWithSession(
      sessionId,
      builtTx,
    );

    // Broadcast
    const txHash = (await this.rpcCall("eth_sendRawTransaction", [
      signature,
    ])) as string;
    if (!txHash)
      throw new WalletError("tx_failed", "Failed to broadcast transaction.");

    // Auto-register with TxMonitor
    if (this._txMonitor) {
      const parsedChainId = sim.parseChainIdNumber(this.cfg.chainId);
      this._txMonitor
        .watchTx(txHash, parsedChainId, {
          initialEntry: {
            from: this.activeAccount().address,
            to: tx.to,
            value: tx.value ?? "0x0",
            data: tx.data,
            nonce: tx.nonce ? parseInt(tx.nonce, 16) : undefined,
            gasUsed: builtTx.gas,
            effectiveGasPrice: builtTx.gasPrice ?? builtTx.maxFeePerGas,
          },
        })
        .catch(() => {
          /* non-critical */
        });
    }

    return {
      hash: txHash,
      from: this.activeAccount().address,
      to: tx.to,
      value: tx.value ?? "0x0",
      data: tx.data ?? "0x",
      chainId: this.cfg.chainId,
      ...(resolvedFees.type === "eip1559"
        ? {
            maxFeePerGas: resolvedFees.maxFeePerGas,
            maxPriorityFeePerGas: resolvedFees.maxPriorityFeePerGas,
          }
        : { gasPrice: resolvedFees.gasPrice }),
    };
  }

  /**
   * Check if a session key's scope covers a given transaction.
   */
  async checkSessionScope(
    sessionId: string,
    tx: TransactionRequest,
  ): Promise<ScopeCheckResult> {
    return (await this._getSessionMgr()).checkScope(sessionId, tx);
  }
}
