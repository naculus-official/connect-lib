import {
  MemoryStorageAdapter,
  SessionKeyManager,
  type SessionKeyScope,
  sessionKeyAddress,
  typedDataDigest,
} from "@naculus/connect-core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  buildChargeAuthorization,
  challengeNonce,
  createMppFetch,
  decodeBase64UrlJson,
  encodeBase64UrlJson,
  type MppChallenge,
  type MppCredential,
  type MppTypedDataSigner,
  PAYMENT_RECEIPT_HEADER,
  parseAuthenticate,
  parsePaymentChallenges,
  parsePaymentReceipt,
  selectCharge,
  sessionKeyMppSigner,
  unsupportedReason,
} from "./index";

// Verbatim from draft-httpauth-payment-01 §Example Challenge (folded lines
// joined, as a field value arrives).
const SPEC_CHALLENGE =
  'Payment id="x7Tg2pLqR9mKvNwY3hBcZa", realm="api.example.com", method="example", intent="charge", expires="2025-01-15T12:05:00Z", request="eyJhbW91bnQiOiIxMDAwIiwiY3VycmVuY3kiOiJVU0QiLCJyZWNpcGllbnQiOiJhY2N0XzEyMyJ9"';

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const; // Base Sepolia
const PAYEE = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;
const OTHER = "0x3333333333333333333333333333333333333333" as const;
const OWNER = "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18" as const;
const URL_ = "https://api.example.com/data";
const NOW = Date.parse("2026-09-26T12:00:00Z");
const EXPIRES = "2026-09-26T12:05:00Z";

function request(over: Record<string, unknown> = {}, details = {}) {
  return encodeBase64UrlJson({
    amount: "10000",
    currency: USDC,
    recipient: PAYEE,
    methodDetails: {
      chainId: 84532,
      credentialTypes: ["authorization"],
      ...details,
    },
    ...over,
  });
}

function header(over: Record<string, string> = {}): string {
  const params = {
    id: "aB3cDeF4gHiJkLmN",
    realm: "api.example.com",
    method: "evm",
    intent: "charge",
    request: request(),
    expires: EXPIRES,
    ...over,
  };
  return `Payment ${Object.entries(params)
    .map(([k, v]) => `${k}="${v}"`)
    .join(", ")}`;
}

function one(value: string): MppChallenge {
  const { challenges, rejected } = parsePaymentChallenges(value);
  expect(rejected).toEqual([]);
  return challenges[0] as MppChallenge;
}

describe("WWW-Authenticate parsing", () => {
  it("reads the spec's example challenge", () => {
    const c = one(SPEC_CHALLENGE);
    expect(c.params).toEqual({
      id: "x7Tg2pLqR9mKvNwY3hBcZa",
      realm: "api.example.com",
      method: "example",
      intent: "charge",
      expires: "2025-01-15T12:05:00Z",
      request:
        "eyJhbW91bnQiOiIxMDAwIiwiY3VycmVuY3kiOiJVU0QiLCJyZWNpcGllbnQiOiJhY2N0XzEyMyJ9",
    });
    expect(c.request).toEqual({
      amount: "1000",
      currency: "USD",
      recipient: "acct_123",
    });
    expect(c.expiresAt).toBe(Date.parse("2025-01-15T12:05:00Z"));
  });

  it("splits several challenges in one field, among other schemes", () => {
    // Headers.get joins repeated fields with ", ".
    const h = new Headers();
    h.append("WWW-Authenticate", 'Bearer realm="x", error="invalid_token"');
    h.append("WWW-Authenticate", header({ id: "first" }));
    h.append("WWW-Authenticate", "Negotiate abc==");
    h.append("WWW-Authenticate", header({ id: "second", method: "tempo" }));
    const raw = parseAuthenticate(h.get("WWW-Authenticate") as string);
    expect(raw.map((c) => c.scheme)).toEqual([
      "Bearer",
      "Payment",
      "Negotiate",
      "Payment",
    ]);
    const { challenges } = parsePaymentChallenges(h.get("WWW-Authenticate"));
    expect(challenges.map((c) => c.params.id)).toEqual(["first", "second"]);
  });

  it("unescapes quoted-pairs and accepts token values", () => {
    const raw = parseAuthenticate(
      'Payment id=abc, realm="a\\"b", method=evm, intent=charge, request=e30',
    );
    expect(raw[0]?.params).toMatchObject({ id: "abc", realm: 'a"b' });
  });

  it("rejects a challenge with a duplicated parameter", () => {
    const { challenges, rejected } = parsePaymentChallenges(
      `${header()}, amount="1"`.replace('amount="1"', 'method="evm"'),
    );
    expect(challenges).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/method appears twice/);
  });

  it.each([
    ["an unterminated quote", 'Payment id="abc'],
    ["a parameter without a value", "Payment id=, realm=x"],
    ["garbage between challenges", 'Payment id="a" ; realm="b"'],
    ["an escaped control character", 'Payment id="a\\\u0001b"'],
  ])("throws on %s", (_name, value) => {
    expect(() => parsePaymentChallenges(value)).toThrow(
      expect.objectContaining({ code: "invalid_challenge" }),
    );
  });

  it.each([
    ["a missing id", header({ id: "" }), /id is empty/],
    ["an uppercase method", header({ method: "EVM" }), /lowercase/],
    ["a padded request", header({ request: `${request()}=` }), /request/],
    ["an unknown header field", header({ header: "X-Pay" }), /header/],
    ["an unreadable expires", header({ expires: "tomorrow" }), /RFC 3339/],
    [
      "an opaque that is not a string map",
      header({ opaque: encodeBase64UrlJson({ a: 1 }) }),
      /opaque/,
    ],
  ])("refuses a challenge with %s", (_name, value, reason) => {
    const { challenges, rejected } = parsePaymentChallenges(value);
    expect(challenges).toEqual([]);
    expect(rejected[0]?.reason).toMatch(reason);
  });

  it("throws when a 402 carries no Payment challenge", () => {
    expect(() => parsePaymentChallenges(null)).toThrow();
    expect(() => parsePaymentChallenges('Bearer realm="x"')).toThrow(
      /no Payment challenge/,
    );
  });

  it("round-trips base64url JSON without padding", () => {
    const value = { a: "é?>", b: [1, 2] };
    const encoded = encodeBase64UrlJson(value);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBase64UrlJson(encoded)).toEqual(value);
    expect(decodeBase64UrlJson(`${encoded}==`)).toBeNull();
    expect(decodeBase64UrlJson("a+b/")).toBeNull();
  });

  it("reads a receipt and refuses a malformed one", () => {
    const receipt = {
      status: "success",
      method: "evm",
      timestamp: "2026-09-26T12:00:01Z",
      reference: `0x${"ab".repeat(32)}`,
      challengeId: "aB3cDeF4gHiJkLmN",
      chainId: 84532,
    };
    expect(parsePaymentReceipt(encodeBase64UrlJson(receipt))).toEqual(receipt);
    expect(parsePaymentReceipt(null)).toBeNull();
    expect(() =>
      parsePaymentReceipt(encodeBase64UrlJson({ ...receipt, status: "ok" })),
    ).toThrow(expect.objectContaining({ code: "invalid_receipt" }));
  });
});

describe("evm charge", () => {
  it("binds the nonce to the challenge as mppx does", () => {
    // keccak256(utf8(id + realm)), computed with viem.
    expect(
      challengeNonce({ id: "aB3cDeF4gHiJkLmN", realm: "api.example.com" }),
    ).toBe(
      "0x899e3a8fe6830644e150b972d4ba1fce69bcdf0bf9ea7f13d57cada71c6f281d",
    );
  });

  it("builds the authorization the challenge describes", () => {
    const selected = selectCharge([one(header())], { now: NOW });
    const from = "0x1111111111111111111111111111111111111111";
    expect(buildChargeAuthorization(selected, from, { now: NOW })).toEqual({
      domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: USDC,
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from,
        to: PAYEE,
        value: "10000",
        validAfter: "0",
        validBefore: String(Date.parse(EXPIRES) / 1000),
        nonce:
          "0x899e3a8fe6830644e150b972d4ba1fce69bcdf0bf9ea7f13d57cada71c6f281d",
      },
    });
  });

  it("lives 300 s when the challenge has no expiry", () => {
    const c = one(header());
    delete c.params.expires;
    delete c.expiresAt;
    const typed = buildChargeAuthorization(
      selectCharge([c], { now: NOW }),
      OTHER,
      { now: NOW },
    );
    expect(typed.message.validBefore).toBe(String(NOW / 1000 + 300));
  });

  it.each([
    ["another method", header({ method: "tempo" }), /method tempo/],
    ["another intent", header({ intent: "session" }), /intent session/],
    [
      "an expired challenge",
      header({ expires: "2026-09-26T11:59:59Z" }),
      /expired/,
    ],
    [
      "a challenge expiring within the current second",
      header({ expires: "2026-09-26T12:00:00.900Z" }),
      /expired/,
    ],
    [
      "no authorization credential type",
      header({
        request: request({}, { credentialTypes: ["permit2", "transaction"] }),
      }),
      /EIP-3009/,
    ],
    [
      "absent credential types",
      header({ request: request({}, { credentialTypes: undefined }) }),
      /EIP-3009/,
    ],
    [
      "splits",
      header({
        request: request({}, { splits: [{ recipient: OTHER, amount: "1" }] }),
      }),
      /splits/,
    ],
    [
      "a zero amount",
      header({ request: request({ amount: "0" }) }),
      /positive/,
    ],
    [
      "a non-decimal amount",
      header({ request: request({ amount: "1e3" }) }),
      /decimal/,
    ],
    [
      "a bad recipient",
      header({ request: request({ recipient: "acct_1" }) }),
      /recipient/,
    ],
    [
      "a string chain id",
      header({ request: request({}, { chainId: "84532" }) }),
      /chainId/,
    ],
    [
      "a token with no known domain",
      header({ request: request({ currency: OTHER }) }),
      /no EIP-712 domain/,
    ],
  ])("refuses %s", (_name, value, reason) => {
    expect(unsupportedReason(one(value), { now: NOW })).toMatch(reason);
  });

  it("limits chains and takes a caller domain over the built-in one", () => {
    const c = one(header());
    expect(unsupportedReason(c, { now: NOW, chainIds: [8453] })).toMatch(
      /not in the allowed list/,
    );
    const custom = one(header({ request: request({ currency: OTHER }) }));
    const selected = selectCharge([custom], {
      now: NOW,
      tokenDomains: [
        { chainId: 84532, address: OTHER, name: "Other", version: "1" },
      ],
    });
    expect(selected.domain.name).toBe("Other");
  });

  it("selects the first payable challenge in the server's order", () => {
    const { challenges, rejected } = parsePaymentChallenges(
      `${header({ id: "a", method: "tempo" })}, ${header({ id: "b" })}, ${header({ id: "c" })}`,
    );
    expect(
      selectCharge(challenges, { now: NOW }, rejected).challenge.params.id,
    ).toBe("b");
    expect(() => selectCharge(challenges.slice(0, 1), { now: NOW })).toThrow(
      expect.objectContaining({ code: "no_acceptable_challenge" }),
    );
  });
});

// ── End to end with a real session key ─────────────────────────────

const scope: Partial<SessionKeyScope> = {
  allowedContracts: [USDC],
  tokenAllowances: { [USDC]: 25_000n },
  allowedRecipients: [PAYEE],
  allowedChainIds: [84532],
};

async function sessionSigner(over: Partial<SessionKeyScope> = {}) {
  const manager = new SessionKeyManager(
    { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true, encryptionKey: "k" },
    new MemoryStorageAdapter(),
  );
  const info = await manager.createSessionKey({ ...scope, ...over }, OWNER);
  await manager.setAuthorization(info.id, {
    signerAddress: OWNER,
    type: "offchain",
    rawSignature: `0x${"12".repeat(65)}`,
    message: "test",
  });
  return sessionKeyMppSigner(manager, info.id);
}

function server(
  challengeHeader: string,
  paid: (req: Request) => Response = () =>
    new Response("ok", {
      headers: {
        [PAYMENT_RECEIPT_HEADER]: encodeBase64UrlJson({
          status: "success",
          method: "evm",
          timestamp: "2026-09-26T12:00:01Z",
          reference: `0x${"ab".repeat(32)}`,
          challengeId: "aB3cDeF4gHiJkLmN",
          chainId: 84532,
        }),
      },
    }),
) {
  const seen: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req);
    if (seen.length === 1) {
      return new Response(null, {
        status: 402,
        headers: { "WWW-Authenticate": challengeHeader },
      });
    }
    return paid(req);
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

function credentialOf(req: Request, field = "Authorization"): MppCredential {
  const value = req.headers.get(field) as string;
  expect(value.startsWith("Payment ")).toBe(true);
  return decodeBase64UrlJson(value.slice(8)) as MppCredential;
}

describe("createMppFetch", () => {
  it("pays once with a credential that recovers to the session key", async () => {
    const signer = await sessionSigner();
    const expires = new Date(Date.now() + 120_000).toISOString();
    const { fetch, seen } = server(header({ expires }));
    const pay = createMppFetch({ signer, fetch });

    const result = await pay(URL_, { method: "POST", body: "q=1" });
    expect(result.response.status).toBe(200);
    expect(result.receipt?.reference).toBe(`0x${"ab".repeat(32)}`);
    expect(seen).toHaveLength(2);
    expect(await seen[1]?.text()).toBe("q=1");

    const credential = credentialOf(seen[1] as Request);
    // Every received parameter echoed unchanged; nothing added.
    expect(credential.challenge).toEqual(one(header({ expires })).params);
    const p = credential.payload as Record<string, string>;
    expect(p).toMatchObject({
      type: "authorization",
      from: signer.address,
      to: PAYEE,
      value: "10000",
      validAfter: "0",
      validBefore: String(Math.floor(Date.parse(expires) / 1000)),
      nonce: challengeNonce({
        id: "aB3cDeF4gHiJkLmN",
        realm: "api.example.com",
      }),
    });
    expect(credential.source).toBe(`did:pkh:eip155:84532:${signer.address}`);
    // The signature recovers to the session key over the EIP-3009 digest.
    // (Byte-level agreement with viem is checked outside vitest, where viem
    // is stubbed.)
    const digest = typedDataDigest({
      domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: USDC,
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: p.from as `0x${string}`,
        to: p.to as `0x${string}`,
        value: p.value as string,
        validAfter: p.validAfter as string,
        validBefore: p.validBefore as string,
        nonce: p.nonce as `0x${string}`,
      },
    });
    const sig = hexToBytes((p.signature as string).slice(2));
    const recovered = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact")
      .addRecoveryBit((sig[64] as number) - 27)
      .recoverPublicKey(hexToBytes(digest.slice(2)));
    const recoveredAddress = sessionKeyAddress(`0x${recovered.toHex(true)}`);
    expect(recoveredAddress).toBe(signer.address.toLowerCase());
  });

  it("sends the credential in Payment-Authorization when the challenge says so", async () => {
    const signer = await sessionSigner();
    const expires = new Date(Date.now() + 120_000).toISOString();
    const { fetch, seen } = server(
      header({ expires, header: "Payment-Authorization" }),
    );
    await createMppFetch({ signer, fetch })(URL_, {
      headers: { Authorization: "Bearer app-token" },
    });
    expect(seen[1]?.headers.get("Authorization")).toBe("Bearer app-token");
    expect(
      credentialOf(seen[1] as Request, "Payment-Authorization").challenge
        .header,
    ).toBe("Payment-Authorization");
  });

  it("passes a response through when no payment is asked for", async () => {
    const signer = await sessionSigner();
    const fetch = (async () => new Response("free")) as typeof globalThis.fetch;
    const result = await createMppFetch({ signer, fetch })(URL_);
    expect(result).toMatchObject({ paid: null, receipt: null });
  });

  it("does not pay a payee the session key's policy excludes", async () => {
    const signer = await sessionSigner();
    const expires = new Date(Date.now() + 120_000).toISOString();
    const { fetch, seen } = server(
      header({ expires, request: request({ recipient: OTHER }) }),
    );
    await expect(createMppFetch({ signer, fetch })(URL_)).rejects.toMatchObject(
      {
        code: "session_key_scope_exceeded",
      },
    );
    expect(seen).toHaveLength(1);
  });

  it("relies on the session key for the budget", async () => {
    const signer = await sessionSigner();
    const expires = new Date(Date.now() + 120_000).toISOString();
    const big = header({ expires, request: request({ amount: "30000" }) });
    await expect(
      createMppFetch({ signer, fetch: server(big).fetch })(URL_),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
  });

  it("refuses a challenge that outlives the session key", async () => {
    const signer = await sessionSigner({
      expiry: Math.floor(Date.now() / 1000) + 60,
    });
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    await expect(
      createMppFetch({ signer, fetch: server(header({ expires })).fetch })(
        URL_,
      ),
    ).rejects.toMatchObject({
      code: "session_key_scope_exceeded",
      details: expect.stringMatching(/outlives the session key/),
    });
  });

  it("pays at most once", async () => {
    const signer = await sessionSigner();
    const expires = new Date(Date.now() + 120_000).toISOString();
    const { fetch, seen } = server(
      header({ expires }),
      () =>
        new Response(
          JSON.stringify({
            detail: "Transfer amount does not match\u001b[31m",
          }),
          {
            status: 402,
            headers: {
              "content-type": "application/problem+json",
              "WWW-Authenticate": header({ id: "again", expires }),
            },
          },
        ),
    );
    const error = await createMppFetch({ signer, fetch })(URL_).then(
      () => {
        throw new Error("a refused payment must not resolve");
      },
      (e: unknown) => e as Error & { code: string },
    );
    expect(error.code).toBe("payment_rejected");
    expect(error.message).toMatch(/Transfer amount does not match/);
    expect(error.message.includes("\u001b")).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it("signs nothing when approve() declines", async () => {
    const signer: MppTypedDataSigner = {
      address: OTHER,
      signTypedData: async () => {
        throw new Error("must not sign");
      },
    };
    const expires = new Date(Date.now() + 120_000).toISOString();
    const { fetch, seen } = server(header({ expires }));
    await expect(
      createMppFetch({ signer, fetch, approve: () => false })(URL_),
    ).rejects.toMatchObject({ code: "payment_rejected" });
    expect(seen).toHaveLength(1);
  });

  it("refuses a challenge that arrived through a redirect", async () => {
    const signer = await sessionSigner();
    const expires = new Date(Date.now() + 120_000).toISOString();
    const fetch = (async () => {
      const r = new Response(null, {
        status: 402,
        headers: { "WWW-Authenticate": header({ expires }) },
      });
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    }) as typeof globalThis.fetch;
    await expect(createMppFetch({ signer, fetch })(URL_)).rejects.toMatchObject(
      {
        code: "invalid_challenge",
      },
    );
  });

  it("sends the paid retry with redirects disabled", async () => {
    const signer = await sessionSigner();
    const expires = new Date(Date.now() + 120_000).toISOString();
    const { fetch, seen } = server(header({ expires }));
    await createMppFetch({ signer, fetch })(URL_);
    expect(seen[1]?.redirect).toBe("error");
  });

  it("keeps a paid response whose receipt is malformed or for another challenge", async () => {
    const signer = await sessionSigner();
    const expires = new Date(Date.now() + 120_000).toISOString();
    for (const receipt of [
      "not-base64!",
      encodeBase64UrlJson({
        status: "success",
        method: "evm",
        timestamp: "t",
        reference: "r",
        challengeId: "someone-else",
      }),
    ]) {
      const { fetch } = server(
        header({ expires }),
        () =>
          new Response("ok", {
            headers: { [PAYMENT_RECEIPT_HEADER]: receipt },
          }),
      );
      const result = await createMppFetch({ signer, fetch })(URL_);
      expect(result.response.status).toBe(200);
      expect(result.receipt).toBeNull();
    }
  });

  it("refuses a signer that does not return 65 bytes", async () => {
    const signer: MppTypedDataSigner = {
      address: OTHER,
      signTypedData: async () => "0x1234",
    };
    const expires = new Date(Date.now() + 120_000).toISOString();
    await expect(
      createMppFetch({ signer, fetch: server(header({ expires })).fetch })(
        URL_,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
