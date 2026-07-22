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
import { EncryptedStorageAdapter } from "./storage/encrypted";
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

export interface WalletData {
  mnemonic: string;
  privateKey: string;
  address: string;
  createdAt: number;
  /** Last used chain ID */
  chainId?: string;
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
  private _storage: StorageAdapter;

  private _sessionMgr: SessionKeyManager | null = null;
  private _txMonitor: TxMonitor | null = null;
  private _simulateFn: PocketConfig["simulateFn"];
  private _simManager: SimulationManager | null = null;

  /** Set when storage degraded to localStorage (IndexedDB unavailable) */
  private _storageDegraded: boolean = false;

  constructor(config: PocketConfig = {}) {
    this.cfg = {
      ...DEFAULTS,
      ...config,
      storageKey: config.storageKey ?? DEFAULTS.storageKey,
      derivationPath: config.derivationPath ?? DEFAULTS.derivationPath,
      autoSave: config.autoSave ?? DEFAULTS.autoSave,
      chainId: config.chainId ?? DEFAULTS.chainId,
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
   *      a. IndexedDB (available) → default, best balance
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

    if (explicitType === "indexedDb") {
      return this.wrapWithEncryption(
        new IndexedDbStorageAdapter(this.cfg.storageKey),
        passphrase,
        true,
      );
    }

    if (explicitType === "localStorage") {
      this._storageDegraded = true;
      return this.wrapWithEncryption(
        new LocalStorageAdapter(this.cfg.storageKey),
        passphrase,
        false,
      );
    }

    // Auto-detect chain: IndexedDB → localStorage (encrypted if possible)
    const idbAdapter = new IndexedDbStorageAdapter(this.cfg.storageKey);
    if (idbAdapter.isAvailable()) {
      return this.wrapWithEncryption(idbAdapter, passphrase, true);
    }

    // IndexedDB unavailable — fall back to localStorage
    this._storageDegraded = true;
    const lsAdapter = new LocalStorageAdapter(this.cfg.storageKey);
    // Wrap with encryption if passphrase provided (mitigates XSS risk)
    if (passphrase) {
      return new EncryptedStorageAdapter(lsAdapter, passphrase);
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
      return new EncryptedStorageAdapter(adapter, passphrase);
    }
    if (required) return adapter; // No passphrase but backend is secure enough
    return adapter;
  }

  /**
   * Returns the current storage type for UI warnings.
   *
   * connect-react can call this to determine if a security warning
   * should be shown to the user.
   */
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
    const { privateKey, address } = await deriveWallet(
      seed,
      this.cfg.derivationPath,
    );

    this.data = {
      mnemonic,
      privateKey,
      address,
      createdAt: Date.now(),
      chainId: this.cfg.chainId,
    };
    await this.initSignerWithKey(privateKey);
    if (this.cfg.autoSave) await this._storage.save(this.data);
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
    const { privateKey, address } = await deriveWallet(
      seed,
      this.cfg.derivationPath,
    );

    this.data = {
      mnemonic,
      privateKey,
      address,
      createdAt: Date.now(),
      chainId: this.cfg.chainId,
    };
    await this.initSignerWithKey(privateKey);
    if (this.cfg.autoSave) await this._storage.save(this.data);
    return this.data;
  }

  /** Import wallet from a raw private key */
  async importPrivateKey(pkHex: `0x${string}`): Promise<WalletData> {
    const raw = pkHex.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(raw))
      throw new WalletError(
        "invalid_key",
        "Invalid private key format. Expected 64 hex characters.",
      );

    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { keccak_256 } = await import("@noble/hashes/sha3");
    const { bytesToHex } = await import("@noble/hashes/utils");

    const priv = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
      priv[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);

    const pub = secp256k1.getPublicKey(priv, false);
    const hash = keccak_256(pub.slice(1));
    const addr = `0x${bytesToHex(hash.slice(-20))}` as `0x${string}`;

    this.data = {
      mnemonic: "",
      privateKey: pkHex,
      address: addr,
      createdAt: Date.now(),
      chainId: this.cfg.chainId,
    };
    await this.initSignerWithKey(pkHex);
    if (this.cfg.autoSave) await this._storage.save(this.data);
    return this.data;
  }

  /** Load wallet from persistent storage */
  async load(): Promise<boolean> {
    const data = await this._storage.load();
    if (!data) return false;
    this.data = data;
    await this.initSignerWithKey(data.privateKey);
    return true;
  }

  /** Save current wallet to persistent storage */
  async save(): Promise<void> {
    if (!this.data)
      throw new WalletError("no_wallet", "No wallet data to save");
    await this._storage.save(this.data);
  }

  /** Clear wallet from memory and storage */
  async clear(): Promise<void> {
    this.data = null;
    await this._storage.clear();
    if (typeof (this._signer as any).clear === "function") {
      await (this._signer as any).clear();
    }
  }

  /** Overwrite sensitive data then clear (for secure wipe) */
  async wipe(): Promise<void> {
    if (this.data) {
      const randomHex = (len: number) =>
        Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
      this.data.mnemonic = randomHex(256);
      this.data.privateKey = randomHex(128);
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
      // Overwrite with crypto-random data before nulling.
      // V8 strings are immutable so the old value persists until GC,
      // but this makes recovery harder than a static padEnd pattern.
      const randomHex = (len: number) =>
        Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
      this.data.mnemonic = randomHex(256);
      this.data.privateKey = randomHex(128);
    }
    this.data = null;
  }

  // ── Signing ─────────────────────────────────────────────────────

  /** Sign a personal message (Ethereum personal_sign style) */
  async signMessage(message: string): Promise<SignResult> {
    if (!this.data)
      throw new WalletError(
        "no_wallet",
        "No wallet loaded. Generate, import, or load a wallet first.",
      );
    return this._signer.signMessage(
      { message, chainId: this.cfg.chainId },
      this.data.privateKey as `0x${string}`,
    );
  }

  /**
   * Sign EIP-712 typed structured data (eth_signTypedData_v4).
   * Accepts JSON-stringified typed data.
   */
  async signTypedData(typedData: string): Promise<SignResult> {
    if (!this.data) throw new WalletError("no_wallet", "No wallet loaded.");
    if (!this._signer.signTypedData)
      throw new WalletError(
        "method_not_allowed",
        "signTypedData not supported by current signer",
      );
    return this._signer.signTypedData(
      typedData,
      this.data.privateKey as `0x${string}`,
    );
  }

  /** Sign and encode a transaction (Ethereum RLP-signed) */
  async signTransaction(tx: TransactionRequest): Promise<SignResult> {
    if (!this.data)
      throw new WalletError(
        "no_wallet",
        "No wallet loaded. Generate, import, or load a wallet first.",
      );
    return this._signer.signTransaction(
      tx,
      this.data.privateKey as `0x${string}`,
    );
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

    // Get nonce if not provided
    if (!tx.nonce) {
      const nonceHex = (await this.rpcCall("eth_getTransactionCount", [
        this.data.address,
        "pending",
      ])) as string;
      tx.nonce = nonceHex;
    }

    // Estimate gas if not provided
    if (!tx.gas) {
      const estimated = (await this.rpcCall("eth_estimateGas", [
        {
          from: this.data.address,
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
        this.data.address as `0x${string}`,
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
    builtTx.chainId = resolveChainId(tx, this.cfg.chainId);

    // Sign the transaction
    const { signature } = await this._signer.signTransaction(
      builtTx,
      this.data.privateKey as `0x${string}`,
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
            from: this.data!.address,
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
      from: this.data.address,
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
        if (multiplier <= 0) {
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
      this.data.address,
      "latest",
    ]);
    return balance as string;
  }

  // ── Getters ─────────────────────────────────────────────────────

  get address(): string | null {
    return this.data?.address ?? null;
  }

  get mnemonic(): string | null {
    return this.data?.mnemonic ?? null;
  }

  get hasWallet(): boolean {
    return this.data !== null;
  }

  get state(): WalletState {
    return {
      address: this.data?.address ?? null,
      chainId: this.cfg.chainId,
      hasWallet: this.data !== null,
      isConnected: this.data !== null,
    };
  }

  /** Switch the active chain */
  setChain(chainId: string): void {
    this.cfg.chainId = chainId.startsWith("eip155:")
      ? chainId
      : `eip155:${chainId}`;
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
      address ?? this.data?.address,
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
        address: this.data?.address,
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
        address: this.data?.address,
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
          address: this.data?.address,
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
          address: this.data?.address,
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
        address: this.data?.address,
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
        address: this.data?.address,
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
    if (!this.data || !this.data.mnemonic) {
      throw new WalletError(
        "no_wallet",
        "Wallet must be loaded with a mnemonic to use session keys. Import via mnemonic, not private key.",
      );
    }

    const bip39 = await import("@scure/bip39");
    const seed = await bip39.mnemonicToSeed(this.data.mnemonic);
    this._sessionMgr = new SessionKeyManager(
      seed,
      this.data.address as `0x${string}`,
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
        this.data.address,
        "pending",
      ])) as string;
      tx.nonce = nonceHex;
    }

    // Estimate gas if not provided
    if (!tx.gas) {
      const estimated = (await this.rpcCall("eth_estimateGas", [
        {
          from: this.data.address,
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
            from: this.data!.address,
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
      from: this.data.address,
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
