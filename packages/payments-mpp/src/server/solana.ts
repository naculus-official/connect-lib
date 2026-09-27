import {
  associatedTokenAddress,
  hasValidSolanaSignature,
  type ParsedSolanaTransaction,
  parseSolanaTransaction,
  SOLANA_PROGRAMS,
  solanaTransactionId,
} from "@naculus/connect-core";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { SolanaChargeRequest } from "../solana-charge";
import { problem } from "./problems";

/**
 * Server side of MPP `method="solana"`, pull mode (`type="transaction"`),
 * SPL tokens (`draft-solana-charge-00` §Pull Mode Verification, §Fee
 * Sponsorship, §Transaction Payload Security).
 *
 * The transaction is checked byte by byte before anyone signs or sends it:
 * a v0 message without lookup tables; the fee payer is the server's
 * `feePayerKey` (sponsored, its signature slot empty) or the payer
 * (self-funded, fully signed); only ComputeBudget limit/price, one
 * `TransferChecked` and at most one Memo; the transfer moves exactly
 * `amount` of `currency` with `decimals` into the recipient's associated
 * token account under `tokenProgram`; the payer's signature verifies; and a
 * sponsored transaction never names the fee payer in an instruction and pays
 * a bounded priority fee.
 *
 * Refused as on the client: native SOL, splits (so no ATA creation is ever
 * allowed: the spec permits it only for split recipients), push mode
 * (`type="signature"`), confidential transfers, legacy messages.
 */

export interface MppSolanaVerifyOptions {
  /**
   * Largest priority fee a sponsored transaction may make the fee payer
   * pay, in lamports: compute unit limit × price / 10⁶. Default 10 000.
   */
  maxPriorityFeeLamports?: bigint;
}

/** What settlement needs from a Solana JSON-RPC node. */
export interface MppSolanaSettleRpc {
  /** `simulateTransaction` of a base64 wire transaction; `err` null on success. */
  simulateTransaction(transaction: string): Promise<{ err: unknown }>;
  /** `sendTransaction` of a base64 wire transaction; resolves to its signature. */
  sendTransaction(transaction: string): Promise<string>;
  /**
   * Wait for `signature` to reach at least `confirmed` commitment. Resolve
   * true only when it did and executed without error.
   */
  confirmTransaction(signature: string): Promise<boolean>;
}

export interface MppSolanaSettleDeps {
  rpc: MppSolanaSettleRpc;
  /**
   * Sign a sponsored transaction as `feePayerKey` and return the wire
   * transaction; only the fee payer's slot may change. The key stays with
   * the caller. Required for challenges with `feePayer: true`.
   */
  signAsFeePayer?(transaction: Uint8Array): Promise<Uint8Array>;
}

export const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 10_000n;
/** Units the runtime grants per non-ComputeBudget instruction by default. */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;
const MAX_UNITS = 1_400_000n;

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64.test(value)) return null;
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getBigUint64(offset, true);
}

function isWritable(tx: ParsedSolanaTransaction, index: number): boolean {
  if (index < tx.numRequiredSignatures) {
    return index < tx.numRequiredSignatures - tx.numReadonlySigned;
  }
  return index < tx.accountKeys.length - tx.numReadonlyUnsigned;
}

export interface VerifiedSolanaPayment {
  /** The wire transaction as the client signed it. */
  transaction: Uint8Array;
  payer: string;
  /** Hex of the payer's signature: the replay token known before sending. */
  payerSignature: string;
}

/** Check a pull-mode payload against its (already bound) challenge. */
export function verifySolanaTransaction(
  request: SolanaChargeRequest,
  payload: Record<string, unknown>,
  source: string | undefined,
  options: MppSolanaVerifyOptions = {},
): VerifiedSolanaPayment {
  if (payload.type !== "transaction") {
    problem(
      "invalid-payload",
      `Credential type ${String(payload.type)} is not accepted; use transaction.`,
    );
  }
  if (typeof payload.transaction !== "string") {
    problem("invalid-payload", "transaction is missing.");
  }
  const wire = decodeBase64(payload.transaction as string);
  if (!wire) problem("invalid-payload", "transaction is not base64.");
  let tx: ParsedSolanaTransaction;
  try {
    tx = parseSolanaTransaction(wire as Uint8Array);
  } catch (error) {
    problem(
      "invalid-payload",
      `transaction is not a v0 transaction without lookup tables: ${(error as Error).message}`,
    );
  }
  const keys = tx.accountKeys;
  if (new Set(keys).size !== keys.length) {
    problem("verification-failed", "The transaction lists an account twice.");
  }
  const sponsor = request.feePayerKey;
  if (tx.numRequiredSignatures !== (sponsor ? 2 : 1)) {
    problem(
      "verification-failed",
      sponsor
        ? "A sponsored payment is signed by the fee payer and the payer only."
        : "A self-funded payment is signed by the payer alone.",
    );
  }
  if (sponsor && keys[0] !== sponsor) {
    problem("verification-failed", "The fee payer is not the server's.");
  }
  const payerIndex = sponsor ? 1 : 0;
  const payer = keys[payerIndex] as string;
  const tokenProgram = request.tokenProgram as string;
  const destination = associatedTokenAddress(
    request.recipient,
    request.currency,
    tokenProgram,
  );

  let unitLimit: bigint | undefined;
  let unitPrice: bigint | undefined;
  let transfers = 0;
  let memos = 0;
  let others = 0;
  for (const ix of tx.instructions) {
    if (sponsor && ix.accounts.includes(sponsor)) {
      problem(
        "verification-failed",
        "An instruction uses the server's fee payer account.",
      );
    }
    if (ix.program === SOLANA_PROGRAMS.computeBudget) {
      const [kind] = ix.data;
      if (ix.accounts.length !== 0) {
        problem(
          "verification-failed",
          "A ComputeBudget instruction has accounts.",
        );
      }
      if (kind === 2 && ix.data.length === 5 && unitLimit === undefined) {
        unitLimit = BigInt(
          new DataView(
            ix.data.buffer,
            ix.data.byteOffset,
            ix.data.byteLength,
          ).getUint32(1, true),
        );
      } else if (
        kind === 3 &&
        ix.data.length === 9 &&
        unitPrice === undefined
      ) {
        unitPrice = readU64(ix.data, 1);
      } else {
        problem(
          "verification-failed",
          "Only one compute unit limit and one price are accepted.",
        );
      }
      continue;
    }
    others++;
    if (ix.program === SOLANA_PROGRAMS.memo) {
      memos++;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(ix.data);
      } catch {
        problem("verification-failed", "The memo is not UTF-8.");
      }
      if (memos > 1 || ix.accounts.length !== 0) {
        problem(
          "verification-failed",
          "Only one memo without signers is accepted.",
        );
      }
      if (request.externalId !== undefined && text !== request.externalId) {
        problem("verification-failed", "The memo is not the externalId.");
      }
      continue;
    }
    if (ix.program !== tokenProgram) {
      problem(
        "verification-failed",
        `The transaction calls ${ix.program}, which a charge does not need.`,
      );
    }
    transfers++;
    // TransferChecked: 12, amount u64 LE, decimals; accounts
    // [source, mint, destination, authority], no multisig signers.
    if (
      transfers > 1 ||
      ix.data.length !== 10 ||
      ix.data[0] !== 12 ||
      ix.accounts.length !== 4
    ) {
      problem(
        "verification-failed",
        "The token instruction is not one TransferChecked.",
      );
    }
    const [from, mint, to, authority] = ix.accounts as [
      string,
      string,
      string,
      string,
    ];
    if (mint !== request.currency) {
      problem("verification-failed", "The transfer is of another mint.");
    }
    if (to !== destination) {
      problem(
        "verification-failed",
        "The destination is not the recipient's associated token account.",
      );
    }
    if (readU64(ix.data, 1) !== BigInt(request.amount)) {
      problem("verification-failed", "The transfer amount does not match.");
    }
    if (ix.data[9] !== request.decimals) {
      problem("verification-failed", "The transfer decimals do not match.");
    }
    if (authority !== payer) {
      problem(
        "verification-failed",
        "The transfer authority is not the signer.",
      );
    }
    if (
      from === to ||
      !isWritable(tx, keys.indexOf(from)) ||
      !isWritable(tx, keys.indexOf(to))
    ) {
      problem(
        "verification-failed",
        "The transfer's accounts are not writable.",
      );
    }
  }
  if (transfers !== 1) {
    problem("verification-failed", "The transaction holds no TransferChecked.");
  }
  if (sponsor) {
    const limit = unitLimit ?? DEFAULT_UNITS_PER_INSTRUCTION * BigInt(others);
    const units = limit < MAX_UNITS ? limit : MAX_UNITS;
    const max =
      options.maxPriorityFeeLamports ?? DEFAULT_MAX_PRIORITY_FEE_LAMPORTS;
    // Round up: the runtime charges ceil(units × price / 10⁶).
    if ((units * (unitPrice ?? 0n) + 999_999n) / 1_000_000n > max) {
      problem(
        "verification-failed",
        "The priority fee exceeds the sponsor's limit.",
      );
    }
    if ((tx.signatures[0] as Uint8Array).some((b) => b !== 0)) {
      problem(
        "verification-failed",
        "The fee payer's signature slot is not empty.",
      );
    }
  }
  if (!hasValidSolanaSignature(tx, payer)) {
    problem("verification-failed", "The payer's signature does not verify.");
  }
  if (
    source !== undefined &&
    source !== payer &&
    source !== `did:pkh:${request.network}:${payer}`
  ) {
    problem("verification-failed", "source does not match the payer.");
  }
  return {
    transaction: wire as Uint8Array,
    payer,
    payerSignature: bytesToHex(tx.signatures[payerIndex] as Uint8Array),
  };
}

/**
 * Co-sign when sponsored, simulate, send, and wait for confirmation;
 * resolves to the transaction signature. Throws `verification-failed` when
 * the chain refuses it.
 */
export async function settleSolanaTransaction(
  request: SolanaChargeRequest,
  verified: VerifiedSolanaPayment,
  deps: MppSolanaSettleDeps | undefined,
): Promise<string> {
  if (!deps?.rpc) {
    throw new TypeError(
      "settleCredential needs solana.rpc for solana charges.",
    );
  }
  let wire = verified.transaction;
  const before = parseSolanaTransaction(wire);
  if (request.feePayerKey) {
    if (!deps.signAsFeePayer) {
      throw new TypeError(
        "settleCredential needs solana.signAsFeePayer for sponsored charges.",
      );
    }
    wire = await deps.signAsFeePayer(wire.slice());
    let after: ParsedSolanaTransaction;
    try {
      after = parseSolanaTransaction(wire);
    } catch {
      throw new TypeError("signAsFeePayer returned an unreadable transaction.");
    }
    if (
      after.message.length !== before.message.length ||
      after.message.some((b, i) => b !== before.message[i]) ||
      after.signatures.length !== 2 ||
      (after.signatures[1] as Uint8Array).some(
        (b, i) => b !== (before.signatures[1] as Uint8Array)[i],
      ) ||
      !hasValidSolanaSignature(after, request.feePayerKey)
    ) {
      throw new TypeError(
        "signAsFeePayer changed the transaction or did not sign it as the fee payer.",
      );
    }
  }
  const transaction = encodeBase64(wire);
  const expected = solanaTransactionId(parseSolanaTransaction(wire));
  const simulation = await deps.rpc.simulateTransaction(transaction);
  if (!simulation || simulation.err !== null) {
    problem("verification-failed", "The transaction fails in simulation.");
  }
  const signature = await deps.rpc.sendTransaction(transaction);
  if (signature !== expected) {
    throw new TypeError("sendTransaction reported another signature.");
  }
  if ((await deps.rpc.confirmTransaction(signature)) !== true) {
    problem("verification-failed", "The transaction did not confirm.");
  }
  return signature;
}
