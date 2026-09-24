import {
  MemoryStorageAdapter,
  SessionKeyManager,
  sessionKeyAddress,
  typedDataDigest,
} from "@naculus/connect-core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  buildTransferAuthorization,
  createX402Fetch,
  decodeHeader,
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  parsePaymentRequired,
  parseSettlementResponse,
  selectRequirement,
  sessionKeyX402Signer,
  unsupportedReason,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402PaymentRequirements,
} from "./index";

// Verbatim header values from coinbase/x402 specs/transports-v2/http.md.
const SPEC_REQUIRED =
  "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19";
const SPEC_SIGNATURE =
  "eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJlbWl1bS1kYXRhIiwiZGVzY3JpcHRpb24iOiJBY2Nlc3MgdG8gcHJlbWl1bSBtYXJrZXQgZGF0YSIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRlZCI6eyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHgwMzZDYkQ1Mzg0MmM1NDI2NjM0ZTc5Mjk1NDFlQzIzMThmM2RDRjdlIiwicGF5VG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIifX0sInBheWxvYWQiOnsic2lnbmF0dXJlIjoiMHgyZDZhNzU4OGQ2YWNjYTUwNWNiZjBkOWE0YTIyN2UwYzUyYzZjMzQwMDhjOGU4OTg2YTEyODMyNTk3NjQxNzM2MDhhMmNlNjQ5NjY0MmUzNzdkNmRhOGRiYmY1ODM2ZTliZDE1MDkyZjllY2FiMDVkZWQzZDYyOTNhZjE0OGI1NzFjIiwiYXV0aG9yaXphdGlvbiI6eyJmcm9tIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzODc5MWJEYmIwRTIyMzczZTM2YjY2IiwidG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJ2YWx1ZSI6IjEwMDAwIiwidmFsaWRBZnRlciI6IjE3NDA2NzIwODkiLCJ2YWxpZEJlZm9yZSI6IjE3NDA2NzIxNTQiLCJub25jZSI6IjB4ZjM3NDY2MTNjMmQ5MjBiNWZkYWJjMDg1NmYyYWViMmQ0Zjg4ZWU2MDM3YjhjYzVkMDRhNzFhNDQ2MmYxMzQ4MCJ9fX0=";
const SPEC_RESPONSE =
  "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWYxMjM0NTY3ODkwYWJjZGVmMTIzNDU2Nzg5MGFiY2RlZiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const PAYEE = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;
const OTHER = "0x3333333333333333333333333333333333333333" as const;
const SIGNER = "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18" as const;
const URL_ = "https://api.example.com/premium-data";

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

function challenge(
  accepts: unknown[] = [requirement()],
  over: Record<string, unknown> = {},
): string {
  return encodeHeader({
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: { url: URL_, description: "Premium data" },
    accepts,
    ...over,
  });
}

describe("wire format", () => {
  it("reads the spec's example challenge, payload and settlement", () => {
    const required = parsePaymentRequired(SPEC_REQUIRED);
    expect(required.accepts).toEqual([requirement()]);
    expect(required.resource.url).toBe(URL_);

    const payload = decodeHeader(SPEC_SIGNATURE) as X402PaymentPayload;
    expect(payload.accepted).toEqual(requirement());
    expect(Object.keys(payload.payload.authorization as object)).toEqual([
      "from",
      "to",
      "value",
      "validAfter",
      "validBefore",
      "nonce",
    ]);

    expect(parseSettlementResponse(SPEC_RESPONSE)).toMatchObject({
      success: true,
      network: "eip155:84532",
    });
  });

  it("round-trips non-ASCII JSON through a header", () => {
    const value = { description: "café ü € 資料" };
    expect(decodeHeader(encodeHeader(value))).toEqual(value);
  });

  it.each([
    ["no header", null],
    ["not base64 JSON", "%%%"],
    ["version 1", challenge(undefined, { x402Version: 1 })],
    ["accepts not an array", challenge(undefined, { accepts: {} })],
    ["no readable requirement", challenge([{ scheme: "exact" }])],
    ["no resource url", challenge(undefined, { resource: {} })],
  ])("refuses a challenge with %s", (_name, header) => {
    expect(() => parsePaymentRequired(header)).toThrow(
      expect.objectContaining({ code: "invalid_challenge" }),
    );
  });

  it("drops unreadable entries but keeps readable ones", () => {
    const required = parsePaymentRequired(
      challenge([{ scheme: "exact", amount: 5 }, requirement()]),
    );
    expect(required.accepts).toEqual([requirement()]);
  });

  it("refuses a malformed settlement response", () => {
    expect(parseSettlementResponse(null)).toBeNull();
    expect(() => parseSettlementResponse(encodeHeader({ ok: true }))).toThrow(
      expect.objectContaining({ code: "invalid_settlement" }),
    );
  });
});

describe("EVM exact requirements", () => {
  it.each([
    ["another scheme", { scheme: "upto" }, /scheme/],
    [
      "a Solana network",
      { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
      /EIP-155/,
    ],
    ["the any-chain form", { network: "eip155:0" }, /EIP-155/],
    [
      "Permit2",
      { extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } },
      /permit2/,
    ],
    ["no token domain", { extra: {} }, /extra.name/],
    ["a role instead of a payee", { payTo: "merchant" }, /payTo/],
    ["a fiat asset", { asset: "USD" }, /asset/],
    ["a zero amount", { amount: "0" }, /amount/],
    ["a non-canonical amount", { amount: "010" }, /amount/],
    ["an amount above uint256", { amount: (1n << 256n).toString() }, /amount/],
    ["no timeout", { maxTimeoutSeconds: 0 }, /maxTimeoutSeconds/],
  ])("refuses %s", (_name, over, reason) => {
    expect(unsupportedReason(requirement(over))).toMatch(reason);
  });

  it("accepts EIP-3009 explicitly or by default", () => {
    expect(unsupportedReason(requirement())).toBeNull();
    expect(
      unsupportedReason(
        requirement({
          extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
        }),
      ),
    ).toBeNull();
  });

  it("selects the first payable requirement in the server's order", () => {
    const required = parsePaymentRequired(
      challenge([
        requirement({ scheme: "upto" }),
        requirement({ network: "eip155:8453" }),
        requirement(),
      ]),
    );
    expect(selectRequirement(required).network).toBe("eip155:8453");
    expect(
      selectRequirement(required, { networks: ["eip155:84532"] }).network,
    ).toBe("eip155:84532");
    expect(() =>
      selectRequirement(required, { networks: ["eip155:1"] }),
    ).toThrow(expect.objectContaining({ code: "no_acceptable_requirement" }));
  });

  it("builds the EIP-3009 authorization the requirement describes", () => {
    const nonce = `0x${"ab".repeat(32)}` as const;
    expect(
      buildTransferAuthorization(requirement(), SIGNER, {
        now: 1_800_000_000,
        nonce,
      }),
    ).toEqual({
      domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: USDC,
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: SIGNER,
        to: PAYEE,
        value: "10000",
        validAfter: String(1_800_000_000 - 600),
        validBefore: String(1_800_000_000 + 60),
        nonce,
      },
    });
  });
});

// ── End to end, signed by a real session key under policy ─────────────

async function paySessionKey(scope: {
  allowedRecipients?: `0x${string}`[];
  tokenAllowances?: Record<`0x${string}`, bigint>;
}) {
  const manager = new SessionKeyManager(
    { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true, encryptionKey: "k" },
    new MemoryStorageAdapter(),
  );
  const info = await manager.createSessionKey(
    {
      allowedContracts: [USDC],
      allowedChainIds: [84532],
      tokenAllowances: { [USDC]: 1_000_000n },
      ...scope,
    },
    SIGNER,
  );
  await manager.setAuthorization(info.id, {
    signerAddress: SIGNER,
    type: "offchain",
    rawSignature: `0x${"12".repeat(65)}`,
    message: "test",
  });
  return {
    manager,
    info,
    signer: await sessionKeyX402Signer(manager, info.id),
  };
}

/** A resource that asks for payment, then serves it when paid. */
function paywall(options: { refuseSecond?: boolean; resource?: string } = {}) {
  const seen: Request[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const request = input as Request;
    seen.push(request);
    const paid = request.headers.get(PAYMENT_SIGNATURE_HEADER);
    if (!paid || options.refuseSecond) {
      return new Response(null, {
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER]: challenge(undefined, {
            resource: { url: options.resource ?? URL_ },
          }),
          ...(paid
            ? {
                [PAYMENT_RESPONSE_HEADER]: encodeHeader({
                  success: false,
                  errorReason: "insufficient_funds",
                  transaction: "",
                  network: "eip155:84532",
                }),
              }
            : {}),
        },
      });
    }
    return new Response("data", {
      status: 200,
      headers: {
        [PAYMENT_RESPONSE_HEADER]: encodeHeader({
          success: true,
          transaction: `0x${"cd".repeat(32)}`,
          network: "eip155:84532",
        }),
      },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

describe("createX402Fetch", () => {
  it("pays once with a signature that recovers to the session key", async () => {
    const { info, signer } = await paySessionKey({
      allowedRecipients: [PAYEE],
    });
    const { fetch, seen } = paywall();
    const pay = createX402Fetch({ signer, fetch });

    const result = await pay(URL_, { method: "POST", body: "query" });
    expect(result.response.status).toBe(200);
    expect(result.paid).toEqual(requirement());
    expect(result.settlement?.success).toBe(true);
    expect(seen).toHaveLength(2);
    // The retry carries the same body.
    expect(await seen[1]?.text()).toBe("query");

    const payload = decodeHeader(
      seen[1]?.headers.get(PAYMENT_SIGNATURE_HEADER) ?? "",
    ) as X402PaymentPayload;
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(requirement());
    const auth = payload.payload.authorization as {
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
    const self = sessionKeyAddress(info.publicKey);
    expect(auth.from).toBe(self);
    expect(auth.to).toBe(PAYEE);
    expect(auth.value).toBe("10000");

    const digest = typedDataDigest({
      domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: USDC,
      },
      primaryType: "TransferWithAuthorization",
      message: auth,
    });
    const sig = hexToBytes((payload.payload.signature as string).slice(2));
    const recovered = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact")
      .addRecoveryBit(sig[64]! - 27)
      .recoverPublicKey(hexToBytes(digest.slice(2)));
    expect(sessionKeyAddress(`0x${recovered.toHex(true)}`)).toBe(self);
  });

  it("passes a response through when no payment is asked for", async () => {
    const { signer } = await paySessionKey({});
    let calls = 0;
    const pay = createX402Fetch({
      signer,
      fetch: (async () => {
        calls += 1;
        return new Response("free");
      }) as typeof globalThis.fetch,
    });
    const result = await pay(URL_);
    expect(result.paid).toBeNull();
    expect(calls).toBe(1);
  });

  it("does not pay a payee the session key's policy excludes", async () => {
    const { signer } = await paySessionKey({ allowedRecipients: [OTHER] });
    const { fetch, seen } = paywall();
    await expect(
      createX402Fetch({ signer, fetch })(URL_),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    expect(seen).toHaveLength(1);
  });

  it("refuses a challenge for another origin", async () => {
    const { signer } = await paySessionKey({});
    const { fetch, seen } = paywall({ resource: "https://evil.example/x" });
    await expect(
      createX402Fetch({ signer, fetch })(URL_),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
    expect(seen).toHaveLength(1);
  });

  it("pays at most once", async () => {
    const { signer } = await paySessionKey({});
    const { fetch, seen } = paywall({ refuseSecond: true });
    await expect(
      createX402Fetch({ signer, fetch })(URL_),
    ).rejects.toMatchObject({
      code: "payment_rejected",
      message: expect.stringMatching(/insufficient_funds/),
    });
    expect(seen).toHaveLength(2);
  });

  it("signs nothing when approve() declines", async () => {
    const { signer } = await paySessionKey({});
    let signed = false;
    const { fetch, seen } = paywall();
    const pay = createX402Fetch({
      signer: {
        address: signer.address,
        signTypedData: async (req) => {
          signed = true;
          return signer.signTypedData(req);
        },
      },
      fetch,
      approve: (req: X402PaymentRequirements, required: X402PaymentRequired) =>
        req.amount !== "10000" && required.accepts.length > 0,
    });
    await expect(pay(URL_)).rejects.toMatchObject({ code: "payment_rejected" });
    expect(signed).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("refuses a challenge that arrived through a redirect", async () => {
    // An open redirect on the requested origin leads to a server that names
    // the original resource; the paid retry would follow it back there.
    const { signer } = await paySessionKey({});
    const { fetch, seen } = paywall();
    const redirected = (async (input: RequestInfo | URL) => {
      const response = await fetch(input);
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    }) as typeof globalThis.fetch;
    await expect(
      createX402Fetch({ signer, fetch: redirected })(URL_),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
    expect(seen).toHaveLength(1);
  });

  it("sends the paid retry with redirects disabled", async () => {
    const { signer } = await paySessionKey({});
    const { fetch, seen } = paywall();
    await createX402Fetch({ signer, fetch })(URL_);
    expect(seen[1]?.redirect).toBe("error");
  });

  it("keeps a paid response whose receipt is malformed", async () => {
    const { signer } = await paySessionKey({});
    const { fetch } = paywall();
    const badReceipt = (async (input: RequestInfo | URL) => {
      const response = await fetch(input);
      if (response.status !== 200) return response;
      return new Response("data", {
        status: 200,
        headers: { [PAYMENT_RESPONSE_HEADER]: "not-json" },
      });
    }) as typeof globalThis.fetch;
    const result = await createX402Fetch({ signer, fetch: badReceipt })(URL_);
    expect(result.response.status).toBe(200);
    expect(result.paid).toEqual(requirement());
    expect(result.settlement).toBeNull();
  });

  it("echoes the challenge's extensions unchanged", async () => {
    const { signer } = await paySessionKey({});
    const extensions = { bazaar: { discoverable: true } };
    const seen: Request[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      const request = input as Request;
      seen.push(request);
      return request.headers.get(PAYMENT_SIGNATURE_HEADER)
        ? new Response("ok")
        : new Response(null, {
            status: 402,
            headers: {
              [PAYMENT_REQUIRED_HEADER]: challenge(undefined, { extensions }),
            },
          });
    }) as typeof globalThis.fetch;
    await createX402Fetch({ signer, fetch })(URL_);
    const payload = decodeHeader(
      seen[1]?.headers.get(PAYMENT_SIGNATURE_HEADER) ?? "",
    ) as X402PaymentPayload;
    expect(payload.extensions).toEqual(extensions);
  });

  it("refuses a signer that does not return 65 bytes", async () => {
    const { fetch, seen } = paywall();
    const pay = createX402Fetch({
      signer: { address: SIGNER, signTypedData: async () => "0x1234" },
      fetch,
    });
    await expect(pay(URL_)).rejects.toMatchObject({ code: "invalid_input" });
    expect(seen).toHaveLength(1);
  });

  it("relies on the session key for budget and lifetime", async () => {
    // No allowance entry for the token: the key refuses, nothing is sent.
    const noBudget = await paySessionKey({ tokenAllowances: {} });
    const first = paywall();
    await expect(
      createX402Fetch({ signer: noBudget.signer, fetch: first.fetch })(URL_),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    expect(first.seen).toHaveLength(1);

    // A timeout that outlives the session key is refused by the key too.
    const { signer } = await paySessionKey({});
    const second = paywall();
    const longTimeout = (async (input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.headers.get(PAYMENT_SIGNATURE_HEADER)) {
        return second.fetch(input);
      }
      second.seen.push(request);
      return new Response(null, {
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER]: challenge([
            requirement({ maxTimeoutSeconds: 10 * 365 * 24 * 3600 }),
          ]),
        },
      });
    }) as typeof globalThis.fetch;
    await expect(
      createX402Fetch({ signer, fetch: longTimeout })(URL_),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    expect(second.seen).toHaveLength(1);
  });
});
