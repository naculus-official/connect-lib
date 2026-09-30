import {
  ChannelVoucherKeyManager,
  encodeChannelVoucher,
  MemoryStorageAdapter,
  parseSolanaTransaction,
  SOLANA_CHANNEL_PROGRAM,
  SOLANA_MAINNET,
  SOLANA_PROGRAMS,
  TRUSTED_CHANNEL_PROGRAMS,
} from "@naculus/connect-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import {
  createMppSessionFetch,
  decodeBase64UrlJson,
  encodeBase64UrlJson,
  type MppCredential,
  type MppSolanaSigner,
} from "./index";
import type { MppSessionRpc } from "./session";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MINT = "EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1";
const PAYEE = "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse";
const FEE_PAYER = "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu";
const SEED = new Uint8Array(32).fill(1);
const PAYER = base58.encode(ed25519.getPublicKey(SEED));
const URL_ = "https://meter.example/data";

function programAccount(programData: string): Uint8Array {
  const data = new Uint8Array(36);
  new DataView(data.buffer).setUint32(0, 2, true);
  data.set(base58.decode(programData), 4);
  return data;
}

function programDataAccount(slot: bigint, authority: string): Uint8Array {
  const data = new Uint8Array(45);
  const view = new DataView(data.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, slot, true);
  data[12] = 1;
  data.set(base58.decode(authority), 13);
  return data;
}

function rpc(over: Partial<MppSessionRpc> = {}): MppSessionRpc {
  const trust = TRUSTED_CHANNEL_PROGRAMS[SOLANA_MAINNET] as NonNullable<
    (typeof TRUSTED_CHANNEL_PROGRAMS)[string]
  >;
  const mint = new Uint8Array(82);
  mint[44] = 6;
  mint[45] = 1;
  const accounts = new Map([
    [MINT, { owner: SOLANA_PROGRAMS.token, data: mint }],
    [trust.address, { owner: LOADER, data: programAccount(trust.programData) }],
    [
      trust.programData,
      {
        owner: LOADER,
        data: programDataAccount(
          trust.lastDeployedSlot,
          trust.upgradeAuthority,
        ),
      },
    ],
  ]);
  return {
    getGenesisHash: async () => GENESIS,
    getLatestBlockhash: async () => BLOCKHASH,
    getAccountInfo: async (address) => accounts.get(address) ?? null,
    isBlockhashValid: async (blockhash) => blockhash === BLOCKHASH,
    ...over,
  };
}

function wallet(): MppSolanaSigner & { seen: Uint8Array[] } {
  const seen: Uint8Array[] = [];
  return {
    address: PAYER,
    seen,
    async signTransaction(wire) {
      seen.push(wire);
      const tx = parseSolanaTransaction(wire);
      const out = wire.slice();
      out.set(
        ed25519.sign(tx.message, SEED),
        1 + 64 * tx.accountKeys.indexOf(PAYER),
      );
      return out;
    },
  };
}

function manager(adapter = new MemoryStorageAdapter()) {
  return new ChannelVoucherKeyManager(
    {
      encryptionKey: "test",
      pbkdf2Iterations: 1_000,
      unsafeAllowWeakKdf: true,
    },
    adapter,
  );
}

function request(over: Record<string, unknown> = {}) {
  return {
    amount: "10",
    currency: MINT,
    recipient: PAYEE,
    minimumDeposit: "100",
    methodDetails: {
      network: "mainnet",
      channelProgram: SOLANA_CHANNEL_PROGRAM,
      recentBlockhash: BLOCKHASH,
      recentSlot: "123456",
      decimals: 6,
      tokenProgram: SOLANA_PROGRAMS.token,
      feePayer: true,
      feePayerKey: FEE_PAYER,
      voucherSigner: "client",
      gracePeriodSeconds: 3_600,
      ...((over.methodDetails as Record<string, unknown> | undefined) ?? {}),
    },
    ...Object.fromEntries(
      Object.entries(over).filter(([key]) => key !== "methodDetails"),
    ),
  };
}

function challenge(req = request()) {
  return `Payment id="session-1", realm="meter.example", method="solana", intent="session", request="${encodeBase64UrlJson(req)}"`;
}

function credential(req: Request): MppCredential {
  const value = req.headers.get("Authorization") as string;
  return decodeBase64UrlJson(value.slice(8)) as MppCredential;
}

function receipt(reference: string, accepted = "0") {
  return encodeBase64UrlJson({
    method: "solana",
    intent: "session",
    reference,
    status: "success",
    timestamp: new Date().toISOString(),
    acceptedCumulative: accepted,
    spent: accepted,
    idleTimeoutSeconds: 60,
  });
}

function policy() {
  return {
    recipient: PAYEE,
    amount: 10n,
    deposit: 1_000n,
    maxCumulative: 800n,
    maxDelta: 200n,
    expiresAt: Math.floor(Date.now() / 1_000) + 7_200,
  };
}

describe("createMppSessionFetch", () => {
  it("opens, meters vouchers, closes, and matches the WP1 voucher vector layout", async () => {
    const actions: Record<string, unknown>[] = [];
    const fetch = async (input: RequestInfo | URL) => {
      const req = input as Request;
      if (!req.headers.has("Authorization")) {
        return new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge() },
        });
      }
      const payload = credential(req).payload;
      actions.push(payload);
      const channelId = payload.channelId as string;
      const voucher = payload.voucher as
        | { voucher: { cumulativeAmount: string } }
        | undefined;
      return new Response("ok", {
        headers: {
          "Payment-Receipt": receipt(
            channelId,
            voucher?.voucher.cumulativeAmount ?? "0",
          ),
        },
      });
    };
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer: wallet(),
      keyManager: manager(),
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
    });

    const opened = await pay(URL_);
    expect(opened.channel?.channelId).toBe(actions[0]?.channelId);
    expect(actions[0]).toMatchObject({
      action: "open",
      payer: PAYER,
      payee: PAYEE,
      mint: MINT,
      depositAmount: "1000",
      gracePeriodSeconds: 3600,
      openSlot: "123456",
    });
    expect(pay.channels).toHaveLength(1);

    pay.meter.add(3n);
    await pay(URL_);
    await pay(URL_, { units: 2n });
    const first = actions[1]?.voucher as {
      voucher: {
        channelId: string;
        cumulativeAmount: string;
        expiresAt: number;
      };
      signature: string;
    };
    const second = actions[2]?.voucher as typeof first;
    expect(first.voucher.cumulativeAmount).toBe("30");
    expect(second.voucher.cumulativeAmount).toBe("50");
    expect(
      encodeChannelVoucher({
        channelId: first.voucher.channelId,
        cumulativeAmount: BigInt(first.voucher.cumulativeAmount),
        expiresAt: BigInt(first.voucher.expiresAt),
      }),
    ).toHaveLength(50);
    expect(base58.decode(first.signature)).toHaveLength(64);

    await pay.close();
    expect(actions[3]).toEqual({
      action: "close",
      channelId: opened.channel?.channelId,
      voucher: second,
    });
    expect(pay.channels).toHaveLength(0);
  });

  it("never signs beyond the meter or the local voucher limit", async () => {
    let channelId = "";
    const fetch = async (input: RequestInfo | URL) => {
      const req = input as Request;
      if (!req.headers.has("Authorization")) {
        return new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge() },
        });
      }
      const payload = credential(req).payload;
      channelId = (payload.channelId as string) || channelId;
      return new Response(null, {
        headers: { "Payment-Receipt": receipt(channelId) },
      });
    };
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer: wallet(),
      keyManager: manager(),
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
    });
    await pay(URL_);
    await expect(pay(URL_)).rejects.toThrow(/No metered units/);
    pay.meter.add(21n);
    await expect(pay(URL_)).rejects.toThrow(/exceeds maxDelta/);
    expect(pay.meter.pending).toBe(21n);
  });

  it("commits a signed voucher when its request fails", async () => {
    const cumulativeAmounts: string[] = [];
    let authorized = 0;
    const fetch = async (input: RequestInfo | URL) => {
      const req = input as Request;
      if (!req.headers.has("Authorization")) {
        return new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge() },
        });
      }
      const payload = credential(req).payload;
      const channelId = payload.channelId as string;
      const cumulative = (
        payload.voucher as { voucher?: { cumulativeAmount?: string } }
      )?.voucher?.cumulativeAmount;
      if (cumulative) cumulativeAmounts.push(cumulative);
      authorized++;
      if (authorized === 2) throw new TypeError("network failed");
      return new Response(null, {
        headers: { "Payment-Receipt": receipt(channelId, cumulative) },
      });
    };
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer: wallet(),
      keyManager: manager(),
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
    });

    await pay(URL_);
    pay.meter.add(2n);
    await expect(pay(URL_)).rejects.toThrow(/network failed/);
    expect(pay.meter.pending).toBe(0n);
    pay.meter.add(3n);
    await pay(URL_);
    expect(cumulativeAmounts).toEqual(["20", "50"]);
  });

  it("reserves metered units before signing concurrent vouchers", async () => {
    let channelId = "";
    const fetch = async (input: RequestInfo | URL) => {
      const req = input as Request;
      if (!req.headers.has("Authorization")) {
        return new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge() },
        });
      }
      channelId = (credential(req).payload.channelId as string) || channelId;
      return new Response(null, {
        headers: { "Payment-Receipt": receipt(channelId) },
      });
    };
    const keyManager = manager();
    const signVoucher = vi.spyOn(keyManager, "signVoucher");
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer: wallet(),
      keyManager,
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
    });

    await pay(URL_);
    pay.meter.add(5n);
    const results = await Promise.allSettled([pay(URL_), pay(URL_)]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/No metered units/),
      }),
    });
    expect(signVoucher).toHaveBeenCalledTimes(1);
    expect(signVoucher).toHaveBeenCalledWith(expect.any(String), {
      channelId: expect.any(String),
      units: 5n,
    });
    expect(pay.meter.pending).toBe(0n);
  });

  it("preserves units added while a voucher request is in flight", async () => {
    let releaseVoucher!: () => void;
    const voucherBlocked = new Promise<void>((resolve) => {
      releaseVoucher = resolve;
    });
    let voucherStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      voucherStarted = resolve;
    });
    let authorized = 0;
    const fetch = async (input: RequestInfo | URL) => {
      const req = input as Request;
      if (!req.headers.has("Authorization")) {
        return new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge() },
        });
      }
      const payload = credential(req).payload;
      authorized++;
      if (authorized === 2) {
        voucherStarted();
        await voucherBlocked;
      }
      return new Response(null, {
        headers: {
          "Payment-Receipt": receipt(payload.channelId as string),
        },
      });
    };
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer: wallet(),
      keyManager: manager(),
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
    });

    await pay(URL_);
    pay.meter.add(2n);
    const inFlight = pay(URL_);
    await started;
    pay.meter.add(3n);
    releaseVoucher();
    await inFlight;
    expect(pay.meter.pending).toBe(3n);
  });

  it("revokes an unbound key when the server rejects open", async () => {
    const keys = manager();
    let calls = 0;
    const fetch = async () =>
      ++calls === 1
        ? new Response(null, {
            status: 402,
            headers: { "WWW-Authenticate": challenge() },
          })
        : new Response(null, { status: 402 });
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer: wallet(),
      keyManager: keys,
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(pay(URL_)).rejects.toThrow(/rejected the channel open/);
    const listed = await keys.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: "revoked", channel: null });
  });

  it("retains a failed post-send open for force-close recovery", async () => {
    const sent: Uint8Array[] = [];
    let calls = 0;
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer: wallet(),
      keyManager: manager(),
      policy: policy(),
      fetch: (async () =>
        ++calls === 1
          ? new Response(null, {
              status: 402,
              headers: { "WWW-Authenticate": challenge() },
            })
          : new Response(null)) as typeof globalThis.fetch,
      sendTransaction: async (transaction) => {
        sent.push(transaction);
        return "request-close";
      },
    });

    const error = await pay(URL_).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      name: "MppError",
      channelId: pay.channels[0]?.channelId,
    });
    await expect(pay.forceClose()).resolves.toMatchObject({
      requestCloseTxHash: "request-close",
    });
    expect(sent).toHaveLength(1);
  });

  it("single-flights concurrent channel opens", async () => {
    const signer = wallet();
    let deposits = 0;
    const fetch = async (input: RequestInfo | URL) => {
      const req = input as Request;
      if (!req.headers.has("Authorization")) {
        return new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge() },
        });
      }
      const payload = credential(req).payload;
      deposits++;
      return new Response(null, {
        headers: {
          "Payment-Receipt": receipt(payload.channelId as string),
        },
      });
    };
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer,
      keyManager: manager(),
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
    });

    const [first, second] = await Promise.allSettled([pay(URL_), pay(URL_)]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/No metered units/),
      }),
    });
    expect(signer.seen).toHaveLength(1);
    expect(deposits).toBe(1);
  });

  it("waits for an in-flight open before handling a later request", async () => {
    const signer = wallet();
    let releaseOpen!: () => void;
    const openBlocked = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let openStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      openStarted = resolve;
    });
    let deposits = 0;
    const fetch = async (input: RequestInfo | URL) => {
      const req = input as Request;
      if (!req.headers.has("Authorization")) {
        return new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge() },
        });
      }
      const payload = credential(req).payload;
      deposits++;
      openStarted();
      await openBlocked;
      return new Response("opener", {
        headers: {
          "Payment-Receipt": receipt(payload.channelId as string),
        },
      });
    };
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer,
      keyManager: manager(),
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
    });

    const opener = pay(URL_);
    await started;
    const waiter = pay("https://meter.example/waiter");
    releaseOpen();

    const opened = await opener;
    await expect(waiter).rejects.toThrow(/No metered units/);
    expect(await opened.response.text()).toBe("opener");
    expect(signer.seen).toHaveLength(1);
    expect(deposits).toBe(1);
  });

  it.each([
    [
      "network",
      { methodDetails: { network: "devnet" } },
      rpc(),
      /serves solana/,
    ],
    [
      "program",
      { methodDetails: { channelProgram: FEE_PAYER } },
      rpc(),
      /not the app-trusted/,
    ],
    [
      "mint",
      { methodDetails: { decimals: 5 } },
      rpc(),
      /does not match the mint/,
    ],
    ["recipient", { recipient: FEE_PAYER }, rpc(), /exceeds the app policy/],
    ["amount", { amount: "11" }, rpc(), /exceeds the app policy/],
    [
      "grace",
      { methodDetails: { gracePeriodSeconds: 3599 } },
      rpc(),
      /exceeds the app policy/,
    ],
    [
      "splits",
      {
        methodDetails: {
          distributionSplits: [{ recipient: FEE_PAYER, shareBps: 1 }],
        },
      },
      rpc(),
      /single challenge recipient/,
    ],
    [
      "operator",
      { methodDetails: { voucherSigner: "operator", operator: FEE_PAYER } },
      rpc(),
      /client-signed/,
    ],
    [
      "blockhash",
      {},
      rpc({ isBlockhashValid: async () => false }),
      /not valid/,
    ],
  ])(
    "refuses %s before wallet signing",
    async (_name, over, solanaRpc, message) => {
      const signer = wallet();
      const fetch = async () =>
        new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge(request(over)) },
        });
      const pay = createMppSessionFetch({
        rpc: solanaRpc,
        signer,
        keyManager: manager(),
        policy: policy(),
        fetch: fetch as typeof globalThis.fetch,
      });
      await expect(pay(URL_)).rejects.toThrow(message);
      expect(signer.seen).toHaveLength(0);
    },
  );

  it("applies the Token-2022 mint-extension screen before wallet signing", async () => {
    const base = rpc();
    const token2022 = new Uint8Array(170);
    token2022[44] = 6;
    token2022[45] = 1;
    token2022[165] = 1;
    new DataView(token2022.buffer).setUint16(166, 1, true);
    const solanaRpc = rpc({
      getAccountInfo: async (address) =>
        address === MINT
          ? { owner: SOLANA_PROGRAMS.token2022, data: token2022 }
          : base.getAccountInfo(address),
    });
    const signer = wallet();
    const fetch = async () =>
      new Response(null, {
        status: 402,
        headers: {
          "WWW-Authenticate": challenge(
            request({
              methodDetails: { tokenProgram: SOLANA_PROGRAMS.token2022 },
            }),
          ),
        },
      });
    const pay = createMppSessionFetch({
      rpc: solanaRpc,
      signer,
      keyManager: manager(),
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(pay(URL_)).rejects.toThrow(/TransferFeeConfig/);
    expect(signer.seen).toHaveLength(0);
  });

  it("uses only app-supplied broadcasting for forced close and exposes withdrawal", async () => {
    let channelId = "";
    const sent: Uint8Array[] = [];
    const fetch = async (input: RequestInfo | URL) => {
      const req = input as Request;
      if (!req.headers.has("Authorization")) {
        return new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge() },
        });
      }
      channelId = credential(req).payload.channelId as string;
      return new Response(null, {
        headers: { "Payment-Receipt": receipt(channelId) },
      });
    };
    const pay = createMppSessionFetch({
      rpc: rpc(),
      signer: wallet(),
      keyManager: manager(),
      policy: policy(),
      fetch: fetch as typeof globalThis.fetch,
      sendTransaction: async (tx) => {
        sent.push(tx);
        return `tx-${sent.length}`;
      },
    });
    await pay(URL_);
    const forced = await pay.forceClose();
    expect(forced.requestCloseTxHash).toBe("tx-1");
    await expect(forced.withdrawPayer()).resolves.toBe("tx-2");
    expect(sent).toHaveLength(2);
  });
});
