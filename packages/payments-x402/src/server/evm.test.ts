import {
  MemoryStorageAdapter,
  recoverTypedDataSigner,
  SessionKeyManager,
  sessionKeyAddress,
  typedDataDigest,
} from "@naculus/connect-core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  buildTransferAuthorization,
  createX402Fetch,
  decodeHeader,
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  sessionKeyX402Signer,
  type X402PaymentRequirements,
} from "../index";
import {
  buildPaymentRequired,
  memorySettlementStore,
  requirePayment,
  settlePayment,
  verifyPayment,
  type X402EvmCall,
  type X402ServerDeps,
  type X402VerifiedPayment,
} from "./index";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const PAYEE = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;
const OTHER = "0x3333333333333333333333333333333333333333" as const;
const URL_ = "https://api.example.com/premium-data";
const NOW = 1_800_000_000;
const KEY = new Uint8Array(32).fill(9);
const PAYER = sessionKeyAddress(
  `0x${bytesToHex(secp256k1.getPublicKey(KEY, true))}`,
);

function requirement(
  over: Partial<X402PaymentRequirements> = {},
): X402PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: USDC,
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...over,
  };
}

function sign(digest: `0x${string}`, key: Uint8Array = KEY): `0x${string}` {
  const sig = secp256k1.sign(hexToBytes(digest.slice(2)), key, {
    prehash: false,
    format: "recovered",
  });
  return `0x${bytesToHex(sig.subarray(1))}${((sig[0] as number) + 27).toString(16)}`;
}

interface Built {
  header: string;
  payload: Record<string, unknown>;
}

/** A PAYMENT-SIGNATURE for `req`, with any part of it overridden. */
function pay(
  options: {
    req?: X402PaymentRequirements;
    accepted?: unknown;
    message?: Record<string, string>;
    signWith?: Record<string, string>;
    key?: Uint8Array;
    now?: number;
    nonce?: `0x${string}`;
    signature?: string;
  } = {},
): Built {
  const req = options.req ?? requirement();
  const typed = buildTransferAuthorization(req, PAYER, {
    now: options.now ?? NOW,
    nonce: options.nonce ?? `0x${"ab".repeat(32)}`,
  });
  const signed = {
    ...typed,
    message: { ...typed.message, ...options.signWith },
  } as typeof typed;
  const signature =
    options.signature ?? sign(typedDataDigest(signed), options.key);
  const payload = {
    x402Version: 2,
    resource: { url: URL_ },
    accepted: options.accepted ?? req,
    payload: {
      signature,
      authorization: { ...signed.message, ...options.message },
    },
  };
  return { header: encodeHeader(payload), payload };
}

/** A token on chain: nonces used, one balance, and a log of calls. */
function chain(options: { balance?: bigint; revert?: boolean } = {}) {
  const used = new Set<string>();
  const calls: X402EvmCall[] = [];
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  const rpc = {
    async call(request: X402EvmCall) {
      calls.push(request);
      const selector = request.data.slice(2, 10);
      if (selector === "e94a0102") {
        const key = request.data.slice(10).toLowerCase();
        return word(used.has(key) ? 1n : 0n);
      }
      if (selector === "70a08231") return word(options.balance ?? 10n ** 9n);
      if (selector === "e3ee160e") {
        if (options.revert) throw new Error("execution reverted");
        return "0x";
      }
      throw new Error(`unexpected call ${selector}`);
    },
  };
  /** Mark the nonce in `data` (transferWithAuthorization calldata) used. */
  const mine = (data: string) => {
    const words = data.slice(10).match(/.{64}/g) as string[];
    used.add(`${words[0]}${words[5]}`.toLowerCase());
  };
  return { rpc, calls, used, mine };
}

function deps(over: Partial<X402ServerDeps> = {}): X402ServerDeps {
  return {
    rpc: { evm: chain().rpc },
    now: () => NOW,
    store: memorySettlementStore({ now: () => NOW }),
    ...over,
  };
}

describe("buildPaymentRequired", () => {
  it("encodes a challenge the client reads", () => {
    const header = buildPaymentRequired({ url: URL_ }, [requirement()], {
      error: "PAYMENT-SIGNATURE header is required",
    });
    expect(decodeHeader(header)).toEqual({
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: URL_ },
      accepts: [requirement()],
    });
  });

  it.each([
    ["an empty accepts", []],
    ["a network that is not CAIP-2", [requirement({ network: "base" })]],
    ["Permit2", [requirement({ extra: { assetTransferMethod: "permit2" } })]],
    ["a role payee", [requirement({ payTo: "merchant" })]],
  ])("refuses to offer %s", (_name, accepts) => {
    expect(() => buildPaymentRequired({ url: URL_ }, accepts)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});

describe("verifyPayment, EVM exact", () => {
  it("accepts a correct authorization and reports the payer", async () => {
    const { rpc, calls } = chain();
    const result = await verifyPayment(
      pay().header,
      [requirement({ amount: "1" }), requirement()],
      deps({ rpc: { evm: rpc } }),
    );
    expect(result).toMatchObject({
      ok: true,
      payer: PAYER,
      requirement: requirement(),
    });
    // authorizationState, balanceOf, then the simulated transfer.
    expect(calls.map((c) => c.data.slice(2, 10)).sort()).toEqual([
      "70a08231",
      "e3ee160e",
      "e94a0102",
    ]);
    expect(calls.every((c) => c.chainId === 84532 && c.to === USDC)).toBe(true);
  });

  it.each<[string, () => Built, string]>([
    [
      "wrong payee",
      () => pay({ message: { to: OTHER }, signWith: { to: OTHER } }),
      "invalid_exact_evm_payload_recipient_mismatch",
    ],
    [
      "wrong amount",
      () => pay({ message: { value: "9999" }, signWith: { value: "9999" } }),
      "invalid_exact_evm_payload_authorization_value_mismatch",
    ],
    [
      "an expired authorization",
      () => pay({ now: NOW - 61 }),
      "invalid_exact_evm_payload_authorization_valid_before",
    ],
    [
      "a window longer than maxTimeoutSeconds",
      () => {
        const long = String(NOW + 3600);
        return pay({
          message: { validBefore: long },
          signWith: { validBefore: long },
        });
      },
      "invalid_exact_evm_payload_authorization_valid_before",
    ],
    [
      "an authorization not valid yet",
      () => {
        const later = String(NOW + 10);
        return pay({
          message: { validAfter: later },
          signWith: { validAfter: later },
        });
      },
      "invalid_exact_evm_payload_authorization_valid_after",
    ],
    [
      "a tampered signature",
      () => {
        const good = pay().payload.payload as { signature: string };
        const flipped = `${good.signature.slice(0, 10)}${good.signature[10] === "0" ? "1" : "0"}${good.signature.slice(11)}`;
        return pay({ signature: flipped });
      },
      "invalid_exact_evm_payload_signature",
    ],
    [
      "a signature by someone else",
      () => pay({ key: new Uint8Array(32).fill(3) }),
      "invalid_exact_evm_payload_signature",
    ],
    [
      "an authorization changed after signing",
      () => pay({ message: { nonce: `0x${"cd".repeat(32)}` } }),
      "invalid_exact_evm_payload_signature",
    ],
    [
      "accepted that was not offered",
      () =>
        pay({
          req: requirement({ payTo: OTHER }),
        }),
      "invalid_payment_requirements",
    ],
    [
      "accepted with an extra field",
      () => pay({ accepted: { ...requirement(), note: "x" } }),
      "invalid_payment_requirements",
    ],
    [
      "an extra authorization field",
      () => pay({ message: { extra: "1" } }),
      "invalid_payload",
    ],
  ])("refuses %s", async (_name, build, reason) => {
    const result = await verifyPayment(build().header, [requirement()], deps());
    expect(result).toMatchObject({ ok: false, reason });
  });

  it("refuses a high-s signature, which the token would reject", async () => {
    const good = pay().payload.payload as { signature: `0x${string}` };
    const n = secp256k1.Point.CURVE().n;
    const s = BigInt(`0x${good.signature.slice(66, 130)}`);
    const v = good.signature.slice(130) === "1b" ? "1c" : "1b";
    const highS = `${good.signature.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${v}`;
    const typed = buildTransferAuthorization(requirement(), PAYER, {
      now: NOW,
      nonce: `0x${"ab".repeat(32)}`,
    });
    // Mathematically valid, but not what FiatToken's ECRecover accepts.
    expect(recoverTypedDataSigner(typed, highS)).toBeNull();
    const result = await verifyPayment(
      pay({ signature: highS }).header,
      [requirement()],
      deps(),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid_exact_evm_payload_signature",
    });
  });

  it.each([
    ["not base64 JSON", "%%%", "invalid_payload"],
    ["no header", null, "invalid_payload"],
    [
      "version 1",
      encodeHeader({ ...pay().payload, x402Version: 1 }),
      "invalid_x402_version",
    ],
    [
      "an unknown top-level field",
      encodeHeader({ ...pay().payload, bonus: true }),
      "invalid_payload",
    ],
    [
      "a payload without authorization",
      encodeHeader({ ...pay().payload, payload: { signature: "0x" } }),
      "invalid_payload",
    ],
  ])("fails closed on %s", async (_name, header, reason) => {
    expect(await verifyPayment(header, [requirement()], deps())).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("refuses a replayed nonce, a short balance, a failing simulation and a missing RPC", async () => {
    const replay = chain();
    replay.mine(
      `0xe3ee160e${PAYER.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64 * 4)}${"ab".repeat(32)}`,
    );
    expect(
      await verifyPayment(
        pay().header,
        [requirement()],
        deps({ rpc: { evm: replay.rpc } }),
      ),
    ).toMatchObject({ ok: false, reason: "invalid_transaction_state" });
    expect(
      await verifyPayment(
        pay().header,
        [requirement()],
        deps({ rpc: { evm: chain({ balance: 9_999n }).rpc } }),
      ),
    ).toMatchObject({ ok: false, reason: "insufficient_funds" });
    expect(
      await verifyPayment(
        pay().header,
        [requirement()],
        deps({ rpc: { evm: chain({ revert: true }).rpc } }),
      ),
    ).toMatchObject({ ok: false, reason: "invalid_transaction_state" });
    expect(
      await verifyPayment(pay().header, [requirement()], deps({ rpc: {} })),
    ).toMatchObject({ ok: false, reason: "invalid_network" });
    const garbled = {
      async call() {
        return "0x1";
      },
    };
    expect(
      await verifyPayment(
        pay().header,
        [requirement()],
        deps({ rpc: { evm: garbled } }),
      ),
    ).toMatchObject({ ok: false, reason: "unexpected_verify_error" });
  });
});

describe("settlePayment, EVM exact", () => {
  it("hands transferWithAuthorization to submit and reports the hash", async () => {
    const submitted: X402EvmCall[] = [];
    const d = deps({
      submit: async (tx) => {
        submitted.push(tx);
        return `0x${"11".repeat(32)}`;
      },
    });
    const verified = await verifyPayment(pay().header, [requirement()], d);
    if (!verified.ok) throw new Error(verified.detail);
    const { settlement, header } = await settlePayment(verified, d);
    expect(settlement).toEqual({
      success: true,
      transaction: `0x${"11".repeat(32)}`,
      network: "eip155:84532",
      payer: PAYER,
    });
    expect(decodeHeader(header)).toEqual(settlement);

    // The calldata carries the authorization and a signature from `from`.
    const [tx] = submitted as [X402EvmCall];
    expect(tx).toMatchObject({ chainId: 84532, to: USDC });
    const words = tx.data.slice(10).match(/.{64}/g) as string[];
    expect(tx.data.slice(0, 10)).toBe("0xe3ee160e");
    expect(words).toHaveLength(9);
    const typed = buildTransferAuthorization(requirement(), PAYER, {
      now: NOW,
      nonce: `0x${words[5]}`,
    });
    const signature = `0x${words[7]}${words[8]}${BigInt(`0x${words[6]}`).toString(16)}`;
    expect(recoverTypedDataSigner(typed, signature)?.toLowerCase()).toBe(
      PAYER.toLowerCase(),
    );
  });

  it("settles a payload once, even while the first settlement is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let submits = 0;
    const d = deps({
      submit: async () => {
        submits++;
        await gate;
        return `0x${"22".repeat(32)}`;
      },
    });
    const a = await verifyPayment(pay().header, [requirement()], d);
    const b = await verifyPayment(pay().header, [requirement()], d);
    if (!a.ok || !b.ok) throw new Error("verify");
    const first = settlePayment(a, d);
    const second = await settlePayment(b, d);
    release();
    expect((await first).settlement.success).toBe(true);
    expect(second.settlement).toMatchObject({
      success: false,
      errorReason: "duplicate_settlement",
      transaction: "",
    });
    expect(submits).toBe(1);
  });

  it("fails closed on a forged result, an expired authorization, no submit and a bad hash", async () => {
    const forged = {
      ok: true,
      requirement: requirement(),
      payer: PAYER,
      payload: pay().payload,
    } as unknown as X402VerifiedPayment;
    const submit = async () => `0x${"33".repeat(32)}`;
    expect(
      (await settlePayment(forged, deps({ submit }))).settlement,
    ).toMatchObject({ success: false, errorReason: "invalid_payload" });

    const verified = await verifyPayment(pay().header, [requirement()], deps());
    if (!verified.ok) throw new Error(verified.detail);
    expect(
      (await settlePayment(verified, deps({ submit, now: () => NOW + 60 })))
        .settlement,
    ).toMatchObject({
      success: false,
      errorReason: "invalid_exact_evm_payload_authorization_valid_before",
    });
    expect((await settlePayment(verified, deps())).settlement).toMatchObject({
      success: false,
      errorReason: "unexpected_settle_error",
    });
    expect(
      (await settlePayment(verified, deps({ submit: async () => "pending" })))
        .settlement,
    ).toMatchObject({ success: false, errorReason: "unexpected_settle_error" });
    expect(
      (
        await settlePayment(
          verified,
          deps({
            submit: async () => {
              throw new Error("reverted");
            },
          }),
        )
      ).settlement,
    ).toMatchObject({ success: false, errorReason: "unexpected_settle_error" });
  });
});

describe("round trip with createX402Fetch", () => {
  async function sessionKeySigner() {
    const manager = new SessionKeyManager(
      { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true, encryptionKey: "k" },
      new MemoryStorageAdapter(),
    );
    const owner = "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18" as const;
    const info = await manager.createSessionKey(
      {
        allowedContracts: [USDC],
        allowedChainIds: [84532],
        tokenAllowances: { [USDC]: 1_000_000n },
        allowedRecipients: [PAYEE],
      },
      owner,
    );
    await manager.setAuthorization(info.id, {
      signerAddress: owner,
      type: "offchain",
      rawSignature: `0x${"12".repeat(65)}`,
      message: "test",
    });
    return sessionKeyX402Signer(manager, info.id);
  }

  it("pays, verifies, settles and returns the receipt", async () => {
    const signer = await sessionKeySigner();
    const token = chain();
    const submitted: X402EvmCall[] = [];
    const serverDeps: X402ServerDeps = {
      rpc: { evm: token.rpc },
      store: memorySettlementStore(),
      submit: async (tx) => {
        submitted.push(tx);
        token.mine(tx.data);
        return `0x${"44".repeat(32)}`;
      },
    };
    const accepts = [requirement()];
    const server = async (input: RequestInfo | URL) => {
      const gate = await requirePayment(input as Request, {
        accepts,
        deps: serverDeps,
        resource: { url: URL_, description: "Premium data" },
      });
      if (!gate.paid) return gate.response;
      const { settlement, header } = await settlePayment(
        gate.payment,
        serverDeps,
      );
      return new Response(settlement.success ? "data" : "{}", {
        status: settlement.success ? 200 : 402,
        headers: { [PAYMENT_RESPONSE_HEADER]: header },
      });
    };
    let sent = "";
    const x402Fetch = createX402Fetch({
      signer,
      fetch: (async (input: RequestInfo | URL) => {
        sent = (input as Request).headers.get(PAYMENT_SIGNATURE_HEADER) ?? sent;
        return server(input);
      }) as typeof fetch,
    });
    const result = await x402Fetch(URL_);
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("data");
    expect(result.settlement).toEqual({
      success: true,
      transaction: `0x${"44".repeat(32)}`,
      network: "eip155:84532",
      payer: signer.address,
    });
    expect(submitted).toHaveLength(1);

    // The same PAYMENT-SIGNATURE again: the nonce is spent on chain, so it
    // is refused at verification and nothing is submitted.
    expect(sent).not.toBe("");
    const replay = await server(
      new Request(URL_, { headers: { [PAYMENT_SIGNATURE_HEADER]: sent } }),
    );
    expect(replay.status).toBe(402);
    expect(
      decodeHeader(replay.headers.get(PAYMENT_REQUIRED_HEADER) ?? ""),
    ).toMatchObject({ error: "invalid_transaction_state" });
    expect(submitted).toHaveLength(1);
  });

  it("answers a request without payment with the challenge", async () => {
    const gate = await requirePayment(new Request(URL_), {
      accepts: [requirement()],
      deps: deps(),
    });
    expect(gate.paid).toBe(false);
    if (gate.paid) return;
    expect(gate.response.status).toBe(402);
    expect(
      decodeHeader(gate.response.headers.get(PAYMENT_REQUIRED_HEADER) ?? ""),
    ).toMatchObject({ resource: { url: URL_ }, accepts: [requirement()] });
    const garbage = await requirePayment(
      new Request(URL_, { headers: { [PAYMENT_SIGNATURE_HEADER]: "%%%" } }),
      { accepts: [requirement()], deps: deps() },
    );
    expect(garbage).toMatchObject({ paid: false, reason: "invalid_payload" });
    if (!garbage.paid) expect(garbage.response.status).toBe(400);
  });
});
