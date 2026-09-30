import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { SOLANA_MAINNET } from "../constants";
import {
  deriveChannelPda,
  encodeChannelVoucher,
  SOLANA_CHANNEL_PROGRAM,
  verifyVoucher,
} from "../solana-channel";
import { MemoryStorageAdapter, type StorageAdapter } from "../storage";
import {
  ChannelVoucherKeyManager,
  type ChannelVoucherPolicy,
} from "./channel-voucher-keys";

const PAYER = "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
const PAYEE = "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse";
const MINT = "EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1";
const SALT = 7n;
const OPEN_SLOT = 123_456n;
const U64_MAX = (1n << 64n) - 1n;

function policy(
  over: Partial<ChannelVoucherPolicy> = {},
): ChannelVoucherPolicy {
  return {
    cluster: SOLANA_MAINNET,
    channelProgram: SOLANA_CHANNEL_PROGRAM,
    payer: PAYER,
    mint: MINT,
    payee: PAYEE,
    pricePerUnit: 10n,
    maxCumulative: 1_000n,
    maxDelta: 400n,
    expiry: Math.floor(Date.now() / 1000) + 3_600,
    ...over,
  };
}

function manager(adapter: StorageAdapter = new MemoryStorageAdapter()) {
  return new ChannelVoucherKeyManager(
    {
      encryptionKey: "test",
      pbkdf2Iterations: 1_000,
      unsafeAllowWeakKdf: true,
    },
    adapter,
  );
}

function channelId(address: string, p = policy()): string {
  return deriveChannelPda({
    payer: p.payer,
    payee: p.payee,
    mint: p.mint,
    authorizedSigner: address,
    salt: SALT,
    openSlot: OPEN_SLOT,
    programAddress: p.channelProgram,
  }).channelId;
}

async function bound(over: Partial<ChannelVoucherPolicy> = {}, deposit = 800n) {
  const adapter = new MemoryStorageAdapter();
  const m = manager(adapter);
  const created = await m.create(policy(over));
  const id = channelId(created.address, created.policy);
  await m.bindChannel(created.id, {
    channelId: id,
    deposit,
    openSlot: OPEN_SLOT,
    salt: SALT,
  });
  return { m, adapter, created, channelId: id };
}

describe("ChannelVoucherKeyManager", () => {
  it("creates a sealed active key and accepts a deliberate localnet program pin", async () => {
    const localnet = "solana:11111111111111111111111111111111";
    const customProgram = base58.encode(
      ed25519.getPublicKey(new Uint8Array(32).fill(9)),
    );
    const m = new ChannelVoucherKeyManager({
      encryptionKey: "test",
      pbkdf2Iterations: 1_000,
      unsafeAllowWeakKdf: true,
      channelProgramOverrides: { [localnet]: customProgram },
    });
    const info = await m.create(
      policy({ cluster: localnet, channelProgram: customProgram }),
    );
    expect(info).toMatchObject({
      status: "active",
      channel: null,
      lastCumulative: 0n,
    });
    expect(base58.decode(info.address)).toHaveLength(32);
  });

  it("refuses an unpinned or mismatched channel program", async () => {
    const other = base58.encode(
      ed25519.getPublicKey(new Uint8Array(32).fill(8)),
    );
    await expect(
      manager().create(policy({ channelProgram: other })),
    ).rejects.toThrow(/not pinned/);
    await expect(
      manager().create(
        policy({ cluster: "solana:11111111111111111111111111111111" }),
      ),
    ).rejects.toThrow(/not pinned/);
  });

  it("binds only the PDA fixed by the sealed policy and caps the local limit at deposit", async () => {
    const m = manager();
    const created = await m.create(policy());
    await expect(
      m.bindChannel(created.id, {
        channelId: PAYER,
        deposit: 600n,
        openSlot: OPEN_SLOT,
        salt: SALT,
      }),
    ).rejects.toMatchObject({ code: "session_scope_exceeded" });
    const info = await m.bindChannel(created.id, {
      channelId: channelId(created.address),
      deposit: 600n,
      openSlot: OPEN_SLOT,
      salt: SALT,
    });
    expect(info.channel).toMatchObject({ deposit: 600n, maxCumulative: 600n });
    await expect(
      m.bindChannel(created.id, {
        channelId: channelId(created.address),
        deposit: 600n,
        openSlot: OPEN_SLOT,
        salt: SALT,
      }),
    ).rejects.toThrow(/already bound/);
  });

  it("signs the canonical 50-byte voucher and resumes cumulative state", async () => {
    const { m, adapter, created, channelId: id } = await bound();
    const signed = await m.signVoucher(created.id, {
      channelId: id,
      units: 3n,
    });
    expect(encodeChannelVoucher(signed.voucher)).toHaveLength(50);
    expect(signed.voucher).toEqual({
      channelId: id,
      cumulativeAmount: 30n,
      expiresAt: BigInt(created.policy.expiry),
    });
    expect(
      verifyVoucher(signed.signature, created.address, signed.voucher),
    ).toBe(true);
    const reopened = manager(adapter);
    const next = await reopened.signVoucher(created.id, {
      channelId: id,
      units: 2n,
    });
    expect(next.voucher.cumulativeAmount).toBe(50n);
    expect((await reopened.list())[0]?.lastCumulative).toBe(50n);
  });

  it("refuses unbound, wrong-channel, non-increasing, excessive-delta and budget vouchers", async () => {
    const unbound = manager();
    const fresh = await unbound.create(policy());
    await expect(
      unbound.signVoucher(fresh.id, { channelId: PAYER, units: 1n }),
    ).rejects.toThrow(/not bound/);

    const { m, created, channelId: id } = await bound({ maxDelta: 30n }, 50n);
    await expect(
      m.signVoucher(created.id, { channelId: PAYEE, units: 1n }),
    ).rejects.toThrow(/bound channel/);
    await expect(
      m.signVoucher(created.id, { channelId: id, units: 0n }),
    ).rejects.toThrow(/positive/);
    await expect(
      m.signVoucher(created.id, { channelId: id, units: 4n }),
    ).rejects.toThrow(/maxDelta/);
    await m.signVoucher(created.id, { channelId: id, units: 3n });
    await expect(
      m.signVoucher(created.id, { channelId: id, units: 3n }),
    ).rejects.toThrow(/channel budget/);
    expect((await m.list())[0]?.lastCumulative).toBe(30n);
  });

  it("refuses multiplication and cumulative u64 overflow", async () => {
    const product = await bound(
      { pricePerUnit: U64_MAX, maxCumulative: U64_MAX, maxDelta: U64_MAX },
      U64_MAX,
    );
    await expect(
      product.m.signVoucher(product.created.id, {
        channelId: product.channelId,
        units: 2n,
      }),
    ).rejects.toThrow(/delta overflows/);

    const cumulative = await bound(
      { pricePerUnit: U64_MAX - 1n, maxCumulative: U64_MAX, maxDelta: U64_MAX },
      U64_MAX,
    );
    await cumulative.m.signVoucher(cumulative.created.id, {
      channelId: cumulative.channelId,
      units: 1n,
    });
    await expect(
      cumulative.m.signVoucher(cumulative.created.id, {
        channelId: cumulative.channelId,
        units: 1n,
      }),
    ).rejects.toThrow(/cumulative amount overflows/);
  });

  it("withholds the signature when persistence fails", async () => {
    class FailingAdapter extends MemoryStorageAdapter {
      writes = 0;
      override async set<T>(key: string, value: T): Promise<void> {
        this.writes += 1;
        if (this.writes === 3) throw new Error("storage failed");
        await super.set(key, value);
      }
    }
    const adapter = new FailingAdapter();
    const m = manager(adapter);
    const created = await m.create(policy());
    const id = channelId(created.address);
    await m.bindChannel(created.id, {
      channelId: id,
      deposit: 800n,
      openSlot: OPEN_SLOT,
      salt: SALT,
    });
    await expect(
      m.signVoucher(created.id, { channelId: id, units: 1n }),
    ).rejects.toThrow("storage failed");
    expect((await manager(adapter).list())[0]?.lastCumulative).toBe(0n);
  });

  it("AAD-binds records to their id, kind and complete policy", async () => {
    const adapter = new MemoryStorageAdapter();
    const m = manager(adapter);
    const created = await m.create(policy());
    const raw = await adapter.get<Array<Record<string, unknown>>>(
      "channel_voucher_keys",
    );
    const records = structuredClone(raw as Array<Record<string, unknown>>);
    records[0] = { ...records[0], id: crypto.randomUUID() };
    await adapter.set("channel_voucher_keys", JSON.stringify(records));
    await expect(m.list()).rejects.toThrow(/altered record/);

    records[0] = { ...records[0], id: created.id, kind: "another-kind" };
    await adapter.set("channel_voucher_keys", JSON.stringify(records));
    await expect(m.list()).rejects.toThrow(/altered record/);
  });

  it("AAD-binds the recorded channel identity and deposit", async () => {
    const { m, adapter } = await bound();
    const raw = await adapter.get<Array<Record<string, unknown>>>(
      "channel_voucher_keys",
    );
    const records = structuredClone(raw as Array<Record<string, unknown>>);
    const channel = records[0]?.channel as Record<string, unknown>;
    records[0] = {
      ...records[0],
      channel: { ...channel, deposit: { __bigint__: "1000" } },
    };
    await adapter.set("channel_voucher_keys", JSON.stringify(records));
    await expect(m.list()).rejects.toThrow(/altered record/);
  });

  it("reports expiry and refuses expired or revoked keys immediately", async () => {
    const expired = await bound({ expiry: Math.floor(Date.now() / 1000) + 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await expired.m.list())[0]?.status).toBe("expired");
    await expect(
      expired.m.signVoucher(expired.created.id, {
        channelId: expired.channelId,
        units: 1n,
      }),
    ).rejects.toThrow(/expired/);

    const revoked = await bound();
    await revoked.m.revoke(revoked.created.id);
    expect((await revoked.m.list())[0]?.status).toBe("revoked");
    await expect(
      revoked.m.signVoucher(revoked.created.id, {
        channelId: revoked.channelId,
        units: 1n,
      }),
    ).rejects.toThrow(/revoked/);
  });
});
