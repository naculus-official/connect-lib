import {
  assertSolanaCluster,
  buildSplTransferTransaction,
  isValidAddress,
  readMint,
  type SolanaPaymentRpc,
  type SplTransferPayment,
  verifySignedSplTransfer,
} from "@naculus/connect-core";
import {
  X402_VERSION,
  X402Error,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402PaymentRequirements,
} from "./wire";

/**
 * The x402 `exact` scheme on Solana (`specs/schemes/exact/scheme_exact_svm.md`):
 * the payer's wallet signs one SPL TransferChecked, with the facilitator as
 * fee payer; the facilitator adds its signature and settles.
 *
 * Signed by the connected wallet — every payment is a wallet prompt, and no
 * session-key policy applies (Solana session keys are STATE thread 18). What
 * the wallet returns is checked against the payment before it is sent: the
 * same transfer, fee payer, blockhash and memo, only Lighthouse assertions
 * added, and a valid signature from the payer.
 */

/** The Naculus Solana signer role (`SolanaSigner` in connector-solana). */
export interface X402SolanaSigner {
  /** The payer's base58 address. */
  address: string;
  /** Sign a wire transaction; resolves to the signed wire transaction. */
  signTransaction(transaction: Uint8Array): Promise<Uint8Array>;
}

export interface X402SolanaOptions {
  signer: X402SolanaSigner;
  /** Reads the mint, a blockhash and the cluster; `solanaPaymentRpc(url)`. */
  rpc: SolanaPaymentRpc;
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;

function isAddress(value: unknown): value is string {
  return typeof value === "string" && isValidAddress(value, "solana");
}

/** Why a Solana requirement is unusable by this client, or null. */
export function svmUnsupportedReason(
  requirement: X402PaymentRequirements,
): string | null {
  if (requirement.scheme !== "exact") {
    return `scheme ${requirement.scheme} is not supported`;
  }
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(requirement.network)) {
    return `network ${requirement.network} is not a Solana cluster`;
  }
  if (!isAddress(requirement.asset)) return "asset is not a mint address";
  if (!isAddress(requirement.payTo)) return "payTo is not a Solana address";
  if (
    !DECIMAL.test(requirement.amount) ||
    BigInt(requirement.amount) === 0n ||
    BigInt(requirement.amount) > U64_MAX
  ) {
    return "amount is not a positive u64";
  }
  const extra = requirement.extra ?? {};
  if (!isAddress(extra.feePayer)) {
    return "extra.feePayer (the facilitator's address) is required";
  }
  if (
    extra.memo !== undefined &&
    (typeof extra.memo !== "string" ||
      extra.memo === "" ||
      new TextEncoder().encode(extra.memo).length > 256)
  ) {
    return "extra.memo is not a 1 to 256 byte string";
  }
  return null;
}

function randomMemo(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the transfer `requirement` describes, have the wallet sign it, check
 * what it returned, and build the `PAYMENT-SIGNATURE` payload.
 */
export async function createSvmPaymentPayload(
  required: X402PaymentRequired,
  requirement: X402PaymentRequirements,
  solana: X402SolanaOptions,
): Promise<X402PaymentPayload> {
  const reason = svmUnsupportedReason(requirement);
  if (reason) throw new X402Error("no_acceptable_requirement", reason);
  const extra = requirement.extra as { feePayer: string; memo?: string };
  if (extra.feePayer === solana.signer.address) {
    throw new X402Error(
      "invalid_challenge",
      "The facilitator's fee payer is the payer itself.",
    );
  }
  await assertSolanaCluster(solana.rpc, requirement.network);
  const mintAccount = await solana.rpc.getAccountInfo(requirement.asset);
  if (!mintAccount) {
    throw new X402Error("invalid_challenge", "The asset mint does not exist.");
  }
  const { tokenProgram, decimals } = readMint(
    mintAccount.owner,
    mintAccount.data,
  );
  const payment: SplTransferPayment = {
    feePayer: extra.feePayer,
    authority: solana.signer.address,
    mint: requirement.asset,
    tokenProgram,
    decimals,
    recipient: requirement.payTo,
    amount: BigInt(requirement.amount),
    // Unique per payment unless the seller fixes it (spec: memo or nonce).
    memo: extra.memo ?? randomMemo(),
    recentBlockhash: await solana.rpc.getLatestBlockhash(),
  };
  const signed = await solana.signer.signTransaction(
    buildSplTransferTransaction(payment),
  );
  const transaction = verifySignedSplTransfer(signed, payment);
  return {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted: requirement,
    payload: { transaction },
    ...(required.extensions ? { extensions: required.extensions } : {}),
  };
}
