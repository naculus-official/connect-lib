import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { SOLANA_MAINNET } from "./constants";
import {
  assertSolanaCluster,
  associatedTokenAddress,
  buildSplTransferTransaction,
  parseSolanaTransaction,
  readMint,
  SOLANA_PROGRAMS,
  type SplTransferPayment,
  solanaPaymentRpc,
  verifySignedSplTransfer,
} from "./solana-payment";

/**
 * Vectors from @solana/kit 8 and @solana-program/token (outside vitest, where
 * the build was also decoded, decompiled and re-signed by kit).
 */
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAY_TO = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const SEED = new Uint8Array(32).fill(7);
const PAYER = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"; // kit, from SEED
const FACILITATOR = base58.encode(
  ed25519.getPublicKey(new Uint8Array(32).fill(9)),
);

function payment(over: Partial<SplTransferPayment> = {}): SplTransferPayment {
  return {
    feePayer: FACILITATOR,
    authority: PAYER,
    mint: USDC,
    tokenProgram: SOLANA_PROGRAMS.token,
    decimals: 6,
    recipient: PAY_TO,
    amount: 1000n,
    memo: "pi_3abc123def456",
    recentBlockhash: BLOCKHASH,
    ...over,
  };
}

/** Sign `wire` with `seed`'s key, into the signature slot of `address`. */
function sign(wire: Uint8Array, seed = SEED, address = PAYER): Uint8Array {
  const tx = parseSolanaTransaction(wire);
  const slot = tx.accountKeys.indexOf(address);
  const out = wire.slice();
  out.set(ed25519.sign(tx.message, seed), 1 + 64 * slot);
  return out;
}

/**
 * What a wallet like Phantom does: re-encode the message with one more
 * instruction (its program appended as a read-only account), then sign.
 */
function withInstruction(
  wire: Uint8Array,
  program: string,
  accounts: string[],
  data: Uint8Array,
): Uint8Array {
  const tx = parseSolanaTransaction(wire);
  const keys = tx.accountKeys.includes(program)
    ? tx.accountKeys
    : [...tx.accountKeys, program];
  const extra = keys.length - tx.accountKeys.length;
  const ixs = [...tx.instructions, { program, accounts, data }];
  const bytes: number[] = [
    0x80,
    tx.numRequiredSignatures,
    tx.numReadonlySigned,
    tx.numReadonlyUnsigned + extra,
    keys.length,
    ...keys.flatMap((k) => [...base58.decode(k)]),
    ...base58.decode(tx.recentBlockhash),
    ixs.length,
    ...ixs.flatMap((ix) => [
      keys.indexOf(ix.program),
      ix.accounts.length,
      ...ix.accounts.map((a) => keys.indexOf(a)),
      ix.data.length,
      ...ix.data,
    ]),
    0,
  ];
  const out = new Uint8Array([
    tx.signatures.length,
    ...new Uint8Array(64 * tx.signatures.length),
    ...bytes,
  ]);
  return sign(out);
}

describe("associatedTokenAddress", () => {
  it("matches @solana-program/token for both token programs", () => {
    expect(ed25519.getPublicKey(SEED)).toEqual(base58.decode(PAYER));
    expect(associatedTokenAddress(PAY_TO, USDC, SOLANA_PROGRAMS.token)).toBe(
      "3XZXfFJHF5ox3yPop16oqYfSWxLpkjsEuvTe2S67G2rj",
    );
    expect(
      associatedTokenAddress(PAY_TO, USDC, SOLANA_PROGRAMS.token2022),
    ).toBe("H7BrdQ48x8XkXh3UXs7pvPxxF8Z5Ej1WyBwU2ZryzTBL");
  });
});

describe("buildSplTransferTransaction", () => {
  it("builds the four instructions both specs ask for, fee payer first", () => {
    const tx = parseSolanaTransaction(buildSplTransferTransaction(payment()));
    expect(tx.accountKeys[0]).toBe(FACILITATOR);
    expect(tx.numRequiredSignatures).toBe(2);
    expect(tx.numReadonlySigned).toBe(1);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    const [limit, price, transfer, memo] = tx.instructions;
    expect(limit).toMatchObject({ program: SOLANA_PROGRAMS.computeBudget });
    expect([...(limit?.data ?? [])]).toEqual([2, 0x40, 0x9c, 0, 0]);
    expect([...(price?.data ?? [])]).toEqual([3, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(transfer?.program).toBe(SOLANA_PROGRAMS.token);
    expect(transfer?.accounts).toEqual([
      associatedTokenAddress(PAYER, USDC, SOLANA_PROGRAMS.token),
      USDC,
      "3XZXfFJHF5ox3yPop16oqYfSWxLpkjsEuvTe2S67G2rj",
      PAYER,
    ]);
    // TransferChecked: 12, amount u64 LE, decimals.
    expect([...(transfer?.data ?? [])]).toEqual([
      12, 0xe8, 0x03, 0, 0, 0, 0, 0, 0, 6,
    ]);
    expect(new TextDecoder().decode(memo?.data)).toBe("pi_3abc123def456");
  });

  it("makes the payer the only signer when it pays its own fee", () => {
    const tx = parseSolanaTransaction(
      buildSplTransferTransaction(payment({ feePayer: PAYER, memo: null })),
    );
    expect(tx.accountKeys[0]).toBe(PAYER);
    expect(tx.numRequiredSignatures).toBe(1);
    expect(tx.instructions).toHaveLength(3);
  });

  it.each([
    ["a zero amount", { amount: 0n }],
    ["an amount above u64", { amount: 1n << 64n }],
    ["a non-token program", { tokenProgram: SOLANA_PROGRAMS.memo }],
    ["a payer paying itself", { recipient: PAYER }],
    ["a bad address", { mint: "not-base58!" }],
    ["an empty memo", { memo: "" }],
    ["a fee payer that is the recipient's account", { feePayer: USDC }],
  ])("refuses %s", (_name, over) => {
    expect(() =>
      buildSplTransferTransaction(payment(over as Partial<SplTransferPayment>)),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });
});

describe("verifySignedSplTransfer", () => {
  it("accepts the transaction signed by the payer and returns base64", () => {
    const signed = sign(buildSplTransferTransaction(payment()));
    expect(verifySignedSplTransfer(signed, payment())).toBe(
      base64.encode(signed),
    );
  });

  it("requires the payer's signature, and the fee payer's when self-funded", () => {
    const wire = buildSplTransferTransaction(payment());
    expect(() => verifySignedSplTransfer(wire, payment())).toThrow(
      /not signed by/,
    );
    const other = sign(wire, new Uint8Array(32).fill(8));
    expect(() => verifySignedSplTransfer(other, payment())).toThrow();
    const self = payment({ feePayer: PAYER });
    expect(
      verifySignedSplTransfer(sign(buildSplTransferTransaction(self)), self),
    ).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("refuses a transaction built for a different payment", () => {
    const signed = sign(buildSplTransferTransaction(payment()));
    for (const over of [
      { amount: 999n },
      { recipient: FACILITATOR },
      { memo: "other" },
      { recentBlockhash: PAY_TO },
      { tokenProgram: SOLANA_PROGRAMS.token2022 },
    ]) {
      expect(() => verifySignedSplTransfer(signed, payment(over))).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
  });

  it("accepts a wallet-added Lighthouse assertion unless told not to", () => {
    const wire = buildSplTransferTransaction(payment());
    const source = associatedTokenAddress(PAYER, USDC, SOLANA_PROGRAMS.token);
    const lighthouse = withInstruction(
      wire,
      SOLANA_PROGRAMS.lighthouse,
      [source],
      new Uint8Array([1, 2, 3]),
    );
    expect(parseSolanaTransaction(lighthouse).instructions).toHaveLength(5);
    expect(verifySignedSplTransfer(lighthouse, payment())).toBe(
      base64.encode(lighthouse),
    );
    expect(() =>
      verifySignedSplTransfer(lighthouse, payment(), {
        allowLighthouse: false,
      }),
    ).toThrow(/added an instruction/);
    // Any other program is refused either way.
    const system = withInstruction(
      wire,
      "11111111111111111111111111111111",
      [PAYER, source],
      new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
    );
    expect(() => verifySignedSplTransfer(system, payment())).toThrow(
      /added an instruction/,
    );
  });

  it("builds and verifies a Token-2022 payment", () => {
    const p = payment({ tokenProgram: SOLANA_PROGRAMS.token2022, memo: null });
    const tx = parseSolanaTransaction(buildSplTransferTransaction(p));
    expect(tx.instructions[2]?.program).toBe(SOLANA_PROGRAMS.token2022);
    expect(tx.instructions[2]?.accounts[2]).toBe(
      "H7BrdQ48x8XkXh3UXs7pvPxxF8Z5Ej1WyBwU2ZryzTBL",
    );
    const signed = sign(buildSplTransferTransaction(p));
    expect(verifySignedSplTransfer(signed, p)).toBe(base64.encode(signed));
  });

  it("refuses legacy messages, trailing bytes and lookup tables", () => {
    const signed = sign(buildSplTransferTransaction(payment()));
    const legacy = signed.slice();
    legacy[1 + 128] = 2; // the version byte becomes a legacy header byte
    expect(() => parseSolanaTransaction(legacy)).toThrow(/v0/);
    expect(() =>
      parseSolanaTransaction(new Uint8Array([...signed, 0])),
    ).toThrow(/trailing/);
    const withTable = signed.slice();
    withTable[withTable.length - 1] = 1;
    expect(() => parseSolanaTransaction(withTable)).toThrow();
  });
});

describe("readMint", () => {
  const mint = new Uint8Array(82);
  mint[44] = 6;
  mint[45] = 1;

  it("reads the decimals of an SPL Token or Token-2022 mint", () => {
    expect(readMint(SOLANA_PROGRAMS.token, mint)).toEqual({
      tokenProgram: SOLANA_PROGRAMS.token,
      decimals: 6,
    });
    expect(readMint(SOLANA_PROGRAMS.token2022, mint).decimals).toBe(6);
  });

  it("refuses another owner or an uninitialized account", () => {
    expect(() => readMint(SOLANA_PROGRAMS.memo, mint)).toThrow(/not a token/);
    expect(() => readMint(SOLANA_PROGRAMS.token, new Uint8Array(82))).toThrow(
      /not an initialized mint/,
    );
  });
});

describe("solanaPaymentRpc", () => {
  it("reads the blockhash and account info over JSON-RPC", async () => {
    const calls: string[] = [];
    const rpc = solanaPaymentRpc("https://rpc.invalid", (async (
      _url: string,
      init: RequestInit,
    ) => {
      const body = JSON.parse(init.body as string);
      calls.push(body.method);
      const result =
        body.method === "getGenesisHash"
          ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
          : body.method === "getLatestBlockhash"
            ? { value: { blockhash: BLOCKHASH } }
            : {
                value: {
                  owner: SOLANA_PROGRAMS.token,
                  data: ["AAE=", "base64"],
                },
              };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      );
    }) as typeof fetch);
    await expect(rpc.getLatestBlockhash()).resolves.toBe(BLOCKHASH);
    await expect(rpc.getAccountInfo(USDC)).resolves.toEqual({
      owner: SOLANA_PROGRAMS.token,
      data: new Uint8Array([0, 1]),
    });
    await expect(assertSolanaCluster(rpc, SOLANA_MAINNET)).resolves.toBe(
      undefined,
    );
    await expect(
      assertSolanaCluster(rpc, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"),
    ).rejects.toMatchObject({ code: "chain_mismatch" });
    expect(calls).toEqual([
      "getLatestBlockhash",
      "getAccountInfo",
      "getGenesisHash",
      "getGenesisHash",
    ]);
  });
});
