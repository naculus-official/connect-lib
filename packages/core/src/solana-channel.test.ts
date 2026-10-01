import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { SOLANA_DEVNET, SOLANA_MAINNET } from "./constants";
import {
  assertTrustedChannelProgram,
  buildOpenChannelTransaction,
  buildRequestCloseChannelTransaction,
  buildSealChannelTransaction,
  buildTopUpChannelTransaction,
  buildWithdrawPayerChannelTransaction,
  type ChannelMintAccount,
  deriveChannelPda,
  encodeChannelVoucher,
  type OpenChannelTransaction,
  SOLANA_CHANNEL_PROGRAM,
  signVoucher,
  TRUSTED_CHANNEL_PROGRAMS,
  verifySignedChannelOpen,
  verifyVoucher,
} from "./solana-channel";
import {
  parseSolanaTransaction,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
} from "./solana-payment";
import { compileV0 } from "./solana-wire";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

const VECTORS = [
  {
    payer: "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9",
    feePayer: "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu",
    payee: "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse",
    mint: "EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1",
    authorizedSigner: "8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe",
    channelId: "A9Vu2u6VyYrAeCdaqRZahNDeBrqhHRhmRVU67bEPdzFN",
    bump: 255,
    payerAta: "AS4agAYaHGkZ7qvSRkNeNjPcoricha1WhSko5qv28eLY",
    channelAta: "5EXtRi4bdkuSR7vp4spqr5LSJvrQPkkGCwmKndxECKgz",
    salt: 7n,
    openSlot: 123_456n,
    deposit: 999n,
    gracePeriod: 3_600,
    openData:
      "010700000000000000e703000000000000100e000040e201000000000000000000",
    topUpData: "03e703000000000000",
    sealMessage:
      "80010001038139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b39487e680bcf07ec5e48742853d68eb54b20f7c94610984bf9995d89a8e31d93ce5a7a1fba4eb2b090993f7d2dfd62b89e2b872077a639fd7d747a8e99f63d415aecc490e928cd2e3873bb343fc95da33179ca60f4dbf46c2c36e91299d55d4e6b901020101010600",
  },
  {
    payer: "7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9",
    feePayer: "mBKqcnGotbsSb5vNrdyhzZ5EhqZdids9QYiTRckvi7v",
    payee: "AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os",
    mint: "oapfTk8FG2np1vSoGANkbijWiQApHZMFAytSdCoass9",
    authorizedSigner: "FezWPm3UEFa4nbF76D45V3gg9eZzhSxfw3tUES1Gr3o1",
    channelId: "9Gue9G2aoFahqH9cbUtZwX99e7U4XoNMkPhN2edNiUSg",
    bump: 250,
    payerAta: "w1BfsFruQPGFWTohxiGaxWLpesjpUoTj9nE5gt25x4A",
    channelAta: "7M6iF6RCDvSQCyD21ePMBhrySpmcANeQ4mFt1ES3De5W",
    salt: 18_446_744_073_709_551_614n,
    openSlot: 480_232_051n,
    deposit: 123_456_789n,
    gracePeriod: 900,
    openData:
      "01feffffffffffffff15cd5b07000000008403000073c29f1c0000000000000000",
    topUpData: "0315cd5b0700000000",
    sealMessage:
      "80010001030b513ad9b4924015ca0902ed079044d3ac5dbec2306f06948c10da8eb6e39f2d7af0ba6cb6d6765a0614ee3c18f7c97544d1272a8141570ee226bbea99965c95a7a1fba4eb2b090993f7d2dfd62b89e2b872077a639fd7d747a8e99f63d415aecc490e928cd2e3873bb343fc95da33179ca60f4dbf46c2c36e91299d55d4e6b901020101010600",
  },
] as const;

function mintAccount(address: string = VECTORS[0].mint): ChannelMintAccount {
  const data = new Uint8Array(82);
  data[44] = 6;
  data[45] = 1;
  return { address, owner: SOLANA_PROGRAMS.token, data };
}

function open(
  overrides: Partial<OpenChannelTransaction> = {},
): OpenChannelTransaction {
  const vector = VECTORS[0];
  return {
    feePayer: vector.feePayer,
    payer: vector.payer,
    payee: vector.payee,
    mint: vector.mint,
    mintAccount: mintAccount(),
    authorizedSigner: vector.authorizedSigner,
    salt: vector.salt,
    openSlot: vector.openSlot,
    deposit: vector.deposit,
    gracePeriod: vector.gracePeriod,
    recentBlockhash: BLOCKHASH,
    ...overrides,
  };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function roles(
  tx: ReturnType<typeof parseSolanaTransaction>,
  accounts: readonly string[],
): number[] {
  return accounts.map((address) => {
    const index = tx.accountKeys.indexOf(address);
    const signer = index < tx.numRequiredSignatures;
    const writable = signer
      ? index < tx.numRequiredSignatures - tx.numReadonlySigned
      : index < tx.accountKeys.length - tx.numReadonlyUnsigned;
    return (signer ? 2 : 0) + (writable ? 1 : 0);
  });
}

function sign(
  wire: Uint8Array,
  seed = new Uint8Array(32).fill(1),
  address = VECTORS[0].payer,
): Uint8Array {
  const tx = parseSolanaTransaction(wire);
  const slot = tx.accountKeys.indexOf(address);
  const out = wire.slice();
  out.set(ed25519.sign(tx.message, seed), 1 + 64 * slot);
  return out;
}

function withInstruction(
  wire: Uint8Array,
  program: string,
  accounts: string[] = [],
  data = new Uint8Array([9]),
): Uint8Array {
  const tx = parseSolanaTransaction(wire);
  const metas = accounts.map((address) => ({
    address,
    signer: false,
    writable: false,
  }));
  const rebuilt = compileV0(
    tx.accountKeys[0] as string,
    [
      ...tx.instructions.map((ix) => ({
        program: ix.program,
        accounts: ix.accounts.map((address) => ({
          address,
          signer: tx.accountKeys.indexOf(address) < tx.numRequiredSignatures,
          writable:
            tx.accountKeys.indexOf(address) < tx.numRequiredSignatures
              ? tx.accountKeys.indexOf(address) <
                tx.numRequiredSignatures - tx.numReadonlySigned
              : tx.accountKeys.indexOf(address) <
                tx.accountKeys.length - tx.numReadonlyUnsigned,
        })),
        data: ix.data,
      })),
      { program, accounts: metas, data },
    ],
    tx.recentBlockhash,
  );
  return sign(rebuilt);
}

describe("Solana payment-channel vectors", () => {
  it.each(VECTORS)(
    "matches @solana/mpp@0.7.0 PDA and instruction bytes ($channelId)",
    (vector) => {
      const derived = deriveChannelPda({
        payer: vector.payer,
        payee: vector.payee,
        mint: vector.mint,
        authorizedSigner: vector.authorizedSigner,
        salt: vector.salt,
        openSlot: vector.openSlot,
      });
      expect(derived).toEqual({
        channelId: vector.channelId,
        bump: vector.bump,
      });

      const input = open({
        feePayer: vector.feePayer,
        payer: vector.payer,
        payee: vector.payee,
        mint: vector.mint,
        mintAccount: mintAccount(vector.mint),
        authorizedSigner: vector.authorizedSigner,
        salt: vector.salt,
        openSlot: vector.openSlot,
        deposit: vector.deposit,
        gracePeriod: vector.gracePeriod,
      });
      const openTx = parseSolanaTransaction(buildOpenChannelTransaction(input));
      const openIx = openTx.instructions[0];
      expect(openIx?.accounts).toEqual([
        vector.payer,
        vector.feePayer,
        vector.payee,
        vector.mint,
        vector.authorizedSigner,
        vector.channelId,
        vector.payerAta,
        vector.channelAta,
        SOLANA_PROGRAMS.token,
        "11111111111111111111111111111111",
        "SysvarRent111111111111111111111111111111111",
        SOLANA_PROGRAMS.associatedToken,
        "75c2huVzDW1Eq4kD86by5392sjdJzuAT195XNgP2f2tX",
        SOLANA_CHANNEL_PROGRAM,
      ]);
      expect(roles(openTx, openIx?.accounts ?? [])).toEqual([
        3, 3, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0,
      ]);
      expect(hex(openIx?.data ?? new Uint8Array())).toBe(vector.openData);

      const common = {
        feePayer: vector.feePayer,
        payer: vector.payer,
        channelId: vector.channelId,
        mintAccount: mintAccount(vector.mint),
        recentBlockhash: BLOCKHASH,
      };
      const topUpTx = parseSolanaTransaction(
        buildTopUpChannelTransaction({ ...common, amount: vector.deposit }),
      );
      const topUp = topUpTx.instructions[0];
      expect(topUp?.accounts).toEqual([
        vector.payer,
        vector.channelId,
        vector.payerAta,
        vector.channelAta,
        vector.mint,
        SOLANA_PROGRAMS.token,
      ]);
      expect(roles(topUpTx, topUp?.accounts ?? [])).toEqual([3, 1, 1, 1, 0, 0]);
      expect(hex(topUp?.data ?? new Uint8Array())).toBe(vector.topUpData);

      const closeTx = parseSolanaTransaction(
        buildRequestCloseChannelTransaction(common),
      );
      const close = closeTx.instructions[0];
      expect(close).toMatchObject({
        accounts: [vector.payer, vector.channelId],
        data: new Uint8Array([5]),
      });
      expect(roles(closeTx, close?.accounts ?? [])).toEqual([2, 1]);

      const sealWire = buildSealChannelTransaction({
        programAddress: SOLANA_CHANNEL_PROGRAM,
        feePayer: vector.feePayer,
        channelId: vector.channelId,
        recentBlockhash: BLOCKHASH,
      });
      const sealTx = parseSolanaTransaction(sealWire);
      const seal = sealTx.instructions[0];
      expect(hex(sealTx.message)).toBe(vector.sealMessage);
      expect(sealTx.instructions).toHaveLength(1);
      expect(seal).toMatchObject({
        program: SOLANA_CHANNEL_PROGRAM,
        accounts: [vector.channelId],
        data: new Uint8Array([6]),
      });
      expect(roles(sealTx, seal?.accounts ?? [])).toEqual([1]);

      const withdrawTx = parseSolanaTransaction(
        buildWithdrawPayerChannelTransaction(common),
      );
      const withdraw = withdrawTx.instructions[0];
      expect(withdraw).toMatchObject({
        accounts: [
          vector.payer,
          vector.channelId,
          vector.channelAta,
          vector.payerAta,
          vector.mint,
          SOLANA_PROGRAMS.token,
        ],
        data: new Uint8Array([8]),
      });
      expect(roles(withdrawTx, withdraw?.accounts ?? [])).toEqual([
        2, 1, 1, 1, 0, 0,
      ]);
    },
  );

  it("runs Token-2022 mints through the existing extension screen", () => {
    const data = new Uint8Array(170);
    data[44] = 6;
    data[45] = 1;
    data[165] = 1;
    data[166] = 1; // TransferFeeConfig
    expect(() =>
      buildOpenChannelTransaction(
        open({
          mintAccount: {
            address: VECTORS[0].mint,
            owner: SOLANA_PROGRAMS.token2022,
            data,
          },
        }),
      ),
    ).toThrow(/TransferFeeConfig/);
  });
});

describe("channel vouchers", () => {
  const voucher = {
    channelId: VECTORS[0].channelId,
    cumulativeAmount: 0x0102_0304_0506_0708n,
    expiresAt: 1_700_000_000n,
  };
  const seed = new Uint8Array(32).fill(21);
  const signer = base58.encode(ed25519.getPublicKey(seed));

  it("encodes the canonical 50-byte layout and signs only that encoding", () => {
    const encoded = encodeChannelVoucher(voucher);
    expect(encoded).toHaveLength(50);
    expect(encoded.slice(0, 2)).toEqual(new Uint8Array([0x56, 0x01]));
    expect(hex(encoded.slice(34, 42))).toBe("0807060504030201");
    expect(hex(encoded.slice(42))).toBe("00f1536500000000");
    const signature = signVoucher(seed, voucher);
    expect(signature).toEqual(ed25519.sign(encoded, seed));
    expect(verifyVoucher(signature, signer, voucher)).toBe(true);
    expect(
      verifyVoucher(signature, signer, {
        ...voucher,
        cumulativeAmount: voucher.cumulativeAmount + 1n,
      }),
    ).toBe(false);
  });

  it("refuses values outside the wire ranges", () => {
    expect(() =>
      encodeChannelVoucher({ ...voucher, cumulativeAmount: -1n }),
    ).toThrow(/u64/);
    expect(() =>
      encodeChannelVoucher({ ...voucher, expiresAt: 1n << 63n }),
    ).toThrow(/i64/);
    expect(() => signVoucher(new Uint8Array(31), voucher)).toThrow(/32 bytes/);
  });
});

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

function trustedRpc(
  mutate: (
    accounts: Map<string, { owner: string; data: Uint8Array }>,
  ) => void = () => {},
  genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
): SolanaPaymentRpc {
  const trust = TRUSTED_CHANNEL_PROGRAMS[SOLANA_MAINNET] as NonNullable<
    (typeof TRUSTED_CHANNEL_PROGRAMS)[string]
  >;
  const accounts = new Map([
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
  mutate(accounts);
  return {
    getGenesisHash: async () => genesis,
    getLatestBlockhash: async () => BLOCKHASH,
    getAccountInfo: async (address) => accounts.get(address) ?? null,
  };
}

describe("assertTrustedChannelProgram", () => {
  it("accepts the reviewed deployment and an explicit complete pin", async () => {
    const trusted = TRUSTED_CHANNEL_PROGRAMS[SOLANA_MAINNET] as NonNullable<
      (typeof TRUSTED_CHANNEL_PROGRAMS)[string]
    >;
    await expect(
      assertTrustedChannelProgram(trustedRpc(), SOLANA_MAINNET),
    ).resolves.toEqual(trusted);
    await expect(
      assertTrustedChannelProgram(trustedRpc(), SOLANA_MAINNET, trusted),
    ).resolves.toEqual(trusted);
  });

  it("records the independently read devnet deployment pin", () => {
    expect(TRUSTED_CHANNEL_PROGRAMS[SOLANA_DEVNET]).toEqual({
      address: SOLANA_CHANNEL_PROGRAM,
      programData: "CghQXkmw2F6p1exMETiZdNeUx9QGraWsNZ4eom1Cuiw1",
      lastDeployedSlot: 480_232_051n,
      upgradeAuthority: "4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap",
    });
  });

  it("refuses a cluster mismatch or unknown cluster", async () => {
    await expect(
      assertTrustedChannelProgram(trustedRpc(), SOLANA_DEVNET),
    ).rejects.toThrow(/serves solana:/);
    const unknownGenesis = "111111111111111111111111111111112222";
    const unknown = unknownGenesis.slice(0, 32);
    await expect(
      assertTrustedChannelProgram(
        trustedRpc(() => {}, unknownGenesis),
        `solana:${unknown}`,
      ),
    ).rejects.toThrow(/No channel program is trusted/);
  });

  it.each([
    [
      "missing program",
      (a: Map<string, unknown>) => a.delete(SOLANA_CHANNEL_PROGRAM),
      /program account is missing/,
    ],
    [
      "wrong program owner",
      (a: Map<string, { owner: string }>) => {
        const v = a.get(SOLANA_CHANNEL_PROGRAM);
        if (v) v.owner = VECTORS[0].payee;
      },
      /not owned by the upgradeable loader/,
    ],
    [
      "wrong ProgramData address",
      (a: Map<string, { data: Uint8Array }>) => {
        const v = a.get(SOLANA_CHANNEL_PROGRAM);
        if (v) v.data = programAccount(VECTORS[0].payee);
      },
      /different ProgramData/,
    ],
    [
      "missing ProgramData",
      (a: Map<string, unknown>) =>
        a.delete(
          (TRUSTED_CHANNEL_PROGRAMS[SOLANA_MAINNET] as Trusted).programData,
        ),
      /ProgramData account is missing/,
    ],
    [
      "wrong ProgramData owner",
      (a: Map<string, { owner: string }>) => {
        const v = a.get(
          (TRUSTED_CHANNEL_PROGRAMS[SOLANA_MAINNET] as Trusted).programData,
        );
        if (v) v.owner = VECTORS[0].payee;
      },
      /ProgramData is not owned/,
    ],
    [
      "changed slot",
      (a: AccountMap) => {
        const t = TRUSTED_CHANNEL_PROGRAMS[SOLANA_MAINNET] as Trusted;
        const v = a.get(t.programData);
        if (v)
          v.data = programDataAccount(
            t.lastDeployedSlot + 1n,
            t.upgradeAuthority,
          );
      },
      /redeployed/,
    ],
    [
      "changed authority",
      (a: AccountMap) => {
        const t = TRUSTED_CHANNEL_PROGRAMS[SOLANA_MAINNET] as Trusted;
        const v = a.get(t.programData);
        if (v)
          v.data = programDataAccount(t.lastDeployedSlot, VECTORS[0].payee);
      },
      /authority changed/,
    ],
    [
      "immutable ProgramData",
      (a: AccountMap) => {
        const t = TRUSTED_CHANNEL_PROGRAMS[SOLANA_MAINNET] as Trusted;
        const v = a.get(t.programData);
        if (v) {
          v.data = programDataAccount(t.lastDeployedSlot, t.upgradeAuthority);
          v.data[12] = 0;
        }
      },
      /no pinned upgrade authority/,
    ],
  ] as const)("refuses %s", async (_name, mutate, message) => {
    await expect(
      assertTrustedChannelProgram(trustedRpc(mutate as never), SOLANA_MAINNET),
    ).rejects.toThrow(message);
  });
});

type Trusted = NonNullable<(typeof TRUSTED_CHANNEL_PROGRAMS)[string]>;
type AccountMap = Map<string, { owner: string; data: Uint8Array }>;

describe("verifySignedChannelOpen", () => {
  it("accepts the exact open and trailing Lighthouse assertions", () => {
    const exact = sign(buildOpenChannelTransaction(open()));
    expect(() => verifySignedChannelOpen(exact, open())).not.toThrow();
    const lighthouse = withInstruction(
      buildOpenChannelTransaction(open()),
      LIGHTHOUSE,
      [VECTORS[0].payer],
    );
    expect(() => verifySignedChannelOpen(lighthouse, open())).not.toThrow();
  });

  it("refuses a missing or invalid payer signature", () => {
    const unsigned = buildOpenChannelTransaction(open());
    expect(() => verifySignedChannelOpen(unsigned, open())).toThrow(
      /not signed/,
    );
    const wrong = sign(unsigned, new Uint8Array(32).fill(2));
    expect(() => verifySignedChannelOpen(wrong, open())).toThrow(/not signed/);
  });

  it("refuses changes to every pinned open field", () => {
    const cases: OpenChannelTransaction[] = [
      open({ feePayer: VECTORS[0].payer }),
      open({ recentBlockhash: VECTORS[0].authorizedSigner }),
      open({ payee: VECTORS[0].authorizedSigner }),
      open({ deposit: VECTORS[0].deposit + 1n }),
      open({ authorizedSigner: VECTORS[0].payee }),
      open({ salt: VECTORS[0].salt + 1n }),
      open({ openSlot: VECTORS[0].openSlot + 1n }),
      open({ gracePeriod: VECTORS[0].gracePeriod + 1 }),
    ];
    for (const changed of cases) {
      expect(() =>
        verifySignedChannelOpen(
          sign(buildOpenChannelTransaction(changed)),
          open(),
        ),
      ).toThrow();
    }
  });

  it("refuses non-Lighthouse additions and changed permissions", () => {
    const foreign = withInstruction(
      buildOpenChannelTransaction(open()),
      SOLANA_PROGRAMS.memo,
    );
    expect(() => verifySignedChannelOpen(foreign, open())).toThrow(
      /added an instruction/,
    );

    const unsigned = buildOpenChannelTransaction(open());
    const tx = parseSolanaTransaction(unsigned);
    const changed = unsigned.slice();
    const header = 1 + tx.signatures.length * 64;
    changed[header + 3] = (changed[header + 3] as number) - 1;
    const resigned = sign(changed);
    expect(() => verifySignedChannelOpen(resigned, open())).toThrow(
      /account permissions/,
    );
  });
});
