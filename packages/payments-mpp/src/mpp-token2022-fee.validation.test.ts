import {
  buildSplTransferTransaction,
  parseSolanaTransaction,
  readMint,
  SOLANA_PROGRAMS,
  type SplTransferPayment,
} from "@naculus/connect-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { encodeBase64UrlJson, parsePaymentChallenges } from "./index";
import {
  createChallenge,
  memoryReplayStore,
  settleCredential,
  verifyCredential,
} from "./server";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const SEED = new Uint8Array(32).fill(7);
const PAYER = base58.encode(ed25519.getPublicKey(SEED));
const SECRET = "public-validation-secret";
const REALM = "validation.example";

function request() {
  return {
    amount: "100",
    currency: MINT,
    recipient: RECIPIENT,
    methodDetails: {
      network: "mainnet",
      decimals: 6,
      tokenProgram: SOLANA_PROGRAMS.token2022,
    },
  };
}

function signedCredential(): string {
  const req = request();
  const challenge = createChallenge({
    realm: REALM,
    method: "solana",
    intent: "charge",
    request: req,
    expires: new Date(Date.now() + 120_000),
    secret: SECRET,
  });
  const payment: SplTransferPayment = {
    feePayer: PAYER,
    authority: PAYER,
    mint: MINT,
    tokenProgram: SOLANA_PROGRAMS.token2022,
    decimals: 6,
    recipient: RECIPIENT,
    amount: 100n,
    memo: null,
    recentBlockhash: BLOCKHASH,
  };
  const wire = buildSplTransferTransaction(payment);
  const parsed = parseSolanaTransaction(wire);
  wire.set(ed25519.sign(parsed.message, SEED), 1);
  const params = parsePaymentChallenges(challenge).challenges[0]?.params;
  return `Payment ${encodeBase64UrlJson({
    challenge: params,
    payload: { type: "transaction", transaction: base64.encode(wire) },
  })}`;
}

function feeBearingMint(): Uint8Array {
  const mint = new Uint8Array(270);
  mint[44] = 6;
  mint[45] = 1;
  mint[165] = 1;
  new DataView(mint.buffer).setUint16(166, 1, true);
  new DataView(mint.buffer).setUint16(168, 100, true);
  return mint;
}

function noFeeMint(): Uint8Array {
  const mint = new Uint8Array(82);
  mint[44] = 6;
  mint[45] = 1;
  return mint;
}

function mintRpc(data: Uint8Array) {
  return async (address: string) => {
    expect(address).toBe(MINT);
    return { owner: SOLANA_PROGRAMS.token2022, data };
  };
}

async function verify() {
  const req = request();
  const verified = await verifyCredential(signedCredential(), {
    secret: SECRET,
    realm: REALM,
    accept: [{ method: "solana", request: req }],
  });
  if (verified.method !== "solana") throw new Error("expected Solana");
  return verified;
}

describe("payments-mpp/server/solana:unchecked-token2022-transfer-fee", () => {
  it("accepts and settles a no-fee Token-2022 transfer control", async () => {
    const verified = await verify();
    const signature = base58.encode(verified.solana.transaction.slice(1, 65));
    let recipientCredit = 0n;
    const settled = await settleCredential(verified, {
      replay: memoryReplayStore(),
      solana: {
        rpc: {
          simulateTransaction: async () => ({ err: null }),
          sendTransaction: async () => {
            recipientCredit = 100n;
            return signature;
          },
          confirmTransaction: async () => true,
          getAccountInfo: mintRpc(noFeeMint()),
        },
      },
    });

    expect(settled.receipt.status).toBe("success");
    expect(recipientCredit).toBe(100n);
  });

  // payments-mpp/server/solana:unchecked-token2022-transfer-fee
  it("rejects settlement when a transfer fee makes net credit lower than the offer", async () => {
    const verified = await verify();
    const signature = base58.encode(verified.solana.transaction.slice(1, 65));
    let recipientCredit = 0n;
    const settlement = settleCredential(verified, {
      replay: memoryReplayStore(),
      solana: {
        rpc: {
          simulateTransaction: async () => ({ err: null }),
          sendTransaction: async () => {
            recipientCredit = 98n;
            return signature;
          },
          confirmTransaction: async () => true,
          getAccountInfo: mintRpc(feeBearingMint()),
        },
      },
    });

    await expect(settlement).rejects.toThrow(/TransferFeeConfig/);
    expect(recipientCredit).toBe(0n);
  });

  it("refuses a Token-2022 settlement when the RPC cannot read the mint", async () => {
    const verified = await verify();
    let sent = false;
    const settlement = settleCredential(verified, {
      replay: memoryReplayStore(),
      solana: {
        rpc: {
          simulateTransaction: async () => ({ err: null }),
          sendTransaction: async () => {
            sent = true;
            return "";
          },
          confirmTransaction: async () => true,
        },
      },
    });

    // settleCredential reports the missing dependency as an internal error.
    await expect(settlement).rejects.toThrow();
    expect(sent).toBe(false);
  });

  it("rejects the same TransferFeeConfig mint through readMint", () => {
    expect(() => readMint(SOLANA_PROGRAMS.token2022, feeBearingMint())).toThrow(
      /TransferFeeConfig/,
    );
  });
});
