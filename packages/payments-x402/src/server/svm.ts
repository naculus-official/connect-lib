import {
  assertSolanaCluster,
  associatedTokenAddress,
  type ParsedSolanaTransaction,
  parseSolanaTransaction,
  readMint,
  readTokenAccount,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
  type SplTokenAccount,
  verifySolanaSignature,
} from "@naculus/connect-core";
import type { X402PaymentRequirements } from "../wire";
import {
  decodeBase64,
  exactKeys,
  type Failure,
  failure,
  isRecord,
} from "./common";

/**
 * Facilitator side of x402 `exact` on Solana
 * (`specs/schemes/exact/scheme_exact_svm.md`, coinbase/x402 at
 * dd927a26cfefc98c24b3ec38b3a8f204dad0c60d). Every "Facilitator
 * Verification Rules (MUST)" item is checked before the facilitator signs
 * anything as fee payer; the stricter choices are marked "stricter".
 */

/**
 * The spec's cap: 5 lamports per compute unit, in the micro-lamports
 * SetComputeUnitPrice takes.
 */
export const X402_MAX_COMPUTE_UNIT_PRICE = 5_000_000n;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

export interface VerifiedSvm {
  kind: "svm";
  wire: Uint8Array;
  message: Uint8Array;
  feePayer: string;
  /** Signs the transfer; the payer. */
  authority: string;
}

function u32(data: Uint8Array, at: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
    at,
    true,
  );
}

function u64(data: Uint8Array, at: number): bigint {
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getBigUint64(at, true);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function isUtf8(data: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** The static rules: layout, compute budget, fee payer, transfer, memo, signature. */
function checkTransaction(
  tx: ParsedSolanaTransaction,
  requirement: X402PaymentRequirements,
  feePayer: string,
  maxComputeUnitPrice: bigint,
):
  | {
      tokenProgram: string;
      source: string;
      authority: string;
      decimals: number;
    }
  | Failure {
  const bad = (detail: string) =>
    failure("invalid_exact_svm_payload_transaction", detail);
  if (tx.accountKeys[0] !== feePayer) {
    return bad("The transaction's fee payer is not extra.feePayer.");
  }
  // Stricter: the fee payer and the transfer authority sign, nobody else.
  if (tx.numRequiredSignatures !== 2) {
    return bad("The transaction must have exactly two signers.");
  }
  const ixs = tx.instructions;
  if (ixs.length < 3 || ixs.length > 6) {
    return bad("The transaction must hold 3 to 6 instructions.");
  }
  for (const ix of ixs) {
    if (ix.program === feePayer || ix.accounts.includes(feePayer)) {
      return bad("The fee payer appears in an instruction's accounts.");
    }
  }

  const [limit, price, transfer] = ixs as [
    (typeof ixs)[0],
    (typeof ixs)[0],
    (typeof ixs)[0],
  ];
  if (
    limit.program !== SOLANA_PROGRAMS.computeBudget ||
    limit.accounts.length !== 0 ||
    limit.data.length !== 5 ||
    limit.data[0] !== 2
  ) {
    return bad("Instruction 1 is not SetComputeUnitLimit.");
  }
  const units = u32(limit.data, 1);
  if (units === 0 || units > MAX_COMPUTE_UNIT_LIMIT) {
    return bad("The compute unit limit is out of range.");
  }
  if (
    price.program !== SOLANA_PROGRAMS.computeBudget ||
    price.accounts.length !== 0 ||
    price.data.length !== 9 ||
    price.data[0] !== 3
  ) {
    return bad("Instruction 2 is not SetComputeUnitPrice.");
  }
  if (u64(price.data, 1) > maxComputeUnitPrice) {
    return bad("The compute unit price is above the cap.");
  }

  const tokenProgram = transfer.program;
  if (
    tokenProgram !== SOLANA_PROGRAMS.token &&
    tokenProgram !== SOLANA_PROGRAMS.token2022
  ) {
    return bad("Instruction 3 is not for SPL Token or Token-2022.");
  }
  // Stricter: a single-signer TransferChecked, no multisig signer accounts.
  if (
    transfer.accounts.length !== 4 ||
    transfer.data.length !== 10 ||
    transfer.data[0] !== 12
  ) {
    return bad("Instruction 3 is not a single-signer TransferChecked.");
  }
  const [source, mint, destination, authority] = transfer.accounts as [
    string,
    string,
    string,
    string,
  ];
  if (mint !== requirement.asset) {
    return bad("The transfer's mint is not the requirement's asset.");
  }
  if (
    destination !==
    associatedTokenAddress(requirement.payTo, requirement.asset, tokenProgram)
  ) {
    return failure(
      "invalid_exact_svm_payload_recipient_mismatch",
      "The destination is not payTo's associated token account.",
    );
  }
  if (u64(transfer.data, 1) !== BigInt(requirement.amount)) {
    return failure(
      "invalid_exact_svm_payload_amount_mismatch",
      "The transfer amount is not the requirement's amount.",
    );
  }
  if (authority === feePayer || source === feePayer) {
    return bad("The fee payer is the transfer's authority or source.");
  }
  if (
    source === associatedTokenAddress(feePayer, requirement.asset, tokenProgram)
  ) {
    return bad("The transfer spends the fee payer's token account.");
  }
  if (tx.accountKeys[1] !== authority) {
    return bad("The second signer is not the transfer's authority.");
  }

  // Optional instructions: Lighthouse or Memo at 4 and 5, Memo at 6.
  const memoRule = requirement.extra?.memo;
  let memos = 0;
  for (const [i, ix] of ixs.slice(3).entries()) {
    if (ix.program === SOLANA_PROGRAMS.memo) {
      memos++;
      // Stricter: no signer accounts on the memo, and valid UTF-8 data.
      if (
        ix.accounts.length !== 0 ||
        ix.data.length === 0 ||
        !isUtf8(ix.data)
      ) {
        return bad("The memo instruction is malformed.");
      }
      if (typeof memoRule === "string") {
        const want = bytesOf(memoRule);
        if (
          want.length !== ix.data.length ||
          want.some((b, j) => b !== ix.data[j])
        ) {
          return bad("The memo is not extra.memo.");
        }
      }
    } else if (ix.program !== SOLANA_PROGRAMS.lighthouse || i === 2) {
      return bad(`Instruction ${i + 4} is not allowed there.`);
    }
  }
  // Exactly one memo when the seller set one (spec); stricter: always
  // exactly one, since clients MUST send one for uniqueness.
  if (memos !== 1) {
    return bad("The transaction must hold exactly one memo instruction.");
  }

  if (!verifySolanaSignature(tx, authority)) {
    return failure(
      "invalid_exact_svm_payload_signature",
      "The transfer authority's signature is missing or invalid.",
    );
  }
  return {
    tokenProgram,
    source,
    authority,
    decimals: transfer.data[9] as number,
  };
}

async function tokenAccount(
  rpc: SolanaPaymentRpc,
  address: string,
): Promise<SplTokenAccount | null> {
  const info = await rpc.getAccountInfo(address);
  return info ? readTokenAccount(info.owner, info.data) : null;
}

/**
 * Verify a Solana `exact` payload against the requirement it names (already
 * matched against what the server offered).
 */
export async function verifySvmPayload(
  payload: unknown,
  requirement: X402PaymentRequirements,
  rpc: SolanaPaymentRpc | undefined,
  maxComputeUnitPrice: bigint = X402_MAX_COMPUTE_UNIT_PRICE,
): Promise<VerifiedSvm | Failure> {
  if (
    !isRecord(payload) ||
    !exactKeys(payload, ["transaction"]) ||
    typeof payload.transaction !== "string"
  ) {
    return failure("invalid_payload", "payload is not {transaction}.");
  }
  const wire = decodeBase64(payload.transaction);
  if (!wire) return failure("invalid_payload", "transaction is not base64.");
  let tx: ParsedSolanaTransaction;
  try {
    tx = parseSolanaTransaction(wire);
  } catch (cause) {
    return failure(
      "invalid_exact_svm_payload_transaction",
      cause instanceof Error ? cause.message : "Unreadable transaction.",
    );
  }
  const feePayer = requirement.extra?.feePayer;
  if (typeof feePayer !== "string") {
    return failure(
      "invalid_payment_requirements",
      "extra.feePayer is missing.",
    );
  }
  let checked: ReturnType<typeof checkTransaction>;
  try {
    checked = checkTransaction(tx, requirement, feePayer, maxComputeUnitPrice);
  } catch (cause) {
    // associatedTokenAddress refuses addresses that are not 32-byte keys.
    return failure(
      "invalid_exact_svm_payload_transaction",
      cause instanceof Error ? cause.message : "Unreadable transaction.",
    );
  }
  if ("ok" in checked) return checked;

  if (!rpc) return failure("invalid_network", "No Solana RPC is configured.");
  try {
    await assertSolanaCluster(rpc, requirement.network);
  } catch {
    return failure(
      "invalid_network",
      `The Solana RPC does not serve ${requirement.network}.`,
    );
  }
  let mint: { tokenProgram: string; decimals: number };
  let source: SplTokenAccount | null;
  let destination: SplTokenAccount | null;
  try {
    const mintInfo = await rpc.getAccountInfo(requirement.asset);
    if (!mintInfo) {
      return failure(
        "invalid_payment_requirements",
        "The asset mint does not exist.",
      );
    }
    // Refuses Token-2022 mints with a transfer fee, hook or pause.
    mint = readMint(mintInfo.owner, mintInfo.data);
    [source, destination] = await Promise.all([
      tokenAccount(rpc, checked.source),
      tokenAccount(
        rpc,
        associatedTokenAddress(
          requirement.payTo,
          requirement.asset,
          checked.tokenProgram,
        ),
      ),
    ]);
  } catch (cause) {
    return failure(
      "invalid_exact_svm_payload_transaction",
      cause instanceof Error
        ? cause.message
        : "The accounts could not be read.",
    );
  }
  if (
    mint.tokenProgram !== checked.tokenProgram ||
    mint.decimals !== checked.decimals
  ) {
    return failure(
      "invalid_exact_svm_payload_transaction",
      "The transfer's token program or decimals do not match the mint.",
    );
  }
  if (!source || source.mint !== requirement.asset || source.state !== 1) {
    return failure(
      "invalid_exact_svm_payload_transaction",
      "The source token account does not exist, is for another mint, or is frozen.",
    );
  }
  if (source.owner === feePayer) {
    return failure(
      "invalid_exact_svm_payload_transaction",
      "The transfer spends the fee payer's tokens.",
    );
  }
  if (source.amount < BigInt(requirement.amount)) {
    return failure("insufficient_funds", "The source balance is too low.");
  }
  // The layout has no Create ATA instruction, so the destination must exist.
  if (
    !destination ||
    destination.mint !== requirement.asset ||
    destination.owner !== requirement.payTo ||
    destination.state !== 1
  ) {
    return failure(
      "invalid_exact_svm_payload_recipient_mismatch",
      "payTo's associated token account does not exist or is frozen.",
    );
  }
  return {
    kind: "svm",
    wire,
    message: tx.message,
    feePayer,
    authority: checked.authority,
  };
}
