import {
  associatedTokenAddress,
  parseSolanaTransaction,
  SOLANA_MAINNET,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
} from "@naculus/connect-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  createX402Fetch,
  decodeHeader,
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  selectRequirement,
  svmUnsupportedReason,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SolanaSigner,
} from "./index";

// From coinbase/x402 specs/schemes/exact/scheme_exact_svm.md.
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAY_TO = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const URL_ = "https://example.com/weather";
const SEED = new Uint8Array(32).fill(7);
const PAYER = base58.encode(ed25519.getPublicKey(SEED));

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
    extra: { feePayer: FEE_PAYER, memo: "pi_3abc123def456" },
    ...over,
  };
}

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

/** A wallet: signs whatever it is given, in its own signature slot. */
function wallet(
  tamper: (wire: Uint8Array) => Uint8Array = (w) => w,
): X402SolanaSigner & { seen: Uint8Array[] } {
  const seen: Uint8Array[] = [];
  return {
    address: PAYER,
    seen,
    async signTransaction(transaction) {
      seen.push(transaction);
      const wire = tamper(transaction);
      const tx = parseSolanaTransaction(wire);
      const out = wire.slice();
      out.set(
        ed25519.sign(tx.message, SEED),
        1 + 64 * tx.accountKeys.indexOf(PAYER),
      );
      return out;
    },
  };
}

function paywall(accepts: unknown[] = [requirement()]) {
  const seen: Request[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const request = input as Request;
    seen.push(request);
    if (!request.headers.get(PAYMENT_SIGNATURE_HEADER)) {
      return new Response(null, {
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER]: encodeHeader({
            x402Version: 2,
            resource: { url: URL_ },
            accepts,
          }),
        },
      });
    }
    return new Response("sunny");
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

describe("x402 exact on Solana", () => {
  it("validates the requirement the spec describes", () => {
    expect(svmUnsupportedReason(requirement())).toBeNull();
    expect(svmUnsupportedReason(requirement({ extra: {} }))).toMatch(
      /feePayer/,
    );
    expect(svmUnsupportedReason(requirement({ amount: "0" }))).toMatch(/u64/);
    expect(svmUnsupportedReason(requirement({ asset: "0xabc" }))).toMatch(
      /mint/,
    );
    expect(
      svmUnsupportedReason(requirement({ network: "solana:short" })),
    ).toMatch(/cluster/);
  });

  it("selects Solana only when a Solana signer is configured", () => {
    const required = {
      x402Version: 2 as const,
      resource: { url: URL_ },
      accepts: [requirement()],
    };
    expect(() => selectRequirement(required)).toThrow(/no Solana signer/);
    expect(selectRequirement(required, { solana: true })).toEqual(
      requirement(),
    );
  });

  it("pays with a wallet-signed TransferChecked the facilitator can settle", async () => {
    const signer = wallet();
    const { fetch, seen } = paywall();
    const result = await createX402Fetch({
      solana: { signer, rpc: rpc() },
      fetch,
    })(URL_);
    expect(result.response.status).toBe(200);
    expect(signer.seen).toHaveLength(1);
    const payload = decodeHeader(
      seen[1]?.headers.get(PAYMENT_SIGNATURE_HEADER) ?? "",
    ) as X402PaymentPayload;
    expect(payload.accepted).toEqual(requirement());
    const tx = parseSolanaTransaction(
      base64.decode(payload.payload.transaction as string),
    );
    expect(tx.accountKeys[0]).toBe(FEE_PAYER);
    // Partially signed: the facilitator's slot is still empty.
    expect(tx.signatures[0]?.every((b) => b === 0)).toBe(true);
    expect(
      ed25519.verify(
        tx.signatures[1] as Uint8Array,
        tx.message,
        base58.decode(PAYER),
      ),
    ).toBe(true);
    const transfer = tx.instructions[2];
    expect(transfer?.accounts[2]).toBe(
      associatedTokenAddress(PAY_TO, USDC, SOLANA_PROGRAMS.token),
    );
    expect(new TextDecoder().decode(tx.instructions[3]?.data)).toBe(
      "pi_3abc123def456",
    );
  });

  it("uses a fresh random memo when the seller sets none", async () => {
    const signer = wallet();
    const req = requirement({ extra: { feePayer: FEE_PAYER } });
    const pay = createX402Fetch({
      solana: { signer, rpc: rpc() },
      fetch: paywall([req]).fetch,
    });
    await pay(URL_);
    await createX402Fetch({
      solana: { signer, rpc: rpc() },
      fetch: paywall([req]).fetch,
    })(URL_);
    const memos = signer.seen.map((w) =>
      new TextDecoder().decode(parseSolanaTransaction(w).instructions[3]?.data),
    );
    expect(memos[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(memos[0]).not.toBe(memos[1]);
  });

  it("refuses to sign when the RPC serves another cluster", async () => {
    const signer = wallet();
    await expect(
      createX402Fetch({
        solana: {
          signer,
          rpc: rpc("EtWTRABZaYq6iMfeYKouRu166VU2xqa1xxxxxxxxxxxx"),
        },
        fetch: paywall().fetch,
      })(URL_),
    ).rejects.toMatchObject({ code: "chain_mismatch" });
    expect(signer.seen).toHaveLength(0);
  });

  it("refuses a fee payer that is the payer itself", async () => {
    const signer = wallet();
    const req = requirement({ extra: { feePayer: PAYER } });
    await expect(
      createX402Fetch({
        solana: { signer, rpc: rpc() },
        fetch: paywall([req]).fetch,
      })(URL_),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
    expect(signer.seen).toHaveLength(0);
  });

  it("refuses what a wallet returns if it is not the payment", async () => {
    // The wallet signs a transaction whose amount byte was changed.
    const signer = wallet((w) => {
      const out = w.slice();
      const tx = parseSolanaTransaction(w);
      const data = tx.instructions[2]?.data as Uint8Array;
      const at = indexOf(out, data);
      out[at + 1] = (out[at + 1] as number) + 1;
      return out;
    });
    const { fetch, seen } = paywall();
    await expect(
      createX402Fetch({ solana: { signer, rpc: rpc() }, fetch })(URL_),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(seen).toHaveLength(1);
  });

  it("does not pay Solana requirements with only an EVM signer", () => {
    const required = {
      x402Version: 2 as const,
      resource: { url: URL_ },
      accepts: [requirement()],
    };
    expect(() => selectRequirement(required, { evm: true })).toThrow(
      /no Solana signer/,
    );
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
