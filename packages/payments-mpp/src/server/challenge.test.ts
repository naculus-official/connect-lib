import { describe, expect, it } from "vitest";
import { parsePaymentChallenges } from "../wire";
import {
  buildChallenge,
  canonicalJson,
  challengeBindingInput,
  createChallenge,
  paymentRequiredResponse,
  problemResponse,
  PaymentProblem,
  receiptHeaders,
} from "./index";

// draft-httpauth-payment-01 §HMAC-SHA256 Test Vectors (mpp-specs fe0d414).
const VECTOR = {
  realm: "api.example.com",
  method: "tempo",
  intent: "charge" as const,
  request: { amount: "1000000" },
  secret: "test-vector-secret",
};

function idOf(value: string): string {
  const { challenges } = parsePaymentChallenges(value);
  return challenges[0]?.params.id as string;
}

describe("challenge binding (spec test vectors)", () => {
  it("serializes the vector request as the spec does", () => {
    const params = buildChallenge(VECTOR);
    expect(params.request).toBe("eyJhbW91bnQiOiIxMDAwMDAwIn0");
    expect(challengeBindingInput(params)).toBe(
      "api.example.com|tempo|charge|eyJhbW91bnQiOiIxMDAwMDAwIn0|||",
    );
  });

  it("legacy layout: neither header nor opaque", () => {
    expect(idOf(createChallenge(VECTOR))).toBe(
      "X6v1eo7fJ76gAxqY0xN9Jd__4lUyDDYmriryOM-5FO4",
    );
  });

  it("with header=Payment-Authorization", () => {
    const params = buildChallenge({
      ...VECTOR,
      header: "Payment-Authorization",
    });
    expect(challengeBindingInput(params)).toBe(
      "api.example.com|tempo|charge|eyJhbW91bnQiOiIxMDAwMDAwIn0|||Payment-Authorization|",
    );
    expect(
      idOf(createChallenge({ ...VECTOR, header: "Payment-Authorization" })),
    ).toBe("S91xi-OFGZPMs-j7GsX0FDpIkmCcZT1P9XyV58WNy_U");
  });

  it("with header and opaque", () => {
    const input = {
      ...VECTOR,
      header: "Payment-Authorization" as const,
      opaque: { pi: "pi_123" },
    };
    expect(buildChallenge(input).opaque).toBe("eyJwaSI6InBpXzEyMyJ9");
    expect(idOf(createChallenge(input))).toBe(
      "CJ4X1O4aTDmS59hfdhnhBtxIQjWDOf0bcrhsswwMOW8",
    );
  });

  it("does not bind description", () => {
    expect(
      idOf(createChallenge({ ...VECTOR, description: "Premium call" })),
    ).toBe("X6v1eo7fJ76gAxqY0xN9Jd__4lUyDDYmriryOM-5FO4");
  });

  it("changes the id with every bound parameter", () => {
    const base = idOf(createChallenge(VECTOR));
    for (const over of [
      { realm: "api.example.org" },
      { request: { amount: "1000001" } },
      { expires: "2026-09-26T12:05:00Z" },
      { digest: "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:" },
      { opaque: { pi: "pi_124" } },
      { secret: "test-vector-secreT" },
    ]) {
      expect(idOf(createChallenge({ ...VECTOR, ...over }))).not.toBe(base);
    }
  });
});

describe("canonicalJson (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units, recursively", () => {
    expect(
      canonicalJson({ b: [3, { z: 1, a: null }], a: true, "€": "x", B: 1 }),
    ).toBe('{"B":1,"a":true,"b":[3,{"a":null,"z":1}],"€":"x"}');
  });

  it("uses ECMAScript number and string forms", () => {
    expect(canonicalJson([1e21, 0.1, -0, 1.5e-7, '\u0001\n"\\'])).toBe(
      '[1e+21,0.1,0,1.5e-7,"\\u0001\\n\\"\\\\"]',
    );
  });

  it.each([
    ["undefined", { a: undefined }],
    ["NaN", [Number.NaN]],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["a lone surrogate", ["\ud800"]],
    ["a Date", { at: new Date(0) }],
    ["a bigint", [1n]],
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case
    ["an array hole", [1, , 2]],
  ])("refuses %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe("createChallenge", () => {
  const evm = {
    realm: "api.example.com",
    method: "evm",
    intent: "charge" as const,
    request: {
      amount: "10000",
      currency: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      recipient: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      methodDetails: { chainId: 84532, credentialTypes: ["authorization"] },
    },
    expires: new Date("2026-09-26T12:05:00Z"),
    secret: "0123456789abcdef-server",
  };

  it("emits a challenge the client parser reads back unchanged", () => {
    const value = createChallenge({
      ...evm,
      realm: 'shop "a\\b"',
      description: "One call",
      opaque: { order: "42" },
    });
    const { challenges, rejected } = parsePaymentChallenges(value);
    expect(rejected).toEqual([]);
    expect(challenges[0]?.params).toMatchObject({
      realm: 'shop "a\\b"',
      method: "evm",
      intent: "charge",
      expires: "2026-09-26T12:05:00.000Z",
      description: "One call",
    });
    expect(challenges[0]?.request).toEqual(evm.request);
  });

  it.each([
    ["a chain method without expires", { expires: undefined }],
    ["a request the client would refuse", { request: { amount: "0" } }],
    [
      "an EVM request without authorization",
      {
        request: {
          ...evm.request,
          methodDetails: { chainId: 84532, credentialTypes: ["permit2"] },
        },
      },
    ],
    ["another header", { header: "X-Payment" }],
    ["a non-ASCII realm", { realm: "é" }],
    ["a control character", { description: "a\nb" }],
    ["an uppercase method", { method: "EVM" }],
    ["a short secret", { secret: "too-short" }],
    ["an unreadable expires", { expires: "tomorrow" }],
    ["a nested opaque", { opaque: { a: { b: "c" } } }],
    [
      "a Solana request without tokenProgram",
      {
        method: "solana",
        request: {
          amount: "1",
          currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          recipient: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
          methodDetails: { decimals: 6 },
        },
      },
    ],
  ])("refuses %s", (_name, over) => {
    expect(() => createChallenge({ ...evm, ...over } as never)).toThrow(
      TypeError,
    );
  });
});

describe("problem responses", () => {
  it("answers 402 with problem JSON, fresh challenges and no-store", async () => {
    const challenge = createChallenge(VECTOR);
    const res = problemResponse(
      new PaymentProblem("verification-failed", "Amount mismatch"),
      [challenge],
    );
    expect(res.status).toBe(402);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("WWW-Authenticate")).toBe(challenge);
    expect(await res.json()).toEqual({
      type: "https://paymentauth.org/problems/verification-failed",
      title: "Verification Failed",
      status: 402,
      detail: "Amount mismatch",
    });
  });

  it("refuses a 402 without a challenge", () => {
    expect(() => paymentRequiredResponse([])).toThrow(TypeError);
  });

  it("hides unexpected errors behind internal-payment-error", async () => {
    const res = problemResponse(new Error("RPC key abc123 rejected"));
    expect(res.status).toBe(500);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const body = await res.json();
    expect(body.type).toBe(
      "https://paymentauth.org/problems/internal-payment-error",
    );
    expect(JSON.stringify(body)).not.toContain("abc123");
  });

  it("method-unsupported is a 400 without a challenge", () => {
    const res = problemResponse(new PaymentProblem("method-unsupported", "no"));
    expect(res.status).toBe(400);
  });

  it("marks receipts private", () => {
    const h = receiptHeaders("e30");
    expect(h.get("Payment-Receipt")).toBe("e30");
    expect(h.get("Cache-Control")).toBe("private");
  });
});
