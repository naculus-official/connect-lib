import {
  assertSolanaCluster,
  buildSplTransferTransaction,
  isValidAddress,
  readMint,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
  type SplTransferPayment,
  verifySignedSplTransfer,
} from "@naculus/connect-core";
import {
  encodeCredential,
  isRecord,
  type MppChallenge,
  MppError,
} from "./wire";

/**
 * MPP `method="solana"`, `intent="charge"`, pull mode (`type="transaction"`)
 * for SPL tokens (tempoxyz/mpp-specs `draft-solana-charge-00` at 08e7dd8).
 *
 * The connected wallet signs one TransferChecked to the recipient's
 * associated token account — a wallet prompt per payment, no session-key
 * policy (Solana session keys are STATE thread 18). With `feePayer: true`
 * the server's `feePayerKey` pays the fee and co-signs; otherwise the payer
 * does and the transaction is fully signed. What the wallet returns is checked
 * against the payment before it is sent.
 *
 * The blockhash always comes from the app's RPC, whose cluster was checked;
 * the server's advisory `recentBlockhash` is ignored. Wallets that inject
 * Lighthouse instructions (Phantom, Solflare) are refused here, because MPP
 * servers reject them.
 *
 * Refused: native SOL (`currency: "sol"`), `splits`, push mode and
 * confidential transfers, `localnet` (no cluster id to check the RPC
 * against), and any challenge whose mint does not match its stated
 * `decimals` / `tokenProgram`.
 */

/** The Naculus Solana signer role (`SolanaSigner` in connector-solana). */
export interface MppSolanaSigner {
  /** The payer's base58 address. */
  address: string;
  /** Sign a wire transaction; resolves to the signed wire transaction. */
  signTransaction(transaction: Uint8Array): Promise<Uint8Array>;
}

export type MppSolanaNetwork = "mainnet" | "devnet";

export interface MppSolanaOptions {
  signer: MppSolanaSigner;
  /** Reads the mint, a blockhash and the cluster; `solanaPaymentRpc(url)`. */
  rpc: SolanaPaymentRpc;
}

const CLUSTERS: Record<MppSolanaNetwork, string> = {
  mainnet: SOLANA_MAINNET,
  devnet: SOLANA_DEVNET,
};

export interface SolanaChargeRequest {
  /** Token base units. */
  amount: string;
  /** The SPL mint. */
  currency: string;
  /** Owner of the destination token account. */
  recipient: string;
  /** CAIP-2 cluster, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. */
  network: string;
  decimals: number;
  tokenProgram?: string;
  /** The server's fee payer when it sponsors the fee. */
  feePayerKey?: string;
  recentBlockhash?: string;
  externalId?: string;
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;

function isAddress(value: unknown): value is string {
  return typeof value === "string" && isValidAddress(value, "solana");
}

/** The request of a Solana charge, or why this client cannot pay it. */
export function readSolanaRequest(
  request: Record<string, unknown>,
  networks: readonly MppSolanaNetwork[] = ["mainnet", "devnet"],
): SolanaChargeRequest | string {
  const { amount, currency, recipient, methodDetails, externalId } = request;
  if (typeof amount !== "string" || !DECIMAL.test(amount)) {
    return "amount is not a decimal integer string";
  }
  if (BigInt(amount) === 0n || BigInt(amount) > U64_MAX) {
    return "amount is not a positive u64";
  }
  if (currency === "sol") return "native SOL is not supported";
  if (!isAddress(currency)) return "currency is not a mint address";
  if (!isAddress(recipient)) return "recipient is not a Solana address";
  if (
    externalId !== undefined &&
    (typeof externalId !== "string" ||
      externalId === "" ||
      new TextEncoder().encode(externalId).length > 566)
  ) {
    return "externalId is not a 1 to 566 byte string";
  }
  if (!isRecord(methodDetails)) return "methodDetails is missing";
  const {
    network = "mainnet",
    decimals,
    tokenProgram,
    feePayer,
    feePayerKey,
    splits,
    recentBlockhash,
  } = methodDetails;
  if (network !== "mainnet" && network !== "devnet") {
    return `network ${String(network)} is not supported`;
  }
  if (!networks.includes(network)) {
    return `network ${network} is not in the allowed list`;
  }
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 9
  ) {
    return "methodDetails.decimals is not 0 to 9";
  }
  if (
    tokenProgram !== undefined &&
    tokenProgram !== SOLANA_PROGRAMS.token &&
    tokenProgram !== SOLANA_PROGRAMS.token2022
  ) {
    return "methodDetails.tokenProgram is not a token program";
  }
  if (feePayer !== undefined && typeof feePayer !== "boolean") {
    return "methodDetails.feePayer is not a boolean";
  }
  if (feePayer === true ? !isAddress(feePayerKey) : feePayerKey !== undefined) {
    return "methodDetails.feePayerKey does not match feePayer";
  }
  if (splits !== undefined && (!Array.isArray(splits) || splits.length > 0)) {
    return "payment splits are not supported";
  }
  if (recentBlockhash !== undefined && !isAddress(recentBlockhash)) {
    return "methodDetails.recentBlockhash is not a blockhash";
  }
  return {
    amount,
    currency,
    recipient,
    network: CLUSTERS[network],
    decimals,
    ...(tokenProgram !== undefined
      ? { tokenProgram: tokenProgram as string }
      : {}),
    ...(feePayer === true ? { feePayerKey: feePayerKey as string } : {}),
    ...(recentBlockhash !== undefined
      ? { recentBlockhash: recentBlockhash as string }
      : {}),
    ...(externalId !== undefined ? { externalId } : {}),
  };
}

/**
 * Sign the charge with the wallet and build the credential. Returns the HTTP
 * field the challenge selected and its value.
 */
export async function createSolanaChargeCredential(
  challenge: MppChallenge,
  request: SolanaChargeRequest,
  solana: MppSolanaOptions,
): Promise<{ header: string; value: string }> {
  const payer = solana.signer.address;
  if (request.feePayerKey === payer) {
    throw new MppError(
      "invalid_challenge",
      "The server's fee payer is the payer itself.",
    );
  }
  await assertSolanaCluster(solana.rpc, request.network);
  const mintAccount = await solana.rpc.getAccountInfo(request.currency);
  if (!mintAccount) {
    throw new MppError("invalid_challenge", "The mint does not exist.");
  }
  const mint = readMint(mintAccount.owner, mintAccount.data);
  if (mint.decimals !== request.decimals) {
    throw new MppError(
      "invalid_challenge",
      `The mint has ${mint.decimals} decimals, not ${request.decimals}.`,
    );
  }
  if (request.tokenProgram && mint.tokenProgram !== request.tokenProgram) {
    throw new MppError(
      "invalid_challenge",
      "The mint is not owned by the challenge's token program.",
    );
  }
  const payment: SplTransferPayment = {
    feePayer: request.feePayerKey ?? payer,
    authority: payer,
    mint: request.currency,
    tokenProgram: mint.tokenProgram,
    decimals: mint.decimals,
    recipient: request.recipient,
    amount: BigInt(request.amount),
    memo: request.externalId ?? null,
    // Never the server's recentBlockhash (the spec makes it advisory): the
    // cluster check covers this RPC, and a blockhash from another cluster
    // would make the wallet sign a transfer valid there.
    recentBlockhash: await solana.rpc.getLatestBlockhash(),
  };
  const signed = await solana.signer.signTransaction(
    buildSplTransferTransaction(payment),
  );
  // MPP servers accept only transfer, ATA, memo and compute-budget
  // instructions: a wallet-added Lighthouse assertion would be rejected
  // after the server already holds the signed transaction.
  const transaction = verifySignedSplTransfer(signed, payment, {
    allowLighthouse: false,
  });
  return encodeCredential({
    challenge: challenge.params,
    payload: { type: "transaction", transaction },
    source: `did:pkh:${request.network}:${payer}`,
  });
}
