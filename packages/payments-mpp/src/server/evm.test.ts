import { MemoryStorageAdapter, SessionKeyManager } from "@naculus/connect-core";
import { describe, expect, it } from "vitest";
import {
  createChargeCredential,
  createMppFetch,
  decodeBase64UrlJson,
  encodeBase64UrlJson,
  type MppCredential,
  type MppTypedDataSigner,
  parsePaymentChallenges,
  parsePaymentReceipt,
  type SelectedEvmCharge,
  selectCharge,
  sessionKeyMppSigner,
  type TokenDomain,
} from "../index";
import {
  createChallenge,
  type EvmSubmission,
  memoryReplayStore,
  type MppEvmRpc,
  type PaymentProblem,
  paymentRequiredResponse,
  problemResponse,
  receiptHeaders,
  settleCredential,
  type VerifiedCredential,
  type VerifyCredentialOptions,
  verifyCredential,
} from "./index";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const; // Base Sepolia
const PAYEE = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;
const OTHER = "0x3333333333333333333333333333333333333333" as const;
const OWNER = "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18" as const;
const SECRET = "server-binding-secret-0001";
const REALM = "api.example.com";
const URL_ = "https://api.example.com/data";

const REQUEST = {
  amount: "10000",
  currency: USDC,
  recipient: PAYEE,
  externalId: "order-7",
  methodDetails: { chainId: 84532, credentialTypes: ["authorization"] },
};
const OFFER = { method: "evm", request: REQUEST };

async function sessionSigner(
  tokens: readonly `0x${string}`[] = [USDC],
): Promise<MppTypedDataSigner> {
  const manager = new SessionKeyManager(
    { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true, encryptionKey: "k" },
    new MemoryStorageAdapter(),
  );
  const info = await manager.createSessionKey(
    {
      allowedContracts: [...tokens],
      tokenAllowances: Object.fromEntries(tokens.map((t) => [t, 1_000_000n])),
      allowedRecipients: [PAYEE],
      allowedChainIds: [84532],
    },
    OWNER,
  );
  await manager.setAuthorization(info.id, {
    signerAddress: OWNER,
    type: "offchain",
    rawSignature: `0x${"12".repeat(65)}`,
    message: "test",
  });
  return sessionKeyMppSigner(manager, info.id);
}

function chain(balance = 1_000_000n) {
  const used = new Set<string>();
  const submitted: EvmSubmission[] = [];
  const rpc: MppEvmRpc = {
    authorizationState: async ({ authorizer, nonce }) =>
      used.has(`${authorizer.toLowerCase()}:${nonce}`),
    balanceOf: async () => balance,
  };
  const submit = async (s: EvmSubmission) => {
    const key = `${s.from.toLowerCase()}:${s.nonce}`;
    if (used.has(key)) throw new Error("FiatTokenV2: authorization is used");
    used.add(key);
    submitted.push(s);
    return { transactionHash: `0x${"ab".repeat(32)}` };
  };
  return { rpc, submit, submitted, used };
}

function challenge(over: Record<string, unknown> = {}): string {
  return createChallenge({
    realm: REALM,
    method: "evm",
    intent: "charge",
    request: REQUEST,
    expires: new Date(Date.now() + 120_000),
    secret: SECRET,
    ...over,
  });
}

/** A real credential for `value`, signed by the session key. */
async function credentialFor(
  value: string,
  signer?: MppTypedDataSigner,
  tokenDomains?: readonly TokenDomain[],
): Promise<string> {
  const { challenges } = parsePaymentChallenges(value);
  const selected = selectCharge(
    challenges,
    tokenDomains ? { tokenDomains } : {},
  ) as SelectedEvmCharge;
  return (
    await createChargeCredential(selected, signer ?? (await sessionSigner()))
  ).value;
}

function edit(value: string, change: (c: MppCredential) => void): string {
  const c = decodeBase64UrlJson(value.slice(8)) as MppCredential;
  change(c);
  return `Payment ${encodeBase64UrlJson(c)}`;
}

function options(
  rpc: MppEvmRpc,
  over: Partial<VerifyCredentialOptions> = {},
): VerifyCredentialOptions {
  return {
    secret: SECRET,
    realm: REALM,
    accept: [OFFER],
    evm: { rpc },
    ...over,
  };
}

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

describe("verifyCredential, evm authorization", () => {
  it("accepts the client's credential and settles it", async () => {
    const { rpc, submit, submitted } = chain();
    const signer = await sessionSigner();
    const value = await credentialFor(challenge(), signer);
    const verified = await verifyCredential(value, options(rpc));
    expect(verified).toMatchObject({
      method: "evm",
      network: "eip155:84532",
      payer: signer.address,
      source: `did:pkh:eip155:84532:${signer.address}`,
    });
    const replay = memoryReplayStore();
    const settled = await settleCredential(verified, {
      replay,
      evm: { submit },
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      chainId: 84532,
      token: USDC,
      to: PAYEE,
      value: 10000n,
      validAfter: 0n,
    });
    expect(parsePaymentReceipt(settled.header)).toEqual({
      status: "success",
      method: "evm",
      timestamp: expect.any(String),
      reference: `0x${"ab".repeat(32)}`,
      challengeId: verified.challenge.id,
      chainId: 84532,
      externalId: "order-7",
    });
  });

  it("refuses the same credential twice", async () => {
    const { rpc, submit } = chain();
    const value = await credentialFor(challenge());
    const replay = memoryReplayStore();
    const first = await verifyCredential(value, options(rpc, { replay }));
    await settleCredential(first, { replay, evm: { submit } });
    // Early, from the replay store.
    expect(
      (await refusal(verifyCredential(value, options(rpc, { replay })))).code,
    ).toBe("invalid-challenge");
    // And from the chain, when the store is not consulted early.
    expect((await refusal(verifyCredential(value, options(rpc)))).code).toBe(
      "invalid-challenge",
    );
  });

  it("settles one of two concurrent requests with the same credential", async () => {
    const { rpc, submit, submitted } = chain();
    const value = await credentialFor(challenge());
    const replay = memoryReplayStore();
    const [a, b] = await Promise.all([
      verifyCredential(value, options(rpc)),
      verifyCredential(value, options(rpc)),
    ]);
    const results = await Promise.allSettled([
      settleCredential(a as VerifiedCredential, { replay, evm: { submit } }),
      settleCredential(b as VerifiedCredential, { replay, evm: { submit } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(submitted).toHaveLength(1);
  });

  describe("rejects any edited challenge parameter", () => {
    const cases: [string, (c: MppCredential) => void][] = [
      [
        "request (amount)",
        (c) => {
          c.challenge.request = encodeBase64UrlJson({
            ...REQUEST,
            amount: "1",
          });
        },
      ],
      [
        "realm",
        (c) => Object.assign(c.challenge, { realm: "api.example.org" }),
      ],
      ["method", (c) => Object.assign(c.challenge, { method: "tempo" })],
      ["intent", (c) => Object.assign(c.challenge, { intent: "session" })],
      [
        "expires",
        (c) => {
          c.challenge.expires = new Date(Date.now() + 9e6).toISOString();
        },
      ],
      [
        "digest (added)",
        (c) => Object.assign(c.challenge, { digest: "sha-256=:x:" }),
      ],
      [
        "header (added)",
        (c) => {
          c.challenge.header = "Payment-Authorization";
        },
      ],
      ["opaque (added)", (c) => Object.assign(c.challenge, { opaque: "e30" })],
      [
        "id",
        // Always a different last character: the id varies per run, and
        // one ending in "A" made a fixed "A" a no-op edit (1 run in 64).
        (c) =>
          Object.assign(c.challenge, {
            id: `${c.challenge.id.slice(0, -1)}${c.challenge.id.endsWith("A") ? "B" : "A"}`,
          }),
      ],
    ];
    it.each(cases)("%s", async (_name, change) => {
      const { rpc } = chain();
      const value = edit(await credentialFor(challenge()), change);
      expect((await refusal(verifyCredential(value, options(rpc)))).code).toBe(
        "invalid-challenge",
      );
    });

    it("opaque (removed)", async () => {
      const { rpc } = chain();
      const value = edit(
        await credentialFor(challenge({ opaque: { order: "7" } })),
        (c) => delete c.challenge.opaque,
      );
      expect((await refusal(verifyCredential(value, options(rpc)))).code).toBe(
        "invalid-challenge",
      );
    });

    it("but not description", async () => {
      const { rpc } = chain();
      const value = edit(
        await credentialFor(challenge({ description: "a" })),
        (c) => {
          c.challenge.description = "b";
        },
      );
      await expect(verifyCredential(value, options(rpc))).resolves.toBeTruthy();
    });
  });

  it("refuses a challenge issued under another secret, honours a previous one", async () => {
    const { rpc } = chain();
    const value = await credentialFor(
      challenge({ secret: "other-server-secret-0001" }),
    );
    expect((await refusal(verifyCredential(value, options(rpc)))).code).toBe(
      "invalid-challenge",
    );
    await expect(
      verifyCredential(
        value,
        options(rpc, { previousSecrets: ["other-server-secret-0001"] }),
      ),
    ).resolves.toBeTruthy();
  });

  it("refuses a challenge of another realm under the same secret", async () => {
    const { rpc } = chain();
    const value = await credentialFor(
      challenge({ realm: "cheap.example.com" }),
    );
    expect(
      (await refusal(verifyCredential(value, options(rpc)))).detail,
    ).toMatch(/another realm/);
  });

  it("refuses a genuine challenge for another resource", async () => {
    const { rpc } = chain();
    const cheap = { ...REQUEST, amount: "1" };
    const value = await credentialFor(challenge({ request: cheap }));
    const p = await refusal(verifyCredential(value, options(rpc)));
    expect(p.code).toBe("invalid-challenge");
    expect(p.detail).toMatch(/not for this resource/);
  });

  it("accepts the credential only in the field the challenge selected", async () => {
    const { rpc } = chain();
    const plain = await credentialFor(challenge());
    expect(
      (
        await refusal(
          verifyCredential(
            plain,
            options(rpc, { field: "Payment-Authorization" }),
          ),
        )
      ).code,
    ).toBe("invalid-challenge");
    const selected = await credentialFor(
      challenge({ header: "Payment-Authorization" }),
    );
    expect((await refusal(verifyCredential(selected, options(rpc)))).code).toBe(
      "invalid-challenge",
    );
    await expect(
      verifyCredential(
        selected,
        options(rpc, { field: "Payment-Authorization" }),
      ),
    ).resolves.toBeTruthy();
  });

  it("refuses an expired challenge", async () => {
    const { rpc } = chain();
    const value = await credentialFor(challenge());
    const p = await refusal(
      verifyCredential(value, options(rpc, { now: Date.now() + 121_000 })),
    );
    expect(p.code).toBe("payment-expired");
  });

  it("checks the body digest when the challenge binds one", async () => {
    const { rpc } = chain();
    const digest = "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:";
    const value = await credentialFor(challenge({ digest }));
    for (const given of [undefined, "sha-256=:AAAA:"]) {
      expect(
        (
          await refusal(
            verifyCredential(
              value,
              options(rpc, given ? { digest: given } : {}),
            ),
          )
        ).code,
      ).toBe("verification-failed");
    }
    await expect(
      verifyCredential(value, options(rpc, { digest })),
    ).resolves.toBeTruthy();
  });

  it.each<[string, (p: Record<string, unknown>) => void, string]>([
    ["to", (p) => Object.assign(p, { to: OTHER }), "verification-failed"],
    [
      "value",
      (p) => Object.assign(p, { value: "9999" }),
      "verification-failed",
    ],
    [
      "nonce",
      (p) => Object.assign(p, { nonce: `0x${"11".repeat(32)}` }),
      "verification-failed",
    ],
    [
      "validBefore beyond expires",
      (p) => {
        p.validBefore = String(Math.floor(Date.now() / 1000) + 9999);
      },
      "verification-failed",
    ],
    [
      "validAfter in the future",
      (p) => {
        p.validAfter = String(Math.floor(Date.now() / 1000) + 60);
      },
      "verification-failed",
    ],
    [
      "a signature by another key",
      (p) => {
        const sig = p.signature as string;
        p.signature = `${sig.slice(0, 10)}${sig[10] === "a" ? "b" : "a"}${sig.slice(11)}`;
      },
      "verification-failed",
    ],
    ["from", (p) => Object.assign(p, { from: OTHER }), "verification-failed"],
    [
      "type permit2",
      (p) => Object.assign(p, { type: "permit2" }),
      "invalid-payload",
    ],
    ["type hash", (p) => Object.assign(p, { type: "hash" }), "invalid-payload"],
    [
      "a short signature",
      (p) => Object.assign(p, { signature: "0x1234" }),
      "invalid-payload",
    ],
    [
      "a numeric value",
      (p) => Object.assign(p, { value: 10000 }),
      "invalid-payload",
    ],
  ])("refuses an edited payload: %s", async (_name, change, code) => {
    const { rpc } = chain();
    const value = edit(await credentialFor(challenge()), (c) =>
      change(c.payload),
    );
    expect((await refusal(verifyCredential(value, options(rpc)))).code).toBe(
      code,
    );
  });

  it("refuses a source that is not the signer", async () => {
    const { rpc } = chain();
    const value = edit(await credentialFor(challenge()), (c) => {
      c.source = `did:pkh:eip155:84532:${OTHER}`;
    });
    expect(
      (await refusal(verifyCredential(value, options(rpc)))).detail,
    ).toMatch(/source/);
  });

  it("refuses a payer without the balance", async () => {
    const { rpc } = chain(9_999n);
    const value = await credentialFor(challenge());
    expect(
      (await refusal(verifyCredential(value, options(rpc)))).detail,
    ).toMatch(/balance/);
  });

  it("refuses a token not known to implement EIP-3009", async () => {
    const { rpc } = chain();
    const request = { ...REQUEST, currency: OTHER };
    const domain = { chainId: 84532, address: OTHER, name: "X", version: "1" };
    const value = await credentialFor(
      challenge({ request }),
      await sessionSigner([OTHER]),
      [domain],
    );
    const accept = [{ method: "evm", request }];
    expect(
      (await refusal(verifyCredential(value, options(rpc, { accept })))).detail,
    ).toMatch(/not a token this server accepts/);
    // Accepted once the server declares the token's domain.
    await expect(
      verifyCredential(
        value,
        options(rpc, { accept, evm: { rpc, tokenDomains: [domain] } }),
      ),
    ).resolves.toBeTruthy();
  });

  it.each([
    ["no credential", null, "payment-required"],
    ["another scheme", "Bearer abc", "malformed-credential"],
    ["bad base64url", "Payment ab+/", "malformed-credential"],
    [
      "not JSON",
      `Payment ${btoa("nope").replace(/=+$/, "")}`,
      "malformed-credential",
    ],
    [
      "no payload",
      `Payment ${encodeBase64UrlJson({ challenge: {} })}`,
      "malformed-credential",
    ],
    [
      "a numeric challenge field",
      `Payment ${encodeBase64UrlJson({ challenge: { id: 1, realm: "r", method: "evm", intent: "charge", request: "e30" }, payload: {} })}`,
      "malformed-credential",
    ],
    [
      "an oversized value",
      `Payment ${"A".repeat(20_000)}`,
      "malformed-credential",
    ],
  ])("refuses %s", async (_name, value, code) => {
    const { rpc } = chain();
    expect(
      (await refusal(verifyCredential(value as string | null, options(rpc))))
        .code,
    ).toBe(code);
  });

  it("refuses a bound challenge of a method it does not verify", async () => {
    const { rpc } = chain();
    const tempo = createChallenge({
      realm: REALM,
      method: "tempo",
      intent: "charge",
      request: { amount: "1" },
      expires: new Date(Date.now() + 60_000),
      secret: SECRET,
    });
    const params = parsePaymentChallenges(tempo).challenges[0]?.params;
    const value = `Payment ${encodeBase64UrlJson({ challenge: params, payload: {} })}`;
    const p = await refusal(verifyCredential(value, options(rpc)));
    expect(p.code).toBe("method-unsupported");
    expect(p.status).toBe(400);
  });

  it("fails closed without evm.rpc, and hides RPC errors", async () => {
    const value = await credentialFor(challenge());
    const noRpc = await refusal(
      verifyCredential(value, options(undefined as never, { evm: undefined })),
    );
    expect(noRpc.code).toBe("internal-payment-error");
    const broken: MppEvmRpc = {
      authorizationState: async () => {
        throw new Error("node https://rpc/key-123 down");
      },
      balanceOf: async () => 0n,
    };
    const p = await refusal(verifyCredential(value, options(broken)));
    expect(p.code).toBe("internal-payment-error");
    expect(p.detail).not.toMatch(/key-123/);
    // An RPC answering something other than false is not "unused".
    const vague: MppEvmRpc = {
      authorizationState: async () => undefined as never,
      balanceOf: async () => 1_000_000n,
    };
    expect((await refusal(verifyCredential(value, options(vague)))).code).toBe(
      "invalid-challenge",
    );
  });

  it("settles only verifyCredential results, and needs a replay store", async () => {
    const { rpc, submit } = chain();
    const verified = await verifyCredential(
      await credentialFor(challenge()),
      options(rpc),
    );
    const forged = { ...verified } as VerifiedCredential;
    expect(
      (
        await refusal(
          settleCredential(forged, {
            replay: memoryReplayStore(),
            evm: { submit },
          }),
        )
      ).code,
    ).toBe("internal-payment-error");
    expect(
      (await refusal(settleCredential(verified, { evm: { submit } } as never)))
        .code,
    ).toBe("internal-payment-error");
  });
});

describe("round trip with createMppFetch (session key)", () => {
  function server() {
    const { rpc, submit, submitted } = chain();
    const replay = memoryReplayStore();
    const fresh = () => [challenge()];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const credential = req.headers.get("Authorization");
      if (!credential) return paymentRequiredResponse(fresh());
      try {
        const verified = await verifyCredential(credential, {
          secret: SECRET,
          realm: REALM,
          accept: [OFFER],
          evm: { rpc },
          replay,
        });
        const settled = await settleCredential(verified, {
          replay,
          evm: { submit },
        });
        return new Response("paid content", {
          headers: receiptHeaders(settled.header),
        });
      } catch (error) {
        return problemResponse(error, fresh());
      }
    };
    return { fetch: fetch as typeof globalThis.fetch, submitted };
  }

  it("pays once and receives the resource with a matching receipt", async () => {
    const { fetch, submitted } = server();
    const signer = await sessionSigner();
    const result = await createMppFetch({ signer, fetch })(URL_);
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("paid content");
    expect(result.response.headers.get("Cache-Control")).toBe("private");
    expect(result.receipt).toMatchObject({
      method: "evm",
      challengeId: result.paid?.challenge.params.id,
      reference: `0x${"ab".repeat(32)}`,
      chainId: 84532,
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.from).toBe(signer.address);
  });

  it("surfaces the server's problem detail when the payment is refused", async () => {
    const { fetch } = server();
    const signer = await sessionSigner();
    const lying: MppTypedDataSigner = {
      address: signer.address,
      signTypedData: async (req) =>
        signer.signTypedData({
          ...req,
          message: { ...req.message, nonce: `0x${"00".repeat(32)}` },
        }),
    };
    await expect(
      createMppFetch({ signer: lying, fetch })(URL_),
    ).rejects.toMatchObject({
      code: "payment_rejected",
      message: expect.stringMatching(/does not recover to from/),
    });
  });
});
