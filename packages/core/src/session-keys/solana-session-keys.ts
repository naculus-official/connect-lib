import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { isValidAddress } from "../address-validation";
import { WalletError } from "../errors";
import {
  assertSolanaCluster,
  buildApproveDelegateTransaction,
  buildRevokeDelegateTransaction,
  buildSplTransferTransaction,
  parseSolanaTransaction,
  readMint,
  type SolanaPaymentRpc,
  type SplDelegateApproval,
  type SplTransferPayment,
  verifySignedOwnerTransaction,
  verifySignedSplTransfer,
} from "../solana-payment";
import { MemoryStorageAdapter, type StorageAdapter } from "../storage";
import {
  bigintReplacer,
  bigintReviver,
  decryptPrivateKey,
  encryptPrivateKey,
  withAdapterLock,
} from "./storage";
import type { EncryptedKeyPair } from "./types";

/**
 * Solana session keys (STATE thread 18, docs/design/solana-session-keys.md).
 *
 * An ed25519 key the owner authorizes by approving it as the SPL delegate of
 * the owner's token account for one mint: the chain caps what it can spend
 * (`delegated_amount`), and the owner can revoke it from any device. The key
 * then pays x402 / MPP Solana charges without a wallet prompt.
 *
 * The key signs one thing only: a TransferChecked that this manager builds
 * itself from facts it has checked against the scope — recipient, amount,
 * the scope's mint and cluster, a sponsoring fee payer — with the blockhash
 * read from the app's RPC after its genesis matches the scope's cluster. The
 * spend is recorded before the signature is returned. No raw messages.
 */

export interface SolanaSessionKeyScope {
  /** CAIP-2 cluster, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. */
  cluster: string;
  mint: string;
  /** Total the key may spend; approved on chain as `delegated_amount`. */
  budget: bigint;
  maxPerPayment: bigint;
  /** Owners of the destination token accounts; required, non-empty. */
  allowedRecipients: string[];
  /** Unix seconds. The chain does not expire a delegate: revoke after this. */
  expiry: number;
  maxTxCount?: number;
}

export type SolanaSessionKeyStatus =
  | "pending"
  | "active"
  | "revoked"
  | "expired";

export interface SolanaSessionKeyInfo {
  id: string;
  /** The session key's base58 address (the delegate). */
  address: string;
  owner: string;
  scope: SolanaSessionKeyScope;
  /** Token program and decimals read from the mint at creation. */
  tokenProgram: string;
  decimals: number;
  status: SolanaSessionKeyStatus;
  spent: bigint;
  useCount: number;
  createdAt: number;
}

interface StoredSolanaSessionKey extends Omit<SolanaSessionKeyInfo, "status"> {
  status: SolanaSessionKeyStatus;
  keyPair: EncryptedKeyPair;
  lastUsedAt: number;
}

export interface SolanaSessionKeyConfig {
  /** Password the private keys are sealed with (AES-256-GCM, PBKDF2). */
  encryptionKey: string;
  pbkdf2Iterations?: number;
  /** Tests only: allow a PBKDF2 work factor below the floor. */
  unsafeAllowWeakKdf?: boolean;
  /** Longest lifetime a key may be given. Default 30 days. */
  maxExpiryMs?: number;
}

export interface SolanaSessionPayment {
  /** Owner of the destination token account. */
  recipient: string;
  amount: bigint;
  /** The sponsor (x402 facilitator / MPP server fee payer). */
  feePayer: string;
  memo: string | null;
}

const STORAGE_KEY = "solana_session_keys";
const DEFAULT_MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const U64_MAX = (1n << 64n) - 1n;

function fail(message: string): never {
  throw new WalletError("invalid_input", message);
}

function refuse(message: string): never {
  throw new WalletError("session_scope_exceeded", message);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && isValidAddress(value, "solana");
}

function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(bytes)}`;
}

export class SolanaSessionKeyManager {
  private readonly config: Required<
    Pick<SolanaSessionKeyConfig, "encryptionKey" | "maxExpiryMs">
  > &
    SolanaSessionKeyConfig;
  private readonly adapter: StorageAdapter;

  constructor(config: SolanaSessionKeyConfig, adapter?: StorageAdapter) {
    if (!config.encryptionKey) fail("An encryptionKey is required.");
    this.config = {
      maxExpiryMs: DEFAULT_MAX_EXPIRY_MS,
      ...config,
    };
    this.adapter = adapter ?? new MemoryStorageAdapter();
  }

  // ── Storage ──────────────────────────────────────────────────────

  private async loadAll(): Promise<StoredSolanaSessionKey[]> {
    const raw = await this.adapter.get<string>(STORAGE_KEY);
    if (!raw) return [];
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    return JSON.parse(text, bigintReviver) as StoredSolanaSessionKey[];
  }

  private async saveAll(keys: StoredSolanaSessionKey[]): Promise<void> {
    await this.adapter.set(
      STORAGE_KEY,
      JSON.stringify(keys, bigintReplacer) as unknown as never,
    );
  }

  /** Read-modify-write one record under the per-key and storage locks. */
  private async update<T>(
    id: string,
    change: (
      key: StoredSolanaSessionKey,
      all: StoredSolanaSessionKey[],
    ) => Promise<T> | T,
  ): Promise<T> {
    return withAdapterLock(
      this.adapter,
      `solana-key:${id}`,
      `naculus-solana-session-key:${id}`,
      () =>
        withAdapterLock(
          this.adapter,
          "solana-all",
          "naculus-solana-session-storage",
          async () => {
            const keys = await this.loadAll();
            const key = keys.find((k) => k.id === id);
            if (!key) fail(`Solana session key ${id} not found.`);
            const result = await change(key, keys);
            await this.saveAll(keys);
            return result;
          },
        ),
    );
  }

  private info(key: StoredSolanaSessionKey): SolanaSessionKeyInfo {
    const { keyPair: _k, lastUsedAt: _l, ...info } = key;
    const status =
      key.status === "active" && key.scope.expiry <= Date.now() / 1000
        ? "expired"
        : key.status;
    return { ...info, scope: { ...key.scope }, status };
  }

  async listSessions(): Promise<SolanaSessionKeyInfo[]> {
    return (await this.loadAll()).map((k) => this.info(k));
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Create a key for `owner` (pending until the owner's approval is
   * attached). The mint is read through `rpc` on the scope's cluster.
   */
  async createSessionKey(
    scope: SolanaSessionKeyScope,
    owner: string,
    rpc: SolanaPaymentRpc,
  ): Promise<SolanaSessionKeyInfo> {
    if (!isAddress(owner)) fail("owner is not a Solana address.");
    if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(scope.cluster)) {
      fail("cluster is not a Solana CAIP-2 id.");
    }
    if (!isAddress(scope.mint)) fail("mint is not a Solana address.");
    if (scope.budget <= 0n || scope.budget > U64_MAX) {
      fail("budget is not a positive u64.");
    }
    if (scope.maxPerPayment <= 0n || scope.maxPerPayment > scope.budget) {
      fail("maxPerPayment must be positive and within the budget.");
    }
    if (
      !Array.isArray(scope.allowedRecipients) ||
      scope.allowedRecipients.length === 0 ||
      !scope.allowedRecipients.every(isAddress) ||
      scope.allowedRecipients.includes(owner)
    ) {
      fail(
        "allowedRecipients must list Solana addresses other than the owner.",
      );
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(scope.expiry) ||
      scope.expiry <= nowSeconds ||
      scope.expiry * 1000 > Date.now() + this.config.maxExpiryMs
    ) {
      fail("expiry must be in the future and within maxExpiryMs.");
    }
    if (
      scope.maxTxCount !== undefined &&
      (!Number.isSafeInteger(scope.maxTxCount) || scope.maxTxCount <= 0)
    ) {
      fail("maxTxCount must be a positive integer.");
    }
    await assertSolanaCluster(rpc, scope.cluster);
    const mintAccount = await rpc.getAccountInfo(scope.mint);
    if (!mintAccount) fail("The mint does not exist on this cluster.");
    const { tokenProgram, decimals } = readMint(
      mintAccount.owner,
      mintAccount.data,
    );

    const secret = randomBytes(32);
    const publicKey = ed25519.getPublicKey(secret);
    const keyPair = encryptPrivateKey(
      toHex(secret),
      this.config.encryptionKey,
      undefined,
      this.config.pbkdf2Iterations,
      toHex(publicKey),
      { unsafeAllowWeakKdf: this.config.unsafeAllowWeakKdf },
    );
    secret.fill(0);
    const now = Date.now();
    const stored: StoredSolanaSessionKey = {
      id: crypto.randomUUID(),
      address: base58.encode(publicKey),
      owner,
      scope: {
        ...scope,
        allowedRecipients: [...scope.allowedRecipients],
      },
      tokenProgram,
      decimals,
      status: "pending",
      spent: 0n,
      useCount: 0,
      createdAt: now,
      lastUsedAt: now,
      keyPair,
    };
    await withAdapterLock(
      this.adapter,
      "solana-all",
      "naculus-solana-session-storage",
      async () => {
        const keys = await this.loadAll();
        keys.push(stored);
        await this.saveAll(keys);
      },
    );
    return this.info(stored);
  }

  private approvalFor(
    key: StoredSolanaSessionKey,
    recentBlockhash: string,
  ): SplDelegateApproval {
    return {
      owner: key.owner,
      mint: key.scope.mint,
      tokenProgram: key.tokenProgram,
      decimals: key.decimals,
      delegate: key.address,
      amount: key.scope.budget,
      recentBlockhash,
    };
  }

  private async get(id: string): Promise<StoredSolanaSessionKey> {
    const key = (await this.loadAll()).find((k) => k.id === id);
    if (!key) fail(`Solana session key ${id} not found.`);
    return key;
  }

  /**
   * The owner's ApproveChecked for this key (budget = scope.budget), for
   * the owner's wallet to sign. Approving replaces any delegate the owner's
   * token account already has — another dapp's, or another key of this
   * owner for this mint (which `attachApproval` then marks revoked) — so
   * show that before asking.
   */
  async prepareApproval(
    id: string,
    rpc: SolanaPaymentRpc,
  ): Promise<{ transaction: Uint8Array; recentBlockhash: string }> {
    const key = await this.get(id);
    if (key.status !== "pending") fail("This key is not awaiting approval.");
    await assertSolanaCluster(rpc, key.scope.cluster);
    const recentBlockhash = await rpc.getLatestBlockhash();
    return {
      transaction: buildApproveDelegateTransaction(
        this.approvalFor(key, recentBlockhash),
      ),
      recentBlockhash,
    };
  }

  /**
   * Check the owner-signed approval exactly (owner pays and signs alone; the
   * one token instruction is ours) and activate the key. Returns the signed
   * transaction base64-encoded; broadcast it (`rpc.sendTransaction`) —
   * payments fail on chain until it lands.
   */
  async attachApproval(
    id: string,
    signed: Uint8Array,
    recentBlockhash: string,
  ): Promise<string> {
    return this.update(id, (key, all) => {
      if (key.status !== "pending") fail("This key is not awaiting approval.");
      const transaction = verifySignedOwnerTransaction(signed, {
        kind: "approve",
        approval: this.approvalFor(key, recentBlockhash),
      });
      key.status = "active";
      // A token account has one delegate: this approval replaces any other
      // key of this owner for this mint on chain, so retire it here too.
      for (const other of all) {
        if (
          other.id !== key.id &&
          other.owner === key.owner &&
          other.scope.mint === key.scope.mint &&
          other.scope.cluster === key.scope.cluster &&
          (other.status === "active" || other.status === "pending")
        ) {
          other.status = "revoked";
        }
      }
      return transaction;
    });
  }

  /**
   * The owner's Revoke for the key's token account, for the owner's wallet
   * to sign, and mark the key revoked here. The chain stops the key only
   * once the revoke lands (or the budget is spent). Revoke clears whatever
   * delegate the account has; with one key per owner and mint (see
   * `attachApproval`) that is this key. Check the wallet's result with
   * `verifySignedOwnerTransaction({ kind: "revoke", … })`.
   */
  async prepareRevocation(
    id: string,
    rpc: SolanaPaymentRpc,
  ): Promise<{ transaction: Uint8Array; recentBlockhash: string }> {
    const key = await this.get(id);
    await assertSolanaCluster(rpc, key.scope.cluster);
    const recentBlockhash = await rpc.getLatestBlockhash();
    await this.revoke(id);
    return {
      transaction: buildRevokeDelegateTransaction({
        owner: key.owner,
        mint: key.scope.mint,
        tokenProgram: key.tokenProgram,
        recentBlockhash,
      }),
      recentBlockhash,
    };
  }

  /** Stop this key from signing anything further (local). */
  async revoke(id: string): Promise<void> {
    await this.update(id, (key) => {
      key.status = "revoked";
    });
  }

  // ── Signing ──────────────────────────────────────────────────────

  /**
   * Build, sign and account one delegated TransferChecked. Returns the
   * partially signed transaction (the sponsor adds the fee payer signature),
   * base64-encoded as x402 and MPP carry it.
   */
  async signPayment(
    id: string,
    payment: SolanaSessionPayment,
    rpc: SolanaPaymentRpc,
  ): Promise<string> {
    if (!isAddress(payment.recipient)) fail("recipient is not an address.");
    if (!isAddress(payment.feePayer)) fail("feePayer is not an address.");
    // Checked outside the lock too, so nothing is fetched for a refusal.
    const snapshot = await this.get(id);
    this.check(snapshot, payment);
    await assertSolanaCluster(rpc, snapshot.scope.cluster);
    const recentBlockhash = await rpc.getLatestBlockhash();

    return this.update(id, (key) => {
      // Re-check under the lock: another tab may have spent meanwhile.
      this.check(key, payment);
      const built: SplTransferPayment = {
        feePayer: payment.feePayer,
        authority: key.address,
        sourceOwner: key.owner,
        mint: key.scope.mint,
        tokenProgram: key.tokenProgram,
        decimals: key.decimals,
        recipient: payment.recipient,
        amount: payment.amount,
        memo: payment.memo,
        recentBlockhash,
      };
      const wire = buildSplTransferTransaction(built);
      const tx = parseSolanaTransaction(wire);
      const slot = tx.accountKeys.indexOf(key.address);
      const secret = hexToBytes(
        decryptPrivateKey(key.keyPair, this.config.encryptionKey).slice(2),
      );
      try {
        if (base58.encode(ed25519.getPublicKey(secret)) !== key.address) {
          fail("The stored key does not match its address.");
        }
        wire.set(ed25519.sign(tx.message, secret), 1 + 64 * slot);
      } finally {
        secret.fill(0);
      }
      const transaction = verifySignedSplTransfer(wire, built, {
        allowLighthouse: false,
      });
      // Recorded before it is returned; a failed save withholds it.
      key.spent += payment.amount;
      key.useCount += 1;
      key.lastUsedAt = Date.now();
      return transaction;
    });
  }

  private check(key: StoredSolanaSessionKey, payment: SolanaSessionPayment) {
    if (key.status !== "active") refuse(`The key is ${key.status}.`);
    if (key.scope.expiry <= Date.now() / 1000) refuse("The key has expired.");
    if (!key.scope.allowedRecipients.includes(payment.recipient)) {
      refuse("The recipient is not allowed for this key.");
    }
    if (payment.amount <= 0n) refuse("The amount must be positive.");
    if (payment.amount > key.scope.maxPerPayment) {
      refuse("The amount exceeds the key's per-payment limit.");
    }
    if (key.spent + payment.amount > key.scope.budget) {
      refuse("The amount exceeds the key's remaining budget.");
    }
    if (
      key.scope.maxTxCount !== undefined &&
      key.useCount >= key.scope.maxTxCount
    ) {
      refuse("The key has made its maximum number of payments.");
    }
    // Sponsored only: the key holds no SOL, and the owner is not asked.
    if (payment.feePayer === key.address || payment.feePayer === key.owner) {
      refuse("The fee must be paid by the sponsor, not the key or the owner.");
    }
  }
}
