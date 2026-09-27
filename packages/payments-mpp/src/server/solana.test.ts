import {
  associatedTokenAddress,
  buildSplTransferTransaction,
  parseSolanaTransaction,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
  type SplTransferPayment,
} from "@naculus/connect-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  createMppFetch,
  createSolanaChargeCredential,
  encodeBase64UrlJson,
  type MppSolanaSigner,
  parsePaymentChallenges,
  parsePaymentReceipt,
  type SelectedSolanaCharge,
  selectCharge,
} from "../index";
import {
  createChallenge,
  memoryReplayStore,
  type MppSolanaSettleRpc,
  type PaymentProblem,
  paymentRequiredResponse,
  problemResponse,
  receiptHeaders,
  settleCredential,
  type VerifyCredentialOptions,
  verifyCredential,
} from "./index";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SEED = new Uint8Array(32).fill(7);
const PAYER = base58.encode(ed25519.getPublicKey(SEED));
const FEE_SEED = new Uint8Array(32).fill(9);
const FEE_PAYER = base58.encode(ed25519.getPublicKey(FEE_SEED));
const SYSTEM = "11111111111111111111111111111111";
const SECRET = "server-binding-secret-0001";
const REALM = "api.example.com";
const URL_ = "https://api.example.com/data";

function request(details: Record<string, unknown> = {}) {
  return {
    amount: "250000",
    currency: USDC,
    recipient: RECIPIENT,
    externalId: "order-42",
    methodDetails: {
      network: "mainnet",
      decimals: 6,
      tokenProgram: SOLANA_PROGRAMS.token,
      feePayer: true,
      feePayerKey: FEE_PAYER,
      ...details,
    },
  };
}
const SPONSORED = request();
const SELF_FUNDED = request({ feePayer: undefined, feePayerKey: undefined });

function challenge(req: Record<string, unknown> = SPONSORED, over = {}) {
  return createChallenge({
    realm: REALM,
    method: "solana",
    intent: "charge",
    request: JSON.parse(JSON.stringify(req)),
    expires: new Date(Date.now() + 120_000),
    secret: SECRET,
    ...over,
  });
}

function clientRpc(): SolanaPaymentRpc {
  const mint = new Uint8Array(82);
  mint[44] = 6;
  mint[45] = 1;
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getLatestBlockhash: async () => BLOCKHASH,
    getAccountInfo: async (address) =>
      address === USDC ? { owner: SOLANA_PROGRAMS.token, data: mint } : null,
  };
}

/** Put `seed`'s signature over the message into `address`'s slot. */
function sign(wire: Uint8Array, seed = SEED, address = PAYER): Uint8Array {
  const tx = parseSolanaTransaction(wire);
  const out = wire.slice();
  out.set(
    ed25519.sign(tx.message, seed),
    1 + 64 * tx.accountKeys.indexOf(address),
  );
  return out;
}

const wallet: MppSolanaSigner = {
  address: PAYER,
  signTransaction: async (wire) => sign(wire),
};

/** The client's real credential for `value`. */
async function clientCredential(value: string): Promise<string> {
  const { challenges } = parsePaymentChallenges(value);
  const selected = selectCharge(challenges, {
    evm: false,
    solana: true,
  }) as SelectedSolanaCharge;
  return (
    await createSolanaChargeCredential(selected.challenge, selected.request, {
      rpc: clientRpc(),
      signer: wallet,
    })
  ).value;
}

interface Ix {
  program: string;
  accounts: { address: string; signer: boolean; writable: boolean }[];
  data: Uint8Array;
}

function u64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

/** A minimal v0 compiler (fee payer first, no lookup tables) for crafting. */
function compile(feePayer: string, ixs: Ix[]): Uint8Array {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const add = (a: string, signer: boolean, writable: boolean) => {
    const m = metas.get(a);
    metas.set(a, {
      signer: signer || (m?.signer ?? false),
      writable: writable || (m?.writable ?? false),
    });
  };
  add(feePayer, true, true);
  for (const ix of ixs) {
    for (const a of ix.accounts) add(a.address, a.signer, a.writable);
    add(ix.program, false, false);
  }
  const all = [...metas.entries()];
  const group = (signer: boolean, writable: boolean) =>
    all
      .filter(([, m]) => m.signer === signer && m.writable === writable)
      .map(([a]) => a);
  const keys = [
    ...group(true, true),
    ...group(true, false),
    ...group(false, true),
    ...group(false, false),
  ];
  const signers = group(true, true).length + group(true, false).length;
  const bytes: number[] = [
    0x80,
    signers,
    group(true, false).length,
    group(false, false).length,
    keys.length,
  ];
  for (const k of keys) bytes.push(...base58.decode(k));
  bytes.push(...base58.decode(BLOCKHASH), ixs.length);
  for (const ix of ixs) {
    bytes.push(keys.indexOf(ix.program), ix.accounts.length);
    for (const a of ix.accounts) bytes.push(keys.indexOf(a.address));
    bytes.push(ix.data.length, ...ix.data);
  }
  bytes.push(0);
  return new Uint8Array([signers, ...new Uint8Array(64 * signers), ...bytes]);
}

function payment(over: Partial<SplTransferPayment> = {}): SplTransferPayment {
  return {
    feePayer: FEE_PAYER,
    authority: PAYER,
    mint: USDC,
    tokenProgram: SOLANA_PROGRAMS.token,
    decimals: 6,
    recipient: RECIPIENT,
    amount: 250000n,
    memo: "order-42",
    recentBlockhash: BLOCKHASH,
    ...over,
  };
}

/** A credential for `value` carrying `wire` as the transaction. */
function crafted(
  value: string,
  wire: Uint8Array | string,
  payload: Record<string, unknown> = {},
): string {
  const params = parsePaymentChallenges(value).challenges[0]?.params;
  return `Payment ${encodeBase64UrlJson({
    challenge: params,
    payload: {
      type: "transaction",
      transaction: typeof wire === "string" ? wire : base64.encode(wire),
      ...payload,
    },
  })}`;
}

function options(
  req: Record<string, unknown> = SPONSORED,
  over: Partial<VerifyCredentialOptions> = {},
): VerifyCredentialOptions {
  return {
    secret: SECRET,
    realm: REALM,
    accept: [{ method: "solana", request: JSON.parse(JSON.stringify(req)) }],
    ...over,
  };
}

function settleRpc(over: Partial<MppSolanaSettleRpc> = {}) {
  const sent: string[] = [];
  const rpc: MppSolanaSettleRpc = {
    simulateTransaction: async () => ({ err: null }),
    sendTransaction: async (tx) => {
      sent.push(tx);
      return base58.encode(
        parseSolanaTransaction(base64.decode(tx)).signatures[0] as Uint8Array,
      );
    },
    confirmTransaction: async () => true,
    ...over,
  };
  return { rpc, sent };
}

const signAsFeePayer = async (wire: Uint8Array) =>
  sign(wire, FEE_SEED, FEE_PAYER);

async function refusal(p: Promise<unknown>): Promise<PaymentProblem> {
  const error = await p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e) => e,
  );
  expect(error.name).toBe("PaymentProblem");
  return error as PaymentProblem;
}

describe("verifyCredential, solana pull mode", () => {
  it("accepts the client's sponsored transaction and settles it", async () => {
    const value = await clientCredential(challenge());
    const verified = await verifyCredential(value, options());
    expect(verified).toMatchObject({
      method: "solana",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      payer: PAYER,
      source: `did:pkh:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${PAYER}`,
    });
    const { rpc, sent } = settleRpc();
    const settled = await settleCredential(verified, {
      replay: memoryReplayStore(),
      solana: { rpc, signAsFeePayer },
    });
    const tx = parseSolanaTransaction(base64.decode(sent[0] as string));
    expect(tx.accountKeys[0]).toBe(FEE_PAYER);
    expect(
      ed25519.verify(
        tx.signatures[0] as Uint8Array,
        tx.message,
        base58.decode(FEE_PAYER),
      ),
    ).toBe(true);
    expect(parsePaymentReceipt(settled.header)).toEqual({
      status: "success",
      method: "solana",
      timestamp: expect.any(String),
      reference: base58.encode(tx.signatures[0] as Uint8Array),
      challengeId: verified.challenge.id,
      externalId: "order-42",
    });
  });

  it("accepts a self-funded transaction and sends it as signed", async () => {
    const value = await clientCredential(challenge(SELF_FUNDED));
    const verified = await verifyCredential(value, options(SELF_FUNDED));
    const { rpc, sent } = settleRpc();
    await settleCredential(verified, {
      replay: memoryReplayStore(),
      solana: { rpc },
    });
    const tx = parseSolanaTransaction(base64.decode(sent[0] as string));
    expect(tx.accountKeys[0]).toBe(PAYER);
    expect(tx.numRequiredSignatures).toBe(1);
  });

  it.each<[string, Uint8Array]>([
    [
      "the payer as fee payer of a sponsored charge",
      sign(buildSplTransferTransaction(payment({ feePayer: PAYER }))),
    ],
    [
      "the server's fee payer as the transfer authority",
      sign(
        buildSplTransferTransaction(
          payment({ authority: FEE_PAYER, feePayer: FEE_PAYER }),
        ),
        FEE_SEED,
        FEE_PAYER,
      ),
    ],
    [
      "a lower amount",
      sign(buildSplTransferTransaction(payment({ amount: 249999n }))),
    ],
    [
      "another recipient",
      sign(
        buildSplTransferTransaction(
          payment({
            recipient: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
          }),
        ),
      ),
    ],
    [
      "another mint",
      sign(
        buildSplTransferTransaction(
          payment({ mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }),
        ),
      ),
    ],
    [
      "other decimals",
      sign(buildSplTransferTransaction(payment({ decimals: 9 }))),
    ],
    [
      "Token-2022 instead of the challenge's program",
      sign(
        buildSplTransferTransaction(
          payment({ tokenProgram: SOLANA_PROGRAMS.token2022 }),
        ),
      ),
    ],
    [
      "a memo that is not the externalId",
      sign(buildSplTransferTransaction(payment({ memo: "other" }))),
    ],
    [
      "a priority fee the sponsor did not agree to",
      sign(
        buildSplTransferTransaction(
          payment({ computeUnitLimit: 200_000, computeUnitPrice: 1_000_000n }),
        ),
      ),
    ],
    ["no payer signature", buildSplTransferTransaction(payment())],
    [
      "a filled fee payer slot",
      sign(sign(buildSplTransferTransaction(payment())), FEE_SEED, FEE_PAYER),
    ],
  ])("refuses %s", async (_name, wire) => {
    const value = crafted(challenge(), wire);
    expect((await refusal(verifyCredential(value, options()))).code).toBe(
      "verification-failed",
    );
  });

  it("refuses an instruction for another program", async () => {
    // Re-point the memo instruction at the System Program and re-sign.
    const wire = buildSplTransferTransaction(payment());
    const memo = base58.decode(SOLANA_PROGRAMS.memo);
    const at = wire.findIndex((_, i) =>
      memo.every((b, j) => wire[i + j] === b),
    );
    wire.set(new Uint8Array(32), at);
    const value = crafted(challenge(), sign(wire));
    const p = await refusal(verifyCredential(value, options()));
    expect(p.detail).toMatch(/11111111111111111111111111111111/);
  });

  it("refuses a transaction that lists an account twice", async () => {
    const wire = buildSplTransferTransaction(payment());
    const memo = base58.decode(SOLANA_PROGRAMS.memo);
    const at = wire.findIndex((_, i) =>
      memo.every((b, j) => wire[i + j] === b),
    );
    wire.set(base58.decode(SOLANA_PROGRAMS.token), at);
    const value = crafted(challenge(), sign(wire));
    expect((await refusal(verifyCredential(value, options()))).detail).toMatch(
      /twice/,
    );
  });

  describe("instructions a charge does not need", () => {
    const source = associatedTokenAddress(PAYER, USDC, SOLANA_PROGRAMS.token);
    const destination = associatedTokenAddress(
      RECIPIENT,
      USDC,
      SOLANA_PROGRAMS.token,
    );
    const transfer = (amount: bigint): Ix => ({
      program: SOLANA_PROGRAMS.token,
      accounts: [
        { address: source, signer: false, writable: true },
        { address: USDC, signer: false, writable: false },
        { address: destination, signer: false, writable: true },
        { address: PAYER, signer: true, writable: false },
      ],
      data: new Uint8Array([12, ...u64(amount), 6]),
    });
    const memo: Ix = {
      program: SOLANA_PROGRAMS.memo,
      accounts: [],
      data: new TextEncoder().encode("order-42"),
    };

    it("accepts the compiler's plain transfer (control)", async () => {
      const wire = sign(compile(FEE_PAYER, [transfer(250000n), memo]));
      await expect(
        verifyCredential(crafted(challenge(), wire), options()),
      ).resolves.toBeTruthy();
    });

    it.each<[string, Ix[], RegExp]>([
      [
        "a second TransferChecked",
        [transfer(250000n), transfer(1n)],
        /not one TransferChecked/,
      ],
      [
        "an ATA creation funded by the fee payer",
        [
          {
            program: SOLANA_PROGRAMS.associatedToken,
            accounts: [
              { address: FEE_PAYER, signer: true, writable: true },
              { address: destination, signer: false, writable: true },
              { address: RECIPIENT, signer: false, writable: false },
              { address: USDC, signer: false, writable: false },
              { address: SYSTEM, signer: false, writable: false },
              {
                address: SOLANA_PROGRAMS.token,
                signer: false,
                writable: false,
              },
            ],
            data: new Uint8Array([1]),
          },
          transfer(250000n),
        ],
        /fee payer account/,
      ],
      [
        "a SOL transfer out of the fee payer",
        [
          transfer(250000n),
          {
            program: SYSTEM,
            accounts: [
              { address: FEE_PAYER, signer: true, writable: true },
              { address: PAYER, signer: true, writable: true },
            ],
            data: new Uint8Array([2, 0, 0, 0, ...u64(10n ** 9n)]),
          },
        ],
        /fee payer account/,
      ],
      ["a second memo", [transfer(250000n), memo, memo], /one memo/],
      [
        "a heap frame request",
        [
          {
            program: SOLANA_PROGRAMS.computeBudget,
            accounts: [],
            data: new Uint8Array([1, 0, 0, 1, 0]),
          },
          transfer(250000n),
        ],
        /compute unit/,
      ],
    ])("refuses %s", async (_name, ixs, detail) => {
      const wire = sign(compile(FEE_PAYER, ixs));
      const p = await refusal(
        verifyCredential(crafted(challenge(), wire), options()),
      );
      expect(p.code).toBe("verification-failed");
      expect(p.detail).toMatch(detail);
    });
  });

  it.each([
    ["push mode", { type: "signature", signature: "5UfDuX7h" }],
    ["a bundle", { type: "bundle", transactions: [] }],
    ["base64url instead of base64", { transaction: "a-_b" }],
    [
      "garbage bytes",
      { transaction: base64.encode(new Uint8Array([1, 2, 3])) },
    ],
    ["a missing transaction", { transaction: undefined }],
  ])("refuses %s as invalid-payload", async (_name, payload) => {
    const value = crafted(challenge(), "AA==", payload);
    expect((await refusal(verifyCredential(value, options()))).code).toBe(
      "invalid-payload",
    );
  });

  it("refuses a source that is not the payer", async () => {
    const params = parsePaymentChallenges(challenge()).challenges[0]?.params;
    const value = `Payment ${encodeBase64UrlJson({
      challenge: params,
      payload: {
        type: "transaction",
        transaction: base64.encode(
          sign(buildSplTransferTransaction(payment())),
        ),
      },
      source: FEE_PAYER,
    })}`;
    expect((await refusal(verifyCredential(value, options()))).detail).toMatch(
      /source/,
    );
  });

  it("refuses the same transaction for a second challenge", async () => {
    // Two challenges with the same request: one transaction satisfies both.
    const wire = sign(buildSplTransferTransaction(payment()));
    const replay = memoryReplayStore();
    const first = await verifyCredential(crafted(challenge(), wire), options());
    await settleCredential(first, {
      replay,
      solana: { rpc: settleRpc().rpc, signAsFeePayer },
    });
    const later = challenge(SPONSORED, {
      expires: new Date(Date.now() + 90_000),
    });
    const second = await verifyCredential(crafted(later, wire), options());
    const { rpc, sent } = settleRpc();
    const p = await refusal(
      settleCredential(second, { replay, solana: { rpc, signAsFeePayer } }),
    );
    expect(p.code).toBe("invalid-challenge");
    expect(sent).toEqual([]);
  });

  /**
   * A second valid Ed25519 signature by `seed` over `message`: a random nonce
   * instead of RFC 8032's deterministic one. Verifiers accept either.
   */
  function resign(message: Uint8Array, seed: Uint8Array): Uint8Array {
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
    const order = ed25519.Point.Fn.ORDER;
    const le = (bytes: Uint8Array) =>
      bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
    const r = (le(ed25519.utils.randomSecretKey()) % (order - 1n)) + 1n;
    const R = ed25519.Point.BASE.multiply(r).toBytes();
    const k = le(sha512(new Uint8Array([...R, ...pointBytes, ...message])));
    let S = (r + (k % order) * scalar) % order;
    const out = new Uint8Array(64);
    out.set(R, 0);
    for (let i = 32; i < 64; i++) {
      out[i] = Number(S & 0xffn);
      S >>= 8n;
    }
    return out;
  }

  it("refuses the same message under another valid payer signature", async () => {
    // One payment, two byte forms: the payer re-signs the message with a
    // different nonce. Both signatures verify; only one may settle.
    const wire = sign(buildSplTransferTransaction(payment()));
    const tx = parseSolanaTransaction(wire);
    const payerSlot = tx.accountKeys.indexOf(PAYER);
    const other = wire.slice();
    other.set(resign(tx.message, SEED), 1 + 64 * payerSlot);
    expect(other).not.toEqual(wire);
    expect(
      ed25519.verify(
        other.slice(1 + 64 * payerSlot, 1 + 64 * (payerSlot + 1)),
        tx.message,
        base58.decode(PAYER),
      ),
    ).toBe(true);
    const replay = memoryReplayStore();
    const first = await verifyCredential(crafted(challenge(), wire), options());
    await settleCredential(first, {
      replay,
      solana: { rpc: settleRpc().rpc, signAsFeePayer },
    });
    const later = challenge(SPONSORED, {
      expires: new Date(Date.now() + 90_000),
    });
    const second = await verifyCredential(crafted(later, other), options());
    const { rpc, sent } = settleRpc();
    const p = await refusal(
      settleCredential(second, { replay, solana: { rpc, signAsFeePayer } }),
    );
    expect(p.code).toBe("invalid-challenge");
    expect(sent).toEqual([]);
  });

  it("fails the payment when simulation or confirmation fails", async () => {
    for (const over of [
      {
        simulateTransaction: async () => ({
          err: { InstructionError: [2, "x"] },
        }),
      },
      { confirmTransaction: async () => false },
    ]) {
      const value = await clientCredential(challenge());
      const verified = await verifyCredential(value, options());
      const { rpc } = settleRpc(over);
      expect(
        (
          await refusal(
            settleCredential(verified, {
              replay: memoryReplayStore(),
              solana: { rpc, signAsFeePayer },
            }),
          )
        ).code,
      ).toBe("verification-failed");
    }
  });

  it("refuses a fee payer signer that changes the transaction", async () => {
    const value = await clientCredential(challenge());
    const verified = await verifyCredential(value, options());
    const { rpc, sent } = settleRpc();
    const p = await refusal(
      settleCredential(verified, {
        replay: memoryReplayStore(),
        solana: {
          rpc,
          signAsFeePayer: async (wire) => {
            const out = sign(wire, FEE_SEED, FEE_PAYER);
            out[out.length - 5] ^= 1;
            return out;
          },
        },
      }),
    );
    expect(p.code).toBe("internal-payment-error");
    expect(sent).toEqual([]);
  });

  it("needs signAsFeePayer for a sponsored charge", async () => {
    const verified = await verifyCredential(
      await clientCredential(challenge()),
      options(),
    );
    expect(
      (
        await refusal(
          settleCredential(verified, {
            replay: memoryReplayStore(),
            solana: { rpc: settleRpc().rpc },
          }),
        )
      ).code,
    ).toBe("internal-payment-error");
  });
});

describe("round trip with createMppFetch (ed25519 wallet)", () => {
  function server(req: Record<string, unknown>) {
    const replay = memoryReplayStore();
    const { rpc, sent } = settleRpc();
    const fresh = () => [challenge(req)];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init);
      const credential = r.headers.get("Authorization");
      if (!credential) return paymentRequiredResponse(fresh());
      try {
        const verified = await verifyCredential(credential, {
          ...options(req),
          replay,
        });
        const settled = await settleCredential(verified, {
          replay,
          solana: { rpc, signAsFeePayer },
        });
        return new Response("paid content", {
          headers: receiptHeaders(settled.header),
        });
      } catch (error) {
        return problemResponse(error, fresh());
      }
    };
    return { fetch: fetch as typeof globalThis.fetch, sent };
  }

  it.each([
    ["sponsored", SPONSORED],
    ["self-funded", SELF_FUNDED],
  ])("pays a %s charge once", async (_name, req) => {
    const { fetch, sent } = server(req);
    const result = await createMppFetch({
      solana: { rpc: clientRpc(), signer: wallet },
      fetch,
    })(URL_);
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("paid content");
    expect(sent).toHaveLength(1);
    const tx = parseSolanaTransaction(base64.decode(sent[0] as string));
    expect(result.receipt).toMatchObject({
      method: "solana",
      challengeId: result.paid?.challenge.params.id,
      reference: base58.encode(tx.signatures[0] as Uint8Array),
    });
  });

  it("surfaces the refusal of a wallet that signs a lower amount", async () => {
    const { fetch, sent } = server(SPONSORED);
    const cheat: MppSolanaSigner = {
      address: PAYER,
      // Signs something else than it was given; the client's own check
      // catches this before the server sees it.
      signTransaction: async () =>
        sign(buildSplTransferTransaction(payment({ amount: 1n }))),
    };
    await expect(
      createMppFetch({ solana: { rpc: clientRpc(), signer: cheat }, fetch })(
        URL_,
      ),
    ).rejects.toBeTruthy();
    expect(sent).toEqual([]);
  });
});
