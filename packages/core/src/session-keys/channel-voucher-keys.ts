import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { isValidAddress } from "../address-validation";
import { WalletError } from "../errors";
import {
  type ChannelVoucher,
  deriveChannelPda,
  signVoucher as signChannelVoucher,
  TRUSTED_CHANNEL_PROGRAMS,
} from "../solana-channel";
import { MemoryStorageAdapter, type StorageAdapter } from "../storage";
import {
  bigintReplacer,
  bigintReviver,
  decryptPrivateKey,
  encryptPrivateKey,
  withAdapterLock,
} from "./storage";
import type { EncryptedKeyPair } from "./types";

const STORAGE_KEY = "channel_voucher_keys";
const RECORD_KIND = "naculus-channel-voucher-key/v1";
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

export interface ChannelVoucherPolicy {
  cluster: string;
  channelProgram: string;
  payer: string;
  mint: string;
  payee: string;
  pricePerUnit: bigint;
  maxCumulative: bigint;
  maxDelta: bigint;
  /** Unix seconds, also placed in every voucher. */
  expiry: number;
}

export type ChannelVoucherKeyStatus = "active" | "revoked" | "expired";

export interface BoundChannel {
  channelId: string;
  deposit: bigint;
  openSlot: bigint;
  salt: bigint;
  /** The policy limit capped by the channel's deposited amount. */
  maxCumulative: bigint;
}

export interface ChannelVoucherKeyInfo {
  id: string;
  address: string;
  policy: ChannelVoucherPolicy;
  status: ChannelVoucherKeyStatus;
  channel: BoundChannel | null;
  lastCumulative: bigint;
  createdAt: number;
}

export interface ChannelVoucherKeyConfig {
  encryptionKey: string;
  pbkdf2Iterations?: number;
  /** Tests only: allow a PBKDF2 work factor below the floor. */
  unsafeAllowWeakKdf?: boolean;
  /** Explicit app-owned program pins, including clusters with no built-in pin. */
  channelProgramOverrides?: Readonly<Record<string, string>>;
}

export interface SignedChannelVoucher {
  voucher: ChannelVoucher;
  signature: Uint8Array;
}

interface StoredChannelVoucherKey extends ChannelVoucherKeyInfo {
  kind: typeof RECORD_KIND;
  keyPair: EncryptedKeyPair;
}

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

function recordBinding(key: {
  kind: string;
  id: string;
  address: string;
  policy: ChannelVoucherPolicy;
  channel?: BoundChannel | null;
}): `0x${string}` {
  const p = key.policy;
  const channel = key.channel;
  return toHex(
    sha256(
      utf8ToBytes(
        JSON.stringify([
          key.kind,
          key.id,
          key.address,
          p.cluster,
          p.channelProgram,
          p.payer,
          p.mint,
          p.payee,
          p.pricePerUnit.toString(),
          p.maxCumulative.toString(),
          p.maxDelta.toString(),
          p.expiry,
          channel?.channelId ?? null,
          channel?.deposit.toString() ?? null,
          channel?.openSlot.toString() ?? null,
          channel?.salt.toString() ?? null,
          channel?.maxCumulative.toString() ?? null,
        ]),
      ),
    ),
  );
}

export class ChannelVoucherKeyManager {
  private readonly adapter: StorageAdapter;

  constructor(
    private readonly config: ChannelVoucherKeyConfig,
    adapter?: StorageAdapter,
  ) {
    if (!config.encryptionKey) fail("An encryptionKey is required.");
    this.adapter = adapter ?? new MemoryStorageAdapter();
  }

  private async loadAll(): Promise<StoredChannelVoucherKey[]> {
    const raw = await this.adapter.get<string>(STORAGE_KEY);
    if (!raw) return [];
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    return JSON.parse(text, bigintReviver) as StoredChannelVoucherKey[];
  }

  private async saveAll(keys: StoredChannelVoucherKey[]): Promise<void> {
    await this.adapter.set(
      STORAGE_KEY,
      JSON.stringify(keys, bigintReplacer) as unknown as never,
    );
  }

  private info(key: StoredChannelVoucherKey): ChannelVoucherKeyInfo {
    const { keyPair: _keyPair, kind: _kind, ...info } = key;
    const status =
      key.status === "active" && key.policy.expiry <= Date.now() / 1000
        ? "expired"
        : key.status;
    return {
      ...info,
      policy: { ...key.policy },
      channel: key.channel ? { ...key.channel } : null,
      status,
    };
  }

  private open(key: StoredChannelVoucherKey): Uint8Array {
    try {
      return hexToBytes(
        decryptPrivateKey(
          { ...key.keyPair, publicKey: recordBinding(key) },
          this.config.encryptionKey,
        ).slice(2),
      );
    } catch {
      fail(
        "The stored voucher key does not open: wrong password or altered record.",
      );
    }
  }

  private async update<T>(
    id: string,
    change: (key: StoredChannelVoucherKey) => T,
  ): Promise<T> {
    return withAdapterLock(
      this.adapter,
      `channel-voucher-key:${id}`,
      `naculus-channel-voucher-key:${id}`,
      () =>
        withAdapterLock(
          this.adapter,
          "channel-voucher-all",
          "naculus-channel-voucher-storage",
          async () => {
            const keys = await this.loadAll();
            const key = keys.find((candidate) => candidate.id === id);
            if (!key) fail(`Channel voucher key ${id} not found.`);
            const result = change(key);
            await this.saveAll(keys);
            return result;
          },
        ),
    );
  }

  async create(policy: ChannelVoucherPolicy): Promise<ChannelVoucherKeyInfo> {
    if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(policy.cluster)) {
      fail("cluster is not a Solana CAIP-2 id.");
    }
    for (const [value, name] of [
      [policy.channelProgram, "channelProgram"],
      [policy.payer, "payer"],
      [policy.mint, "mint"],
      [policy.payee, "payee"],
    ] as const) {
      if (!isAddress(value)) fail(`${name} is not a Solana address.`);
    }
    const expected =
      this.config.channelProgramOverrides?.[policy.cluster] ??
      TRUSTED_CHANNEL_PROGRAMS[policy.cluster]?.address;
    if (!expected || policy.channelProgram !== expected) {
      fail("channelProgram is not pinned for this cluster.");
    }
    if (policy.pricePerUnit <= 0n || policy.pricePerUnit > U64_MAX) {
      fail("pricePerUnit is not a positive u64.");
    }
    if (policy.maxCumulative <= 0n || policy.maxCumulative > U64_MAX) {
      fail("maxCumulative is not a positive u64.");
    }
    if (policy.maxDelta <= 0n || policy.maxDelta > policy.maxCumulative) {
      fail("maxDelta must be positive and within maxCumulative.");
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(policy.expiry) ||
      policy.expiry <= now ||
      BigInt(policy.expiry) > I64_MAX
    ) {
      fail("expiry must be a future i64 Unix timestamp.");
    }

    const secret = randomBytes(32);
    const address = base58.encode(ed25519.getPublicKey(secret));
    const id = crypto.randomUUID();
    const fixedPolicy = { ...policy };
    const fixed = {
      kind: RECORD_KIND,
      id,
      address,
      policy: fixedPolicy,
    } as const;
    const keyPair = encryptPrivateKey(
      toHex(secret),
      this.config.encryptionKey,
      undefined,
      this.config.pbkdf2Iterations,
      recordBinding(fixed),
      { unsafeAllowWeakKdf: this.config.unsafeAllowWeakKdf },
    );
    secret.fill(0);
    const stored: StoredChannelVoucherKey = {
      ...fixed,
      keyPair,
      status: "active",
      channel: null,
      lastCumulative: 0n,
      createdAt: Date.now(),
    };
    await withAdapterLock(
      this.adapter,
      "channel-voucher-all",
      "naculus-channel-voucher-storage",
      async () => {
        const keys = await this.loadAll();
        keys.push(stored);
        await this.saveAll(keys);
      },
    );
    return this.info(stored);
  }

  async bindChannel(
    id: string,
    binding: Omit<BoundChannel, "maxCumulative">,
  ): Promise<ChannelVoucherKeyInfo> {
    return this.update(id, (key) => {
      if (key.channel) refuse("The voucher key is already bound to a channel.");
      if (binding.deposit <= 0n || binding.deposit > U64_MAX) {
        fail("deposit is not a positive u64.");
      }
      const derived = deriveChannelPda({
        payer: key.policy.payer,
        payee: key.policy.payee,
        mint: key.policy.mint,
        authorizedSigner: key.address,
        salt: binding.salt,
        openSlot: binding.openSlot,
        programAddress: key.policy.channelProgram,
      });
      if (derived.channelId !== binding.channelId) {
        refuse("channelId does not match the sealed channel identity.");
      }
      const secret = this.open(key);
      key.channel = {
        ...binding,
        maxCumulative:
          key.policy.maxCumulative < binding.deposit
            ? key.policy.maxCumulative
            : binding.deposit,
      };
      try {
        key.keyPair = encryptPrivateKey(
          toHex(secret),
          this.config.encryptionKey,
          undefined,
          this.config.pbkdf2Iterations,
          recordBinding(key),
          { unsafeAllowWeakKdf: this.config.unsafeAllowWeakKdf },
        );
      } finally {
        secret.fill(0);
      }
      return this.info(key);
    });
  }

  async signVoucher(
    id: string,
    input: { channelId: string; units: bigint },
  ): Promise<SignedChannelVoucher> {
    return this.update(id, (key) => {
      if (key.status !== "active") refuse(`The voucher key is ${key.status}.`);
      if (key.policy.expiry <= Date.now() / 1000)
        refuse("The voucher key has expired.");
      if (!key.channel) refuse("The voucher key is not bound to a channel.");
      if (input.channelId !== key.channel.channelId) {
        refuse("channelId does not match the bound channel.");
      }
      if (input.units <= 0n || input.units > U64_MAX) {
        refuse("units must be a positive u64.");
      }
      if (input.units > U64_MAX / key.policy.pricePerUnit) {
        refuse("The voucher delta overflows u64.");
      }
      const delta = input.units * key.policy.pricePerUnit;
      if (delta > key.policy.maxDelta)
        refuse("The voucher delta exceeds maxDelta.");
      if (key.lastCumulative > U64_MAX - delta) {
        refuse("The cumulative amount overflows u64.");
      }
      const cumulativeAmount = key.lastCumulative + delta;
      if (cumulativeAmount <= key.lastCumulative) {
        refuse("The cumulative amount must strictly increase.");
      }
      if (
        cumulativeAmount > key.channel.maxCumulative ||
        key.channel.maxCumulative > key.channel.deposit
      ) {
        refuse("The cumulative amount exceeds the channel budget.");
      }
      const voucher: ChannelVoucher = {
        channelId: key.channel.channelId,
        cumulativeAmount,
        expiresAt: BigInt(key.policy.expiry),
      };
      const secret = this.open(key);
      let signature: Uint8Array;
      try {
        if (base58.encode(ed25519.getPublicKey(secret)) !== key.address) {
          fail("The stored voucher key does not match its address.");
        }
        signature = signChannelVoucher(secret, voucher);
      } finally {
        secret.fill(0);
      }
      // Persisted before update() returns this signature to the caller.
      key.lastCumulative = cumulativeAmount;
      return { voucher, signature };
    });
  }

  async list(): Promise<ChannelVoucherKeyInfo[]> {
    const keys = await this.loadAll();
    for (const key of keys) this.open(key).fill(0);
    return keys.map((key) => this.info(key));
  }

  async revoke(id: string): Promise<void> {
    await this.update(id, (key) => {
      key.status = "revoked";
    });
  }
}
