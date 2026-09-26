import {
  parseSolanaTransaction,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
} from "@naculus/connect-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  createMppFetch,
  decodeBase64UrlJson,
  encodeBase64UrlJson,
  type MppCredential,
  type MppSolanaSigner,
  parsePaymentChallenges,
  readSolanaRequest,
  selectCharge,
  unsupportedReason,
} from "./index";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const SERVER_BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SEED = new Uint8Array(32).fill(7);
const PAYER = base58.encode(ed25519.getPublicKey(SEED));
const URL_ = "https://api.example.com/data";

function request(details: Record<string, unknown> = {}, over = {}) {
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
    ...over,
  };
}

function header(req: object = request(), over: Record<string, string> = {}) {
  const expires = new Date(Date.now() + 120_000).toISOString();
  const params = {
    id: "sol-1",
    realm: "api.example.com",
    method: "solana",
    intent: "charge",
    request: encodeBase64UrlJson(req),
    expires,
    ...over,
  };
  return `Payment ${Object.entries(params)
    .map(([k, v]) => `${k}="${v}"`)
    .join(", ")}`;
}

function rpc(genesis = MAINNET_GENESIS, decimals = 6): SolanaPaymentRpc {
  const mint = new Uint8Array(82);
  mint[44] = decimals;
  mint[45] = 1;
  return {
    getGenesisHash: async () => genesis,
    getLatestBlockhash: async () => BLOCKHASH,
    getAccountInfo: async (address) =>
      address === USDC ? { owner: SOLANA_PROGRAMS.token, data: mint } : null,
  };
}

function wallet(
  tamper: (wire: Uint8Array) => Uint8Array = (w) => w,
): MppSolanaSigner & { seen: Uint8Array[] } {
  const seen: Uint8Array[] = [];
  return {
    address: PAYER,
    seen,
    async signTransaction(given) {
      seen.push(given);
      const wire = tamper(given);
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

function server(challenge: string) {
  const seen: Request[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    seen.push(input as Request);
    return seen.length === 1
      ? new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": challenge },
        })
      : new Response("ok");
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

function credential(req: Request): MppCredential {
  return decodeBase64UrlJson(
    (req.headers.get("Authorization") as string).slice(8),
  ) as MppCredential;
}

describe("MPP solana charge", () => {
  it("reads the request the spec describes", () => {
    expect(readSolanaRequest(request())).toEqual({
      amount: "250000",
      currency: USDC,
      recipient: RECIPIENT,
      network: SOLANA_MAINNET,
      decimals: 6,
      tokenProgram: SOLANA_PROGRAMS.token,
      feePayerKey: FEE_PAYER,
      externalId: "order-42",
    });
    expect(
      (readSolanaRequest(request({ network: "devnet" })) as { network: string })
        .network,
    ).toBe(SOLANA_DEVNET);
  });

  it.each([
    ["native SOL", request({}, { currency: "sol" }), /native SOL/],
    [
      "splits",
      request({ splits: [{ recipient: FEE_PAYER, amount: "1" }] }),
      /splits/,
    ],
    ["localnet", request({ network: "localnet" }), /localnet/],
    ["missing decimals", request({ decimals: undefined }), /decimals/],
    [
      "a fee payer flag without a key",
      request({ feePayerKey: undefined }),
      /feePayerKey/,
    ],
    ["a key without the flag", request({ feePayer: undefined }), /feePayerKey/],
    [
      "another token program",
      request({ tokenProgram: SOLANA_PROGRAMS.memo }),
      /token program/,
    ],
    [
      "an amount above u64",
      request({}, { amount: (1n << 64n).toString() }),
      /u64/,
    ],
  ])("refuses %s", (_name, req, reason) => {
    expect(readSolanaRequest(req)).toMatch(reason);
  });

  it("pays only with a Solana signer configured, on allowed clusters", () => {
    const { challenges } = parsePaymentChallenges(header());
    const c = challenges[0]!;
    expect(unsupportedReason(c)).toMatch(/no Solana signer/);
    expect(unsupportedReason(c, { solana: true })).toBeNull();
    expect(
      unsupportedReason(c, { solana: true, solanaNetworks: ["devnet"] }),
    ).toMatch(/allowed list/);
    expect(selectCharge(challenges, { solana: true }).method).toBe("solana");
  });

  it("pays a sponsored charge with a partially signed transfer", async () => {
    const signer = wallet();
    const { fetch, seen } = server(header());
    const result = await createMppFetch({
      solana: { signer, rpc: rpc() },
      fetch,
    })(URL_);
    expect(result.response.status).toBe(200);
    expect(result.paid?.method).toBe("solana");
    const c = credential(seen[1] as Request);
    expect(c.source).toBe(`did:pkh:${SOLANA_MAINNET}:${PAYER}`);
    expect(c.payload.type).toBe("transaction");
    const tx = parseSolanaTransaction(
      base64.decode(c.payload.transaction as string),
    );
    expect(tx.accountKeys[0]).toBe(FEE_PAYER);
    expect(tx.numRequiredSignatures).toBe(2);
    expect(tx.signatures[0]?.every((b) => b === 0)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    // externalId goes on chain as the memo.
    expect(new TextDecoder().decode(tx.instructions[3]?.data)).toBe("order-42");
  });

  it("pays its own fee, fully signed, when the server does not sponsor it", async () => {
    const signer = wallet();
    const req = request({ feePayer: undefined, feePayerKey: undefined });
    const { fetch, seen } = server(header(req));
    await createMppFetch({ solana: { signer, rpc: rpc() }, fetch })(URL_);
    const tx = parseSolanaTransaction(
      base64.decode(
        credential(seen[1] as Request).payload.transaction as string,
      ),
    );
    expect(tx.accountKeys[0]).toBe(PAYER);
    expect(tx.numRequiredSignatures).toBe(1);
  });

  it("ignores the server's recent blockhash for the checked RPC's", async () => {
    const signer = wallet();
    const { fetch } = server(
      header(request({ recentBlockhash: SERVER_BLOCKHASH })),
    );
    await createMppFetch({ solana: { signer, rpc: rpc() }, fetch })(URL_);
    // A devnet challenge must not get a mainnet blockhash signed.
    expect(parseSolanaTransaction(signer.seen[0]!).recentBlockhash).toBe(
      BLOCKHASH,
    );
  });

  it.each([
    [
      "the RPC serves another cluster",
      rpc("EtWTRABZaYq6iMfeYKouRu166VU2xqa1xxxxxxxxxxxx"),
      request(),
      "chain_mismatch",
    ],
    [
      "the mint's decimals differ",
      rpc(MAINNET_GENESIS, 9),
      request(),
      "invalid_challenge",
    ],
    [
      "the mint's token program differs",
      rpc(),
      request({ tokenProgram: SOLANA_PROGRAMS.token2022 }),
      "invalid_challenge",
    ],
    [
      "the fee payer is the payer",
      rpc(),
      request({ feePayerKey: PAYER }),
      "invalid_challenge",
    ],
  ])("signs nothing when %s", async (_name, solanaRpc, req, code) => {
    const signer = wallet();
    const { fetch, seen } = server(header(req));
    await expect(
      createMppFetch({ solana: { signer, rpc: solanaRpc }, fetch })(URL_),
    ).rejects.toMatchObject({ code });
    expect(signer.seen).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });

  it("refuses a wallet that adds a Lighthouse assertion (MPP servers reject it)", async () => {
    // Append a Lighthouse instruction the way Phantom does.
    const lighthouse = (w: Uint8Array) => {
      const tx = parseSolanaTransaction(w);
      const keys = [...tx.accountKeys, SOLANA_PROGRAMS.lighthouse];
      const ixs = [
        ...tx.instructions,
        {
          program: SOLANA_PROGRAMS.lighthouse,
          accounts: [],
          data: new Uint8Array([1]),
        },
      ];
      return new Uint8Array([
        tx.signatures.length,
        ...new Uint8Array(64 * tx.signatures.length),
        0x80,
        tx.numRequiredSignatures,
        tx.numReadonlySigned,
        tx.numReadonlyUnsigned + 1,
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
    };
    const { fetch, seen } = server(header());
    await expect(
      createMppFetch({
        solana: { signer: wallet(lighthouse), rpc: rpc() },
        fetch,
      })(URL_),
    ).rejects.toThrow(/added an instruction/);
    expect(seen).toHaveLength(1);
  });

  it("needs at least one signer", () => {
    expect(() => createMppFetch({} as never)).toThrow(/needs a signer/);
  });
});
