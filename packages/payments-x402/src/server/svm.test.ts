import {
  associatedTokenAddress,
  buildSplTransferTransaction,
  parseSolanaTransaction,
  SOLANA_MAINNET,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
  type SplTransferPayment,
} from "@naculus/connect-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  createX402Fetch,
  decodeHeader,
  encodeHeader,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type X402PaymentRequirements,
  type X402SolanaSigner,
} from "../index";
import {
  memorySettlementStore,
  requirePayment,
  settlePayment,
  verifyPayment,
  X402_MAX_COMPUTE_UNIT_PRICE,
  type X402ServerDeps,
} from "./index";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAY_TO = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const OTHER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const URL_ = "https://example.com/weather";
const PAYER_SEED = new Uint8Array(32).fill(7);
const FEE_SEED = new Uint8Array(32).fill(5);
const PAYER = base58.encode(ed25519.getPublicKey(PAYER_SEED));
const FEE_PAYER = base58.encode(ed25519.getPublicKey(FEE_SEED));
const MEMO = "pi_3abc123def456";
const TOKEN = SOLANA_PROGRAMS.token;

function requirement(
  over: Partial<X402PaymentRequirements> = {},
): X402PaymentRequirements {
  return {
    scheme: "exact",
    network: SOLANA_MAINNET,
    amount: "1000",
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { feePayer: FEE_PAYER, memo: MEMO },
    ...over,
  };
}

function tokenAccount(mint: string, owner: string, amount: bigint, state = 1) {
  const data = new Uint8Array(165);
  data.set(base58.decode(mint), 0);
  data.set(base58.decode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = state;
  return { owner: TOKEN, data };
}

interface ChainOptions {
  genesis?: string;
  balance?: bigint;
  sourceOwner?: string;
  noDestination?: boolean;
  simulationError?: unknown;
}

/** A cluster with USDC, the payer's funded account and the payee's. */
function cluster(options: ChainOptions = {}) {
  const mint = new Uint8Array(82);
  mint[44] = 6;
  mint[45] = 1;
  const sent: string[] = [];
  const simulated: string[] = [];
  const accounts = new Map<string, { owner: string; data: Uint8Array }>([
    [USDC, { owner: TOKEN, data: mint }],
    [
      associatedTokenAddress(PAYER, USDC, TOKEN),
      tokenAccount(
        USDC,
        options.sourceOwner ?? PAYER,
        options.balance ?? 1_000_000n,
      ),
    ],
  ]);
  if (!options.noDestination) {
    accounts.set(
      associatedTokenAddress(PAY_TO, USDC, TOKEN),
      tokenAccount(USDC, PAY_TO, 0n),
    );
  }
  const rpc: Required<SolanaPaymentRpc> = {
    getGenesisHash: async () => options.genesis ?? MAINNET_GENESIS,
    getLatestBlockhash: async () => BLOCKHASH,
    getAccountInfo: async (address) => accounts.get(address) ?? null,
    simulateTransaction: async (tx) => {
      simulated.push(tx);
      return { err: options.simulationError ?? null };
    },
    sendTransaction: async (tx) => {
      sent.push(tx);
      const parsed = parseSolanaTransaction(base64.decode(tx));
      return base58.encode(parsed.signatures[0] as Uint8Array);
    },
  };
  return { rpc, sent, simulated };
}

/** The facilitator's key, kept by the caller: signs slot 0. */
async function signAsFeePayer(wire: Uint8Array): Promise<Uint8Array> {
  const tx = parseSolanaTransaction(wire);
  const out = wire.slice();
  out.set(ed25519.sign(tx.message, FEE_SEED), 1);
  return out;
}

function deps(over: Partial<X402ServerDeps> = {}): X402ServerDeps {
  return {
    rpc: { solana: cluster().rpc },
    signAsFeePayer,
    store: memorySettlementStore(),
    ...over,
  };
}

// ── Building transactions, including ones no honest client builds ─────

interface Editable {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  accountKeys: string[];
  recentBlockhash: string;
  instructions: { program: string; accounts: string[]; data: Uint8Array }[];
}

function shortVec(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) return [...out, byte];
    out.push(byte | 0x80);
  }
}

function serialize(tx: Editable): Uint8Array {
  const index = (a: string) => tx.accountKeys.indexOf(a);
  const message = [
    0x80,
    tx.numRequiredSignatures,
    tx.numReadonlySigned,
    tx.numReadonlyUnsigned,
    ...shortVec(tx.accountKeys.length),
    ...tx.accountKeys.flatMap((k) => [...base58.decode(k)]),
    ...base58.decode(tx.recentBlockhash),
    ...shortVec(tx.instructions.length),
    ...tx.instructions.flatMap((ix) => [
      index(ix.program),
      ...shortVec(ix.accounts.length),
      ...ix.accounts.map(index),
      ...shortVec(ix.data.length),
      ...ix.data,
    ]),
    0,
  ];
  return new Uint8Array([
    ...shortVec(tx.numRequiredSignatures),
    ...new Array(64 * tx.numRequiredSignatures).fill(0),
    ...message,
  ]);
}

/** Add `address` as a read-only unsigned account if it is not there. */
function addKey(tx: Editable, address: string) {
  if (tx.accountKeys.includes(address)) return;
  tx.accountKeys.push(address);
  tx.numReadonlyUnsigned++;
}

function payment(over: Partial<SplTransferPayment> = {}): SplTransferPayment {
  return {
    feePayer: FEE_PAYER,
    authority: PAYER,
    mint: USDC,
    tokenProgram: TOKEN,
    decimals: 6,
    recipient: PAY_TO,
    amount: 1000n,
    memo: MEMO,
    recentBlockhash: BLOCKHASH,
    ...over,
  };
}

/** A PAYMENT-SIGNATURE: `p` built, edited by `edit`, signed by the payer. */
function pay(
  p: Partial<SplTransferPayment> = {},
  edit: (tx: Editable) => void = () => {},
  options: { accepted?: X402PaymentRequirements; sign?: boolean } = {},
): string {
  const tx: Editable = {
    ...parseSolanaTransaction(buildSplTransferTransaction(payment(p))),
  };
  tx.accountKeys = [...tx.accountKeys];
  tx.instructions = tx.instructions.map((ix) => ({
    ...ix,
    accounts: [...ix.accounts],
  }));
  edit(tx);
  const wire = serialize(tx);
  const parsed = parseSolanaTransaction(wire);
  const at = parsed.accountKeys.indexOf(PAYER);
  if (options.sign !== false && at >= 0 && at < parsed.numRequiredSignatures) {
    wire.set(ed25519.sign(parsed.message, PAYER_SEED), 1 + 64 * at);
  }
  return encodeHeader({
    x402Version: 2,
    resource: { url: URL_ },
    accepted: options.accepted ?? requirement(),
    payload: { transaction: base64.encode(wire) },
  });
}

const lighthouse = (tx: Editable, at = tx.instructions.length) => {
  addKey(tx, SOLANA_PROGRAMS.lighthouse);
  tx.instructions.splice(at, 0, {
    program: SOLANA_PROGRAMS.lighthouse,
    accounts: [],
    data: new Uint8Array([1, 2, 3]),
  });
};

describe("verifyPayment, SVM exact", () => {
  it("accepts the transfer the spec describes and reports the payer", async () => {
    expect(await verifyPayment(pay(), [requirement()], deps())).toMatchObject({
      ok: true,
      payer: PAYER,
      requirement: requirement(),
    });
  });

  it("accepts wallet-injected Lighthouse instructions and a random memo", async () => {
    const noMemo = requirement({ extra: { feePayer: FEE_PAYER } });
    for (const header of [
      pay({}, (tx) => lighthouse(tx, 3)),
      pay({}, (tx) => {
        lighthouse(tx, 3);
        lighthouse(tx, 4);
      }),
      pay({ memo: "0123456789abcdef0123456789abcdef" }, () => {}, {
        accepted: noMemo,
      }),
    ]) {
      const offered = [requirement(), noMemo];
      expect(await verifyPayment(header, offered, deps())).toMatchObject({
        ok: true,
      });
    }
  });

  it("accepts the compute price cap, and not one micro-lamport more", async () => {
    expect(
      await verifyPayment(
        pay({ computeUnitPrice: X402_MAX_COMPUTE_UNIT_PRICE }),
        [requirement()],
        deps(),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await verifyPayment(
        pay({ computeUnitPrice: X402_MAX_COMPUTE_UNIT_PRICE + 1n }),
        [requirement()],
        deps(),
      ),
    ).toMatchObject({
      ok: false,
      reason: "invalid_exact_svm_payload_transaction",
      detail: expect.stringMatching(/price/),
    });
  });

  const TX = "invalid_exact_svm_payload_transaction";
  it.each<[string, () => string, string]>([
    [
      "the wrong payee",
      () => pay({ recipient: OTHER }),
      "invalid_exact_svm_payload_recipient_mismatch",
    ],
    [
      "the wrong amount",
      () => pay({ amount: 999n }),
      "invalid_exact_svm_payload_amount_mismatch",
    ],
    [
      "the fee payer in a memo's accounts",
      () =>
        pay({}, (tx) => {
          (tx.instructions[3] as Editable["instructions"][0]).accounts = [
            FEE_PAYER,
          ];
        }),
      TX,
    ],
    [
      "the fee payer in a Lighthouse instruction",
      () =>
        pay({}, (tx) => {
          lighthouse(tx, 3);
          (tx.instructions[3] as Editable["instructions"][0]).accounts = [
            FEE_PAYER,
          ];
        }),
      TX,
    ],
    [
      "the fee payer's own token account as the source",
      () => pay({ sourceOwner: FEE_PAYER }),
      TX,
    ],
    [
      "the fee payer as the transfer authority",
      () => pay({ authority: FEE_PAYER, sourceOwner: PAYER }),
      TX,
    ],
    ["another fee payer", () => pay({ feePayer: OTHER }), TX],
    ["another memo", () => pay({ memo: "pi_other" }), TX],
    ["no memo", () => pay({ memo: null }), TX],
    [
      "two memos",
      () =>
        pay({}, (tx) => {
          tx.instructions.push({
            ...(tx.instructions[3] as Editable["instructions"][0]),
          });
        }),
      TX,
    ],
    [
      "an instruction for another program",
      () =>
        pay({}, (tx) => {
          const system = "11111111111111111111111111111111";
          addKey(tx, system);
          tx.instructions.splice(3, 0, {
            program: system,
            accounts: [],
            data: new Uint8Array([2]),
          });
        }),
      TX,
    ],
    [
      "Lighthouse in the sixth slot",
      () =>
        // Memo, Lighthouse, Lighthouse: six instructions, the last not a memo.
        pay({}, (tx) => {
          lighthouse(tx);
          lighthouse(tx);
        }),
      TX,
    ],
    [
      "the compute budget instructions swapped",
      () =>
        pay({}, (tx) => {
          const [a, b] = tx.instructions as [
            Editable["instructions"][0],
            Editable["instructions"][0],
          ];
          tx.instructions[0] = b;
          tx.instructions[1] = a;
        }),
      TX,
    ],
    [
      "a Transfer instead of TransferChecked",
      () =>
        pay({}, (tx) => {
          const transfer = tx.instructions[2] as Editable["instructions"][0];
          transfer.data = transfer.data.slice(0, 9);
          transfer.data[0] = 3;
          transfer.accounts = [
            transfer.accounts[0] as string,
            transfer.accounts[2] as string,
            transfer.accounts[3] as string,
          ];
        }),
      TX,
    ],
    [
      "a transfer of another mint",
      () =>
        pay({}, (tx) => {
          const transfer = tx.instructions[2] as Editable["instructions"][0];
          addKey(tx, OTHER);
          transfer.accounts[1] = OTHER;
        }),
      TX,
    ],
    ["wrong decimals", () => pay({ decimals: 9 }), TX],
    [
      "an unsigned transaction",
      () => pay({}, () => {}, { sign: false }),
      "invalid_exact_svm_payload_signature",
    ],
    [
      "a tampered signature",
      () => {
        const header = pay();
        const payload = decodeHeader(header) as {
          payload: { transaction: string };
        };
        const wire = base64.decode(payload.payload.transaction);
        wire[1 + 64 + 5] = (wire[1 + 64 + 5] as number) ^ 1;
        return encodeHeader({
          ...payload,
          payload: { transaction: base64.encode(wire) },
        });
      },
      "invalid_exact_svm_payload_signature",
    ],
    [
      "a transaction that is not base64",
      () => {
        const payload = decodeHeader(pay()) as Record<string, unknown>;
        return encodeHeader({ ...payload, payload: { transaction: "!!" } });
      },
      "invalid_payload",
    ],
    [
      "an unexpected payload field",
      () => {
        const payload = decodeHeader(pay()) as {
          payload: Record<string, unknown>;
        };
        return encodeHeader({
          ...payload,
          payload: { ...payload.payload, feePayer: OTHER },
        });
      },
      "invalid_payload",
    ],
    [
      "accepted that was not offered",
      () => pay({}, () => {}, { accepted: requirement({ amount: "1" }) }),
      "invalid_payment_requirements",
    ],
  ])("refuses %s", async (_name, build, reason) => {
    expect(await verifyPayment(build(), [requirement()], deps())).toMatchObject(
      { ok: false, reason },
    );
  });

  it("refuses the fee payer's token account as the source before any read", async () => {
    const reads: string[] = [];
    const { rpc } = cluster();
    const result = await verifyPayment(
      pay({ sourceOwner: FEE_PAYER }),
      [requirement()],
      deps({
        rpc: {
          solana: {
            ...rpc,
            getAccountInfo: async (address) => {
              reads.push(address);
              return rpc.getAccountInfo(address);
            },
          },
        },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/fee payer's token account/),
    });
    expect(reads).toEqual([]);
  });

  it("checks the accounts on chain", async () => {
    const at = (options: ChainOptions) =>
      verifyPayment(pay(), [requirement()], {
        ...deps(),
        rpc: { solana: cluster(options).rpc },
      });
    expect(await at({ balance: 999n })).toMatchObject({
      ok: false,
      reason: "insufficient_funds",
    });
    expect(await at({ sourceOwner: FEE_PAYER })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/fee payer's tokens/),
    });
    expect(await at({ noDestination: true })).toMatchObject({
      ok: false,
      reason: "invalid_exact_svm_payload_recipient_mismatch",
    });
    expect(
      await at({ genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1xxxxxxxxxxxx" }),
    ).toMatchObject({ ok: false, reason: "invalid_network" });
    expect(
      await verifyPayment(pay(), [requirement()], deps({ rpc: {} })),
    ).toMatchObject({ ok: false, reason: "invalid_network" });
  });
});

describe("settlePayment, SVM exact", () => {
  it("adds the fee payer's signature, simulates, sends and reports the signature", async () => {
    const chain = cluster();
    const d = deps({ rpc: { solana: chain.rpc } });
    const verified = await verifyPayment(pay(), [requirement()], d);
    if (!verified.ok) throw new Error(verified.detail);
    const { settlement, header } = await settlePayment(verified, d);
    expect(chain.simulated).toHaveLength(1);
    expect(chain.sent).toEqual(chain.simulated);
    const sent = parseSolanaTransaction(base64.decode(chain.sent[0] as string));
    expect(
      ed25519.verify(
        sent.signatures[0] as Uint8Array,
        sent.message,
        base58.decode(FEE_PAYER),
      ),
    ).toBe(true);
    expect(settlement).toEqual({
      success: true,
      transaction: base58.encode(sent.signatures[0] as Uint8Array),
      network: SOLANA_MAINNET,
      payer: PAYER,
    });
    expect(decodeHeader(header)).toEqual(settlement);
  });

  it("refuses a second settlement of the same transaction", async () => {
    const chain = cluster();
    const d = deps({ rpc: { solana: chain.rpc } });
    const header = pay();
    const a = await verifyPayment(header, [requirement()], d);
    const b = await verifyPayment(header, [requirement()], d);
    if (!a.ok || !b.ok) throw new Error("verify");
    const [first, second] = await Promise.all([
      settlePayment(a, d),
      settlePayment(b, d),
    ]);
    expect(first.settlement.success).toBe(true);
    expect(second.settlement).toMatchObject({
      success: false,
      errorReason: "duplicate_settlement",
    });
    expect(chain.sent).toHaveLength(1);
  });

  it("sends nothing when the fee payer's signer changes the message or the simulation fails", async () => {
    const tampering = cluster();
    const d = deps({
      rpc: { solana: tampering.rpc },
      signAsFeePayer: async (wire) => {
        const signed = await signAsFeePayer(wire);
        signed[signed.length - 2] = (signed[signed.length - 2] as number) ^ 1;
        return signed;
      },
    });
    const v1 = await verifyPayment(pay(), [requirement()], d);
    if (!v1.ok) throw new Error(v1.detail);
    expect((await settlePayment(v1, d)).settlement).toMatchObject({
      success: false,
    });
    expect(tampering.sent).toHaveLength(0);

    const failing = cluster({ simulationError: { InstructionError: [2, 1] } });
    const d2 = deps({ rpc: { solana: failing.rpc } });
    const v2 = await verifyPayment(pay(), [requirement()], d2);
    if (!v2.ok) throw new Error(v2.detail);
    expect((await settlePayment(v2, d2)).settlement).toMatchObject({
      success: false,
      errorReason: "invalid_transaction_state",
    });
    expect(failing.sent).toHaveLength(0);

    const d3 = deps({ signAsFeePayer: undefined });
    const v3 = await verifyPayment(pay(), [requirement()], d3);
    if (!v3.ok) throw new Error(v3.detail);
    expect((await settlePayment(v3, d3)).settlement).toMatchObject({
      success: false,
      errorReason: "unexpected_settle_error",
    });
  });
});

describe("round trip with createX402Fetch, SVM", () => {
  function wallet(): X402SolanaSigner {
    return {
      address: PAYER,
      async signTransaction(transaction) {
        const tx = parseSolanaTransaction(transaction);
        const out = transaction.slice();
        out.set(
          ed25519.sign(tx.message, PAYER_SEED),
          1 + 64 * tx.accountKeys.indexOf(PAYER),
        );
        return out;
      },
    };
  }

  it.each([
    ["a seller memo", requirement()],
    ["a random memo", requirement({ extra: { feePayer: FEE_PAYER } })],
  ])("pays, verifies and settles with %s", async (_name, offered) => {
    const chain = cluster();
    const serverDeps = deps({ rpc: { solana: chain.rpc } });
    const server = async (input: RequestInfo | URL) => {
      const gate = await requirePayment(input as Request, {
        accepts: [offered],
        deps: serverDeps,
      });
      if (!gate.paid) return gate.response;
      const { settlement, header } = await settlePayment(
        gate.payment,
        serverDeps,
      );
      return new Response(settlement.success ? "sunny" : "{}", {
        status: settlement.success ? 200 : 402,
        headers: { [PAYMENT_RESPONSE_HEADER]: header },
      });
    };
    let sent = "";
    const result = await createX402Fetch({
      solana: { signer: wallet(), rpc: chain.rpc },
      fetch: (async (input: RequestInfo | URL) => {
        sent = (input as Request).headers.get(PAYMENT_SIGNATURE_HEADER) ?? sent;
        return server(input);
      }) as typeof fetch,
    })(URL_);
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("sunny");
    expect(result.settlement).toMatchObject({
      success: true,
      network: SOLANA_MAINNET,
      payer: PAYER,
    });
    expect(chain.sent).toHaveLength(1);

    // Replayed within the window: refused before a second broadcast.
    const replay = await server(
      new Request(URL_, { headers: { [PAYMENT_SIGNATURE_HEADER]: sent } }),
    );
    expect(replay.status).toBe(402);
    expect(chain.sent).toHaveLength(1);
  });
});
