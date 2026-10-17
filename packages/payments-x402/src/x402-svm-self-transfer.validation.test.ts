/**
 * Validation for payments-x402/svm/self-transfer-settlement-credit
 * (NEEDS-VALIDATION.md run2, line 377). Run without OS sandbox: in-process,
 * no network, RPC stubbed, dummy keys only, nothing broadcast.
 *
 * Scope: only the x402 verifier/settler mechanism is exercised. Whether the
 * real SPL Token / Token-2022 runtime executes a delegated TransferChecked
 * whose source equals its destination, and what it does to balances or the
 * delegated allowance, is NOT observable here; the simulation below is a
 * mock and is not decisive. Whether any merchant delegates its payTo ATA to
 * a lower-trust principal is a deployment question this file cannot answer.
 */
import {
  associatedTokenAddress,
  buildSplTransferTransaction,
  parseSolanaTransaction,
  SOLANA_MAINNET,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
} from "@naculus/connect-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { encodeHeader, type X402PaymentRequirements } from "./index";
import {
  memorySettlementStore,
  settlePayment,
  verifyPayment,
  type X402ServerDeps,
} from "./server/index";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAY_TO = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const URL_ = "https://example.com/weather";
// Dummy delegate (the payer/authority) and fee payer keys, test-only.
const DELEGATE_SEED = new Uint8Array(32).fill(7);
const FEE_SEED = new Uint8Array(32).fill(5);
const DELEGATE = base58.encode(ed25519.getPublicKey(DELEGATE_SEED));
const FEE_PAYER = base58.encode(ed25519.getPublicKey(FEE_SEED));
const MEMO = "pi_3abc123def456";
const TOKEN = SOLANA_PROGRAMS.token;
const PAY_TO_ATA = associatedTokenAddress(PAY_TO, USDC, TOKEN);
const DELEGATE_ATA = associatedTokenAddress(DELEGATE, USDC, TOKEN);

function requirement(): X402PaymentRequirements {
  return {
    scheme: "exact",
    network: SOLANA_MAINNET,
    amount: "1000",
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { feePayer: FEE_PAYER, memo: MEMO },
  };
}

/** SPL token account bytes; optional delegate with a delegated amount. */
function tokenAccount(
  owner: string,
  amount: bigint,
  delegate?: { address: string; amount: bigint },
) {
  const data = new Uint8Array(165);
  const view = new DataView(data.buffer);
  data.set(base58.decode(USDC), 0);
  data.set(base58.decode(owner), 32);
  view.setBigUint64(64, amount, true);
  if (delegate) {
    view.setUint32(72, 1, true);
    data.set(base58.decode(delegate.address), 76);
    view.setBigUint64(121, delegate.amount, true);
  }
  data[108] = 1;
  return { owner: TOKEN, data };
}

/** payTo's ATA is funded and delegated to DELEGATE; delegate also funded. */
function cluster() {
  const mint = new Uint8Array(82);
  mint[44] = 6;
  mint[45] = 1;
  const sent: string[] = [];
  const accounts = new Map<string, { owner: string; data: Uint8Array }>([
    [USDC, { owner: TOKEN, data: mint }],
    [
      PAY_TO_ATA,
      tokenAccount(PAY_TO, 5_000n, { address: DELEGATE, amount: 5_000n }),
    ],
    [DELEGATE_ATA, tokenAccount(DELEGATE, 5_000n)],
  ]);
  const rpc: Required<SolanaPaymentRpc> = {
    getGenesisHash: async () => MAINNET_GENESIS,
    getLatestBlockhash: async () => BLOCKHASH,
    getAccountInfo: async (address) => accounts.get(address) ?? null,
    // Mocked: says nothing about real token-program semantics.
    simulateTransaction: async () => ({ err: null }),
    sendTransaction: async (tx) => {
      sent.push(tx);
      const parsed = parseSolanaTransaction(base64.decode(tx));
      return base58.encode(parsed.signatures[0] as Uint8Array);
    },
  };
  return { rpc, sent };
}

async function signAsFeePayer(wire: Uint8Array): Promise<Uint8Array> {
  const tx = parseSolanaTransaction(wire);
  const out = wire.slice();
  out.set(ed25519.sign(tx.message, FEE_SEED), 1);
  return out;
}

function deps(rpc: SolanaPaymentRpc): X402ServerDeps {
  return {
    rpc: { solana: rpc },
    signAsFeePayer,
    confirmSolana: async () => true,
    store: memorySettlementStore(),
  };
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

type Parsed = ReturnType<typeof parseSolanaTransaction>;

function serialize(tx: Parsed): Uint8Array {
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

/**
 * The exact x402 layout; with `selfTransfer`, the TransferChecked source is
 * rewritten to payTo's ATA so source === destination, authority = DELEGATE.
 */
function pay(selfTransfer: boolean): string {
  const built = parseSolanaTransaction(
    buildSplTransferTransaction({
      feePayer: FEE_PAYER,
      authority: DELEGATE,
      mint: USDC,
      tokenProgram: TOKEN,
      decimals: 6,
      recipient: PAY_TO,
      amount: 1000n,
      memo: MEMO,
      recentBlockhash: BLOCKHASH,
    }),
  );
  const tx: Parsed = {
    ...built,
    accountKeys: [...built.accountKeys],
    instructions: built.instructions.map((ix) => ({
      ...ix,
      accounts: [...ix.accounts],
    })),
  };
  if (selfTransfer) {
    const transfer = tx.instructions.find(
      (ix) => ix.program === TOKEN && ix.accounts.length === 4,
    );
    if (!transfer || transfer.accounts[0] !== DELEGATE_ATA) {
      throw new Error("fixture: unexpected transfer layout");
    }
    transfer.accounts[0] = PAY_TO_ATA;
    // The old source was a writable non-signer; drop it from the key list.
    tx.accountKeys = tx.accountKeys.filter((k) => k !== DELEGATE_ATA);
  }
  const wire = serialize(tx);
  const parsed = parseSolanaTransaction(wire);
  const at = parsed.accountKeys.indexOf(DELEGATE);
  wire.set(ed25519.sign(parsed.message, DELEGATE_SEED), 1 + 64 * at);
  return encodeHeader({
    x402Version: 2,
    resource: { url: URL_ },
    accepted: requirement(),
    payload: { transaction: base64.encode(wire) },
  });
}

function transferAccounts(header: string): string[] {
  const decoded = JSON.parse(
    new TextDecoder().decode(base64.decode(header)),
  ) as { payload: { transaction: string } };
  const tx = parseSolanaTransaction(base64.decode(decoded.payload.transaction));
  const transfer = tx.instructions.find(
    (ix) => ix.program === TOKEN && ix.accounts.length === 4,
  );
  return transfer?.accounts ?? [];
}

describe("validation: payments-x402/svm/self-transfer-settlement-credit", () => {
  it("fixture: the self-transfer has source === destination === payTo's ATA", () => {
    const [source, , destination, authority] = transferAccounts(pay(true));
    expect(source).toBe(PAY_TO_ATA);
    expect(destination).toBe(PAY_TO_ATA);
    expect(authority).toBe(DELEGATE);
  });

  it("control: a normal distinct-source payment verifies", async () => {
    const { rpc } = cluster();
    expect(
      await verifyPayment(pay(false), [requirement()], deps(rpc)),
    ).toMatchObject({ ok: true, payer: DELEGATE });
  });

  // payments-x402/svm/self-transfer-settlement-credit: checkTransaction and the
  // RPC account checks have no source !== destination condition.
  it("verifyPayment refuses a transfer whose source is payTo's own ATA", async () => {
    const { rpc } = cluster();
    expect(
      await verifyPayment(pay(true), [requirement()], deps(rpc)),
    ).toMatchObject({ ok: false });
  });

  // payments-x402/svm/self-transfer-settlement-credit: settleSvm treats a
  // (mocked) successful simulation and confirmation as payment without
  // measuring recipient net credit.
  it("settlePayment does not report success for a payTo self-transfer", async () => {
    const { rpc, sent } = cluster();
    const d = deps(rpc);
    const verified = await verifyPayment(pay(true), [requirement()], d);
    let success = false;
    if (verified.ok) {
      const { settlement } = await settlePayment(verified, d);
      success = settlement.success;
    }
    expect(success).toBe(false);
    expect(sent).toEqual([]);
  });
});
