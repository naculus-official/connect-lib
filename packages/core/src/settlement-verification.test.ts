import { describe, expect, it } from "vitest";
import {
  type SettlementRpc,
  verifyChannelSettlement,
  verifyEip3009Settlement,
  verifySolanaTransferSettlement,
} from "./settlement-verification";

const from = "0xa441b865956a80b5ba6d2192f62f5e2d5e6a8325";
const to = "0xef4364fe4487353df46eb7c811d4fac78b856c7f";
const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const nonce =
  "0x23aa9fe671c271194902ab037ab163bc8c2d16a807f469aaa6d4c96ce5fc13f2";
const topicAddress = (address: string) =>
  `0x${"0".repeat(24)}${address.slice(2)}`;
const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const usedTopic =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

function rpc(values: Record<string, unknown>): SettlementRpc {
  return { request: async (method) => values[method] as never };
}

const evmReceipt = {
  status: "0x1",
  blockNumber: "0x281246c",
  // Read-only Base mainnet USDC transferWithAuthorization receipt captured
  // 2026-10-02: 0x2be2cb982f3ee84988c135ec1a61893178fa2b62088461e6afc95353538ce3fb.
  logs: [
    {
      address: token,
      topics: [transferTopic, topicAddress(from), topicAddress(to)],
      data: "0x7a120",
    },
    {
      address: token,
      topics: [usedTopic, topicAddress(from), nonce],
      data: "0x",
    },
  ],
};

describe("verifyEip3009Settlement", () => {
  const expected = {
    chainId: "eip155:8453",
    txHash:
      "0x2be2cb982f3ee84988c135ec1a61893178fa2b62088461e6afc95353538ce3fb",
    token,
    from,
    to,
    amount: 500_000n,
    nonce,
  };
  const call = (
    receipt: unknown = evmReceipt,
    extra: Record<string, unknown> = {},
  ) =>
    verifyEip3009Settlement(
      rpc({
        eth_chainId: "0x2105",
        eth_getTransactionReceipt: receipt,
        eth_blockNumber: "0x281246c",
        ...extra,
      }),
      expected,
    );

  it("verifies the transfer and authorization in one successful receipt", async () => {
    await expect(call()).resolves.toEqual({
      status: "verified",
      blockNumber: 42_017_900n,
    });
  });
  it.each([
    ["swapped recipient", { ...expected, to: from }],
    ["wrong amount", { ...expected, amount: 500_001n }],
    ["another payer", { ...expected, from: to }],
    ["another nonce", { ...expected, nonce: `0x${"55".repeat(32)}` }],
  ])("refuses %s", async (_name, changed) => {
    expect(
      (
        await verifyEip3009Settlement(
          rpc({
            eth_chainId: "0x2105",
            eth_getTransactionReceipt: evmReceipt,
            eth_blockNumber: "0x281246c",
          }),
          changed,
        )
      ).status,
    ).toBe("mismatch");
  });
  it("distinguishes pending, reverted, wrong chain and RPC errors", async () => {
    await expect(call(null)).resolves.toEqual({ status: "pending" });
    expect((await call({ ...evmReceipt, status: "0x0" })).status).toBe(
      "failed",
    );
    expect((await call(evmReceipt, { eth_chainId: "0x1" })).status).toBe(
      "mismatch",
    );
    expect(
      (
        await verifyEip3009Settlement(
          {
            request: async () => {
              throw new Error("offline");
            },
          },
          expected,
        )
      ).status,
    ).toBe("unavailable");
  });
});

const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpZZZZ";
const cluster = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const payer = "payer";
const recipient = "recipient";
const mint = "mint";
const balances = (owner: string, amount: string) => ({
  mint,
  owner,
  uiTokenAmount: { amount },
});
const solanaTx = {
  slot: 9,
  transaction: [
    btoa(String.fromCharCode(1, ...new Array(64).fill(0), 7, 8, 9)),
    "base64",
  ],
  meta: {
    err: null,
    preTokenBalances: [balances(payer, "100"), balances(recipient, "2")],
    postTokenBalances: [balances(payer, "89"), balances(recipient, "12")],
  },
};

describe("verifySolanaTransferSettlement", () => {
  const expected = {
    cluster,
    signature: "signature",
    mint,
    payer,
    signer: payer,
    recipient,
    amount: 10n,
  };
  const call = (tx: unknown = solanaTx, served = genesis) =>
    verifySolanaTransferSettlement(
      rpc({ getGenesisHash: served, getTransaction: tx }),
      expected,
    );
  it("verifies exact recipient and sufficient payer token deltas", async () => {
    await expect(call()).resolves.toEqual({ status: "verified", slot: 9n });
  });
  it.each([
    ["swapped recipient", { ...expected, recipient: payer }],
    ["wrong amount", { ...expected, amount: 11n }],
    ["another payer", { ...expected, payer: recipient }],
    [
      "message hash",
      { ...expected, signedMessageHash: `0x${"00".repeat(32)}` },
    ],
  ])("refuses %s", async (_name, changed) => {
    expect(
      (
        await verifySolanaTransferSettlement(
          rpc({ getGenesisHash: genesis, getTransaction: solanaTx }),
          changed,
        )
      ).status,
    ).toBe("mismatch");
  });
  it("distinguishes pending, failed, wrong cluster and RPC errors", async () => {
    await expect(call(null)).resolves.toEqual({ status: "pending" });
    expect(
      (
        await call({
          ...solanaTx,
          meta: { ...solanaTx.meta, err: { InstructionError: [0, "x"] } },
        })
      ).status,
    ).toBe("failed");
    expect((await call(solanaTx, "other")).status).toBe("mismatch");
    expect(
      (
        await verifySolanaTransferSettlement(
          {
            request: async () => {
              throw new Error("offline");
            },
          },
          expected,
        )
      ).status,
    ).toBe("unavailable");
  });
});

describe("verifyChannelSettlement", () => {
  const accountFor = (status: number, settled = 50n, withdrawnAt = 1n) => {
    const bytes = new Uint8Array(52);
    bytes[3] = status;
    new DataView(bytes.buffer).setBigUint64(20, settled, true);
    new DataView(bytes.buffer).setBigInt64(44, withdrawnAt, true);
    return {
      context: { slot: 12 },
      value: {
        owner: "program",
        data: [btoa(String.fromCharCode(...bytes)), "base64"],
      },
    };
  };
  const account = accountFor(3);
  const expected = {
    cluster,
    channelId: "channel",
    channelProgram: "program",
    expectedSettled: 50n,
  };
  it("verifies only exact distributed cooperative state", async () => {
    await expect(
      verifyChannelSettlement(
        rpc({ getGenesisHash: genesis, getAccountInfo: account }),
        expected,
      ),
    ).resolves.toEqual({ status: "verified", slot: 12n });
    for (const status of [0, 1, 2]) {
      expect(
        (
          await verifyChannelSettlement(
            rpc({
              getGenesisHash: genesis,
              getAccountInfo: accountFor(status),
            }),
            expected,
          )
        ).status,
      ).toBe("pending");
    }
  });
  it("verifies withdrawn forced closes when sealed or distributed", async () => {
    for (const status of [1, 3]) {
      for (const settled of [0n, 49n, 50n]) {
        await expect(
          verifyChannelSettlement(
            rpc({
              getGenesisHash: genesis,
              getAccountInfo: accountFor(status, settled),
            }),
            { ...expected, afterForcedClose: true },
          ),
        ).resolves.toMatchObject({ status: "verified" });
      }
    }
    expect(
      (
        await verifyChannelSettlement(
          rpc({ getGenesisHash: genesis, getAccountInfo: accountFor(2) }),
          { ...expected, afterForcedClose: true },
        )
      ).status,
    ).toBe("pending");
    expect(
      (
        await verifyChannelSettlement(
          rpc({ getGenesisHash: genesis, getAccountInfo: accountFor(0) }),
          { ...expected, afterForcedClose: true },
        )
      ).status,
    ).toBe("mismatch");
    expect(
      (
        await verifyChannelSettlement(
          rpc({ getGenesisHash: genesis, getAccountInfo: accountFor(1, 51n) }),
          { ...expected, afterForcedClose: true },
        )
      ).status,
    ).toBe("mismatch");
    expect(
      (
        await verifyChannelSettlement(
          rpc({
            getGenesisHash: genesis,
            getAccountInfo: accountFor(1, 50n, 0n),
          }),
          { ...expected, afterForcedClose: true },
        )
      ).status,
    ).toBe("pending");
  });
  it("refuses owner, amount and cluster mismatches; reclaimed accounts are unavailable", async () => {
    expect(
      (
        await verifyChannelSettlement(
          rpc({
            getGenesisHash: genesis,
            getAccountInfo: {
              ...account,
              value: { ...account.value, owner: "other" },
            },
          }),
          expected,
        )
      ).status,
    ).toBe("mismatch");
    expect(
      (
        await verifyChannelSettlement(
          rpc({ getGenesisHash: genesis, getAccountInfo: account }),
          { ...expected, expectedSettled: 51n },
        )
      ).status,
    ).toBe("mismatch");
    expect(
      (
        await verifyChannelSettlement(
          rpc({ getGenesisHash: "other", getAccountInfo: account }),
          expected,
        )
      ).status,
    ).toBe("mismatch");
    expect(
      (
        await verifyChannelSettlement(
          rpc({ getGenesisHash: genesis, getAccountInfo: { value: null } }),
          expected,
        )
      ).status,
    ).toBe("unavailable");
  });
});
