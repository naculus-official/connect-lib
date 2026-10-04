import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { SOLANA_MAINNET } from "../../constants";
import {
  associatedTokenAddress,
  parseSolanaTransaction,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
  verifySignedOwnerTransaction,
} from "../../solana-payment";
import { MemoryStorageAdapter } from "../../storage";
import {
  type SolanaSessionKeyScope,
  SolanaSessionKeyManager,
} from "../solana-session-keys";
import { bigintReviver } from "../storage";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAY_TO = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const OTHER = "3XZXfFJHF5ox3yPop16oqYfSWxLpkjsEuvTe2S67G2rj";
const FACILITATOR = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const OWNER_SEED = new Uint8Array(32).fill(7);
const OWNER = base58.encode(ed25519.getPublicKey(OWNER_SEED));

function rpc(genesis = MAINNET_GENESIS): SolanaPaymentRpc {
  const mint = new Uint8Array(82);
  mint[44] = 6;
  mint[45] = 1;
  return {
    getGenesisHash: async () => genesis,
    getLatestBlockhash: async () => BLOCKHASH,
    getAccountInfo: async (address) =>
      address === USDC ? { owner: SOLANA_PROGRAMS.token, data: mint } : null,
  };
}

function scope(
  over: Partial<SolanaSessionKeyScope> = {},
): SolanaSessionKeyScope {
  return {
    cluster: SOLANA_MAINNET,
    mint: USDC,
    budget: 1_000n,
    maxPerPayment: 400n,
    allowedRecipients: [PAY_TO],
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}

/** The owner's wallet: sign the owner's slot of `wire`. */
function ownerSigns(wire: Uint8Array, seed = OWNER_SEED): Uint8Array {
  const tx = parseSolanaTransaction(wire);
  const out = wire.slice();
  out.set(ed25519.sign(tx.message, seed), 1);
  return out;
}

function manager(adapter = new MemoryStorageAdapter(), encryptionKey = "k") {
  return new SolanaSessionKeyManager(
    { encryptionKey, pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true },
    adapter,
  );
}

async function activeKey(over: Partial<SolanaSessionKeyScope> = {}) {
  const adapter = new MemoryStorageAdapter();
  const m = manager(adapter);
  const info = await m.createSessionKey(scope(over), OWNER, rpc());
  const { transaction, recentBlockhash } = await m.prepareApproval(
    info.id,
    rpc(),
  );
  await m.attachApproval(info.id, ownerSigns(transaction), recentBlockhash);
  return { m, info, adapter };
}

const payment = (over = {}) => ({
  recipient: PAY_TO,
  amount: 300n,
  feePayer: FACILITATOR,
  memo: "0123456789abcdef0123456789abcdef",
  ...over,
});

describe("SolanaSessionKeyManager: approval", () => {
  it("creates a pending key and reads the mint", async () => {
    const m = manager();
    const info = await m.createSessionKey(scope(), OWNER, rpc());
    expect(info).toMatchObject({
      owner: OWNER,
      status: "pending",
      tokenProgram: SOLANA_PROGRAMS.token,
      decimals: 6,
      spent: 0n,
    });
    expect(base58.decode(info.address)).toHaveLength(32);
  });

  it("builds the owner's ApproveChecked for the budget, and activates on its signature", async () => {
    const m = manager();
    const info = await m.createSessionKey(scope(), OWNER, rpc());
    const { transaction, recentBlockhash } = await m.prepareApproval(
      info.id,
      rpc(),
    );
    const tx = parseSolanaTransaction(transaction);
    expect(tx.accountKeys[0]).toBe(OWNER);
    expect(tx.numRequiredSignatures).toBe(1);
    const [approve] = tx.instructions;
    expect(approve?.program).toBe(SOLANA_PROGRAMS.token);
    expect(approve?.accounts).toEqual([
      associatedTokenAddress(OWNER, USDC, SOLANA_PROGRAMS.token),
      USDC,
      info.address,
      OWNER,
    ]);
    // ApproveChecked: 13, amount 1000 u64 LE, decimals 6.
    expect([...(approve?.data ?? [])]).toEqual([
      13, 0xe8, 0x03, 0, 0, 0, 0, 0, 0, 6,
    ]);
    const signed = ownerSigns(transaction);
    await expect(
      m.attachApproval(info.id, signed, recentBlockhash),
    ).resolves.toBe(base64.encode(signed));
    expect((await m.listSessions())[0]?.status).toBe("active");
  });

  it("refuses an approval signed by someone else or for another amount", async () => {
    const m = manager();
    const info = await m.createSessionKey(scope(), OWNER, rpc());
    const { transaction, recentBlockhash } = await m.prepareApproval(
      info.id,
      rpc(),
    );
    await expect(
      m.attachApproval(
        info.id,
        ownerSigns(transaction, new Uint8Array(32).fill(8)),
        recentBlockhash,
      ),
    ).rejects.toThrow(/not signed by/);
    const tampered = transaction.slice();
    const at = tampered.length - 1 - 9; // amount's low byte in the data
    tampered[at] = (tampered[at] as number) + 1;
    await expect(
      m.attachApproval(info.id, ownerSigns(tampered), recentBlockhash),
    ).rejects.toThrow();
    expect((await m.listSessions())[0]?.status).toBe("pending");
  });

  it.each([
    ["no recipients", { allowedRecipients: [] }],
    ["the owner as recipient", { allowedRecipients: [OWNER] }],
    ["a per-payment limit above the budget", { maxPerPayment: 2_000n }],
    ["a past expiry", { expiry: 1 }],
    [
      "a lifetime beyond the maximum",
      { expiry: Math.floor(Date.now() / 1000) + 90 * 86400 },
    ],
    ["a bad cluster", { cluster: "solana:0" }],
  ])("refuses to create a key with %s", async (_name, over) => {
    await expect(
      manager().createSessionKey(scope(over), OWNER, rpc()),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses to create on an RPC for another cluster", async () => {
    await expect(
      manager().createSessionKey(
        scope(),
        OWNER,
        rpc("EtWTRABZaYq6iMfeYKouRu166VU2xqa1xxxxxxxxxxxx"),
      ),
    ).rejects.toMatchObject({ code: "chain_mismatch" });
  });
});

describe("SolanaSessionKeyManager: periodic usage", () => {
  it("enforces a period and resets at the next boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2033-05-18T03:33:20.000Z"));
    const start = Math.floor(Date.now() / 1000);
    const { m, info } = await activeKey({
      period: { amount: 500n, seconds: 10, start },
    });
    await m.signPayment(info.id, payment({ amount: 300n }), rpc());
    await expect(
      m.signPayment(info.id, payment({ amount: 201n }), rpc()),
    ).rejects.toThrow(/period limit/);
    vi.setSystemTime(new Date((start + 10) * 1_000));
    await expect(
      m.signPayment(info.id, payment({ amount: 300n }), rpc()),
    ).resolves.toBeTypeOf("string");
    vi.useRealTimers();
  });

  it("refuses malformed period records", async () => {
    const start = Math.floor(Date.now() / 1000) - 1;
    const { m, info, adapter } = await activeKey({
      period: { amount: 500n, seconds: 10, start },
    });
    const raw = await adapter.get<string>("solana_session_keys");
    const records = JSON.parse(
      typeof raw === "string" ? raw : JSON.stringify(raw),
    ) as Array<Record<string, unknown>>;
    const record = records.find((item) => item.id === info.id)!;
    record.periodIndex = "broken";
    record.periodSpent = { __bigint__: "0" };
    await adapter.set("solana_session_keys", JSON.stringify(records) as never);
    await expect(m.signPayment(info.id, payment(), rpc())).rejects.toThrow(
      /period usage is malformed/,
    );
  });

  it("keeps the legacy v1 scope binding byte-for-byte unchanged", async () => {
    const adapter = new MemoryStorageAdapter();
    const m = manager(adapter);
    const info = await m.createSessionKey(scope(), OWNER, rpc());
    const raw = await adapter.get<string>("solana_session_keys");
    const [stored] = JSON.parse(
      typeof raw === "string" ? raw : JSON.stringify(raw),
      bigintReviver,
    ) as Array<{
      id: string;
      address: string;
      owner: string;
      scope: SolanaSessionKeyScope;
      tokenProgram: string;
      decimals: number;
      keyPair: { publicKey: string };
    }>;
    const expected = `0x${bytesToHex(
      sha256(
        utf8ToBytes(
          JSON.stringify([
            "naculus-solana-session-key/v1",
            stored.id,
            stored.address,
            stored.owner,
            stored.scope.cluster,
            stored.scope.mint,
            stored.tokenProgram,
            stored.decimals,
            stored.scope.budget.toString(),
            stored.scope.maxPerPayment.toString(),
            stored.scope.allowedRecipients,
            stored.scope.expiry,
            stored.scope.maxTxCount ?? null,
          ]),
        ),
      ),
    )}`;
    expect(info.scope.period).toBeUndefined();
    expect(stored.keyPair.publicKey).toBe(expected);
  });
});

describe("SolanaSessionKeyManager: payments", () => {
  it("signs a delegated transfer from the owner's account, sponsored, and accounts it", async () => {
    const { m, info } = await activeKey();
    const transaction = await m.signPayment(info.id, payment(), rpc());
    const tx = parseSolanaTransaction(base64.decode(transaction));
    expect(tx.accountKeys[0]).toBe(FACILITATOR);
    expect(tx.signatures[0]?.every((b) => b === 0)).toBe(true);
    const slot = tx.accountKeys.indexOf(info.address);
    expect(
      ed25519.verify(
        tx.signatures[slot] as Uint8Array,
        tx.message,
        base58.decode(info.address),
      ),
    ).toBe(true);
    const transfer = tx.instructions[2];
    expect(transfer?.accounts).toEqual([
      associatedTokenAddress(OWNER, USDC, SOLANA_PROGRAMS.token),
      USDC,
      associatedTokenAddress(PAY_TO, USDC, SOLANA_PROGRAMS.token),
      info.address,
    ]);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    // The owner signs nothing here.
    expect(tx.accountKeys.includes(OWNER)).toBe(false);
    const [after] = await m.listSessions();
    expect(after).toMatchObject({ spent: 300n, useCount: 1 });
  });

  it.each([
    ["a recipient outside the scope", payment({ recipient: OTHER })],
    ["more than the per-payment limit", payment({ amount: 401n })],
    ["the owner as fee payer", payment({ feePayer: OWNER })],
  ])("refuses %s", async (_name, p) => {
    const { m, info } = await activeKey();
    await expect(m.signPayment(info.id, p, rpc())).rejects.toMatchObject({
      code: "session_scope_exceeded",
    });
    expect((await m.listSessions())[0]?.spent).toBe(0n);
  });

  it("refuses the key itself as fee payer", async () => {
    const { m, info } = await activeKey();
    await expect(
      m.signPayment(info.id, payment({ feePayer: info.address }), rpc()),
    ).rejects.toMatchObject({ code: "session_scope_exceeded" });
  });

  it("stops at the budget and at maxTxCount", async () => {
    const { m, info } = await activeKey({ maxTxCount: 5 });
    await m.signPayment(info.id, payment({ amount: 400n }), rpc());
    await m.signPayment(info.id, payment({ amount: 400n }), rpc());
    await expect(
      m.signPayment(info.id, payment({ amount: 201n }), rpc()),
    ).rejects.toThrow(/remaining budget/);
    await m.signPayment(info.id, payment({ amount: 200n }), rpc());

    const counted = await activeKey({ maxTxCount: 1 });
    await counted.m.signPayment(counted.info.id, payment(), rpc());
    await expect(
      counted.m.signPayment(counted.info.id, payment(), rpc()),
    ).rejects.toThrow(/maximum number/);
  });

  it("does not overspend when two payments race for the budget", async () => {
    const { m, info } = await activeKey();
    const results = await Promise.allSettled([
      m.signPayment(info.id, payment({ amount: 400n }), rpc()),
      m.signPayment(info.id, payment({ amount: 400n }), rpc()),
      m.signPayment(info.id, payment({ amount: 400n }), rpc()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await m.listSessions())[0]?.spent).toBe(800n);
  });

  it("signs nothing while pending, after revocation, or on another cluster", async () => {
    const m = manager();
    const pending = await m.createSessionKey(scope(), OWNER, rpc());
    await expect(m.signPayment(pending.id, payment(), rpc())).rejects.toThrow(
      /pending/,
    );

    const { m: m2, info } = await activeKey();
    await expect(
      m2.signPayment(
        info.id,
        payment(),
        rpc("EtWTRABZaYq6iMfeYKouRu166VU2xqa1xxxxxxxxxxxx"),
      ),
    ).rejects.toMatchObject({ code: "chain_mismatch" });
    const { transaction } = await m2.prepareRevocation(info.id, rpc());
    const revoke = parseSolanaTransaction(transaction);
    expect(revoke.accountKeys[0]).toBe(OWNER);
    expect([...(revoke.instructions[0]?.data ?? [])]).toEqual([5]);
    expect(revoke.instructions[0]?.accounts).toEqual([
      associatedTokenAddress(OWNER, USDC, SOLANA_PROGRAMS.token),
      OWNER,
    ]);
    await expect(m2.signPayment(info.id, payment(), rpc())).rejects.toThrow(
      /revoked/,
    );
  });

  it("keeps the private key encrypted at rest and needs the right password", async () => {
    const { info, adapter } = await activeKey();
    const raw = JSON.stringify(await adapter.get("solana_session_keys"));
    expect(raw).not.toMatch(/"secret"|"privateKey"/);
    // Another manager on the same storage signs with the right password…
    await expect(
      manager(adapter).signPayment(info.id, payment(), rpc()),
    ).resolves.toMatch(/^[A-Za-z0-9+/]+=*$/);
    // …and fails closed with a wrong one.
    await expect(
      manager(adapter, "wrong").signPayment(info.id, payment(), rpc()),
    ).rejects.toThrow();
  });
});

describe("SolanaSessionKeyManager: review follow-ups", () => {
  /** Re-encode `wire` with one more instruction (program appended read-only). */
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
    const ixs = [...tx.instructions, { program, accounts, data }];
    return new Uint8Array([
      tx.signatures.length,
      ...new Uint8Array(64 * tx.signatures.length),
      0x80,
      tx.numRequiredSignatures,
      tx.numReadonlySigned,
      tx.numReadonlyUnsigned + (keys.length - tx.accountKeys.length),
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
    ]);
  }

  it("refuses an approval the wallet extended with a transfer or a second approve", async () => {
    const m = manager();
    const info = await m.createSessionKey(scope(), OWNER, rpc());
    const { transaction, recentBlockhash } = await m.prepareApproval(
      info.id,
      rpc(),
    );
    const system = withInstruction(
      transaction,
      "11111111111111111111111111111111",
      [OWNER],
      new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
    );
    await expect(
      m.attachApproval(info.id, ownerSigns(system), recentBlockhash),
    ).rejects.toThrow(/added an instruction/);
    const tx = parseSolanaTransaction(transaction);
    const approve = tx.instructions[0]!;
    const twice = withInstruction(
      transaction,
      approve.program,
      approve.accounts,
      approve.data,
    );
    await expect(
      m.attachApproval(info.id, ownerSigns(twice), recentBlockhash),
    ).rejects.toThrow(/exactly one token instruction/);
    // A compute-budget instruction the wallet adds is fine.
    const priced = withInstruction(
      transaction,
      SOLANA_PROGRAMS.computeBudget,
      [],
      new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]),
    );
    await expect(
      m.attachApproval(info.id, ownerSigns(priced), recentBlockhash),
    ).resolves.toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("retires the previous key when the owner approves another for the same mint", async () => {
    const adapter = new MemoryStorageAdapter();
    const m = manager(adapter);
    const approve = async (id: string) => {
      const { transaction, recentBlockhash } = await m.prepareApproval(
        id,
        rpc(),
      );
      await m.attachApproval(id, ownerSigns(transaction), recentBlockhash);
    };
    const first = await m.createSessionKey(scope(), OWNER, rpc());
    await approve(first.id);
    const second = await m.createSessionKey(scope(), OWNER, rpc());
    await approve(second.id);
    const byId = new Map((await m.listSessions()).map((s) => [s.id, s.status]));
    expect(byId.get(first.id)).toBe("revoked");
    expect(byId.get(second.id)).toBe("active");
    await expect(m.signPayment(first.id, payment(), rpc())).rejects.toThrow(
      /revoked/,
    );
  });

  it("withholds the signature and the spend when saving fails", async () => {
    const { m, info, adapter } = await activeKey();
    const set = adapter.set.bind(adapter);
    adapter.set = async () => {
      throw new Error("quota");
    };
    await expect(m.signPayment(info.id, payment(), rpc())).rejects.toThrow(
      "quota",
    );
    adapter.set = set;
    expect((await m.listSessions())[0]?.spent).toBe(0n);
  });

  it("does not overspend across two managers sharing storage", async () => {
    const { info, adapter } = await activeKey();
    const a = manager(adapter);
    const b = manager(adapter);
    const results = await Promise.allSettled([
      a.signPayment(info.id, payment({ amount: 400n }), rpc()),
      b.signPayment(info.id, payment({ amount: 400n }), rpc()),
      a.signPayment(info.id, payment({ amount: 400n }), rpc()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await a.listSessions())[0]?.spent).toBe(800n);
  });

  it("refuses after expiry", async () => {
    const { m, info } = await activeKey({
      expiry: Math.floor(Date.now() / 1000) + 2,
    });
    const now = Date.now;
    Date.now = () => now() + 5_000;
    try {
      expect((await m.listSessions())[0]?.status).toBe("expired");
      await expect(m.signPayment(info.id, payment(), rpc())).rejects.toThrow(
        /expired/,
      );
    } finally {
      Date.now = now;
    }
  });

  it("works on a Token-2022 mint", async () => {
    const mint = new Uint8Array(82);
    mint[44] = 6;
    mint[45] = 1;
    const token2022: SolanaPaymentRpc = {
      ...rpc(),
      getAccountInfo: async () => ({
        owner: SOLANA_PROGRAMS.token2022,
        data: mint,
      }),
    };
    const m = manager();
    const info = await m.createSessionKey(scope(), OWNER, token2022);
    expect(info.tokenProgram).toBe(SOLANA_PROGRAMS.token2022);
    const { transaction, recentBlockhash } = await m.prepareApproval(
      info.id,
      token2022,
    );
    await m.attachApproval(info.id, ownerSigns(transaction), recentBlockhash);
    const tx = parseSolanaTransaction(
      base64.decode(await m.signPayment(info.id, payment(), token2022)),
    );
    expect(tx.instructions[2]?.program).toBe(SOLANA_PROGRAMS.token2022);
    expect(tx.instructions[2]?.accounts[0]).toBe(
      associatedTokenAddress(OWNER, USDC, SOLANA_PROGRAMS.token2022),
    );
  });

  it("checks the owner's signed revocation", async () => {
    const { m, info } = await activeKey();
    const { transaction, recentBlockhash } = await m.prepareRevocation(
      info.id,
      rpc(),
    );
    const revocation = {
      owner: OWNER,
      mint: USDC,
      tokenProgram: SOLANA_PROGRAMS.token,
      recentBlockhash,
    };
    expect(
      verifySignedOwnerTransaction(ownerSigns(transaction), {
        kind: "revoke",
        revocation,
      }),
    ).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(() =>
      verifySignedOwnerTransaction(
        ownerSigns(transaction, new Uint8Array(32).fill(8)),
        { kind: "revoke", revocation },
      ),
    ).toThrow(/not signed by/);
  });
});

describe("SolanaSessionKeyManager: record integrity", () => {
  it.each([
    [
      "an added recipient",
      (r: Record<string, any>) => r.scope.allowedRecipients.push(OTHER),
    ],
    [
      "a raised budget",
      (r: Record<string, any>) => (r.scope.budget = { __bigint__: "999999" }),
    ],
    ["a later expiry", (r: Record<string, any>) => (r.scope.expiry += 86400)],
    ["another owner", (r: Record<string, any>) => (r.owner = OTHER)],
  ])(
    "refuses to sign after %s is written into storage",
    async (_name, edit) => {
      const { m, info, adapter } = await activeKey();
      const raw = await adapter.get<unknown>("solana_session_keys");
      const records = JSON.parse(
        typeof raw === "string" ? raw : JSON.stringify(raw),
      );
      edit(records[0]);
      await adapter.set(
        "solana_session_keys",
        JSON.stringify(records) as never,
      );
      await expect(
        m.signPayment(info.id, payment({ recipient: PAY_TO }), rpc()),
      ).rejects.toThrow(/altered record/);
    },
  );

  it("refuses to prepare or attach an approval for a record altered before approval", async () => {
    const adapter = new MemoryStorageAdapter();
    const m = manager(adapter);
    const info = await m.createSessionKey(scope(), OWNER, rpc());
    const { transaction, recentBlockhash } = await m.prepareApproval(
      info.id,
      rpc(),
    );
    const raw = await adapter.get<unknown>("solana_session_keys");
    const records = JSON.parse(
      typeof raw === "string" ? raw : JSON.stringify(raw),
    );
    records[0].scope.budget = { __bigint__: "1000000" };
    await adapter.set("solana_session_keys", JSON.stringify(records) as never);
    await expect(m.prepareApproval(info.id, rpc())).rejects.toThrow(
      /altered record/,
    );
    await expect(
      m.attachApproval(info.id, ownerSigns(transaction), recentBlockhash),
    ).rejects.toThrow(/altered record/);
  });
});
