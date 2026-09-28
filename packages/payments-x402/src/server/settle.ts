import {
  assertSolanaCluster,
  parseSolanaTransaction,
  type SolanaPaymentRpc,
  verifySolanaSignature,
} from "@naculus/connect-core";
import { encodeHeader, type X402SettlementResponse } from "../wire";
import { bytesEqual, encodeBase58, encodeBase64, unixNow } from "./common";
import { transferWithAuthorizationData, type VerifiedEvm } from "./evm";
import type { VerifiedSvm } from "./svm";
import {
  defaultSettlementStore,
  verifiedDetails,
  X402_SETTLEMENT_TTL_SECONDS,
  type X402ServerDeps,
  type X402SettlementStore,
  type X402VerifiedPayment,
} from "./verify";

export interface X402Settlement {
  settlement: X402SettlementResponse;
  /** The `PAYMENT-RESPONSE` header value for `settlement`. */
  header: string;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

class SettleFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function refuse(reason: string): never {
  throw new SettleFailure(reason);
}

/** A key this attempt reserved in the duplicate-settlement store. */
interface Claim {
  store: X402SettlementStore;
  key: string;
  reservation: string;
  ttl: number;
  /**
   * Set just before the call that may broadcast. From then on the outcome
   * can be unknown, so a failure keeps the claim instead of releasing it.
   */
  broadcast: boolean;
}

/** Where a settlement attempt records its claim, even when it throws. */
interface Attempt {
  claim?: Claim;
}

async function claim(
  attempt: Attempt,
  deps: X402ServerDeps,
  key: string,
  ttl: number,
): Promise<Claim> {
  const store = deps.store ?? defaultSettlementStore;
  const reservation = crypto.randomUUID();
  if (!(await store.claim(key, ttl, reservation))) {
    refuse("duplicate_settlement");
  }
  attempt.claim = { store, key, reservation, ttl, broadcast: false };
  return attempt.claim;
}

async function settleEvm(
  details: VerifiedEvm,
  deps: X402ServerDeps,
  attempt: Attempt,
): Promise<string> {
  const { authorization } = details;
  const now = unixNow(deps.now);
  if (BigInt(authorization.validBefore) <= BigInt(now)) {
    refuse("invalid_exact_evm_payload_authorization_valid_before");
  }
  const submit = deps.submit;
  if (!submit) refuse("unexpected_settle_error");
  const ttl = Math.max(
    X402_SETTLEMENT_TTL_SECONDS,
    Number(BigInt(authorization.validBefore) - BigInt(now)),
  );
  const claimed = await claim(
    attempt,
    deps,
    `evm:${details.chainId}:${details.asset}:${authorization.from}:${authorization.nonce}`.toLowerCase(),
    ttl,
  );
  const transaction = {
    chainId: details.chainId,
    to: details.asset,
    data: transferWithAuthorizationData(authorization, details.signature),
  };
  claimed.broadcast = true;
  const hash = await submit(transaction);
  if (typeof hash !== "string" || !TX_HASH.test(hash)) {
    refuse("unexpected_settle_error");
  }
  return hash;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.slice()),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Refuse unless `rpc` still serves the verified cluster. */
async function onCluster(
  rpc: SolanaPaymentRpc,
  network: string,
): Promise<void> {
  let served = false;
  try {
    await assertSolanaCluster(rpc, network);
    served = true;
  } catch {
    // Refused below.
  }
  if (!served) refuse("invalid_network");
}

async function settleSvm(
  details: VerifiedSvm,
  deps: X402ServerDeps,
  attempt: Attempt,
): Promise<string> {
  const rpc = deps.rpc.solana;
  const signAsFeePayer = deps.signAsFeePayer;
  if (!signAsFeePayer || !rpc?.simulateTransaction || !rpc.sendTransaction) {
    refuse("unexpected_settle_error");
  }
  const { network } = details;
  // Keyed on the signed message alone, never on signatures or the wire that
  // carries them: the payer can sign one message again with another valid
  // signature, and that must still be the same payment.
  const claimed = await claim(
    attempt,
    deps,
    `svm:${await sha256Hex(details.message)}`,
    X402_SETTLEMENT_TTL_SECONDS,
  );
  // The RPC may have been swapped since verification: re-check the cluster
  // before each step that acts on it.
  await onCluster(rpc, network);
  const signed = await signAsFeePayer(details.wire.slice(), network);
  const tx = parseSolanaTransaction(signed);
  if (
    !bytesEqual(tx.message, details.message) ||
    !verifySolanaSignature(tx, details.feePayer) ||
    !verifySolanaSignature(tx, details.authority)
  ) {
    refuse("invalid_exact_svm_payload_transaction");
  }
  // The fee payer signs first, so its signature names the transaction.
  const expected = encodeBase58(tx.signatures[0] as Uint8Array);
  const wire = encodeBase64(signed);
  await onCluster(rpc, network);
  const simulation = await rpc.simulateTransaction(wire);
  if (simulation.err !== null) refuse("invalid_transaction_state");
  await onCluster(rpc, network);
  claimed.broadcast = true;
  const signature = await rpc.sendTransaction(wire);
  if (signature !== expected) refuse("unexpected_settle_error");
  return signature;
}

/** Store errors never change a settlement's outcome; the claim's TTL rules. */
async function quietly(action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // The claim stays until its TTL, which is the safe side.
  }
}

/**
 * Settle a payment `verifyPayment` accepted, and build the `PAYMENT-RESPONSE`
 * header. Never throws: any failure is a `success: false` settlement with an
 * `errorReason`, and the resource must not be served. Only `success: true`
 * means the payment was made.
 *
 * EVM: the `transferWithAuthorization` call goes to `deps.submit`, which
 * signs and sends it with the facilitator's key. Solana: `deps.signAsFeePayer`
 * adds the fee payer's signature, then the transaction is simulated and sent
 * through `deps.rpc.solana`, which must still serve the verified cluster and
 * must answer with the transaction's own signature.
 *
 * Either way the payload is first claimed in the duplicate-settlement store,
 * and a second claim is refused. A failure before anything could be
 * broadcast releases the claim; a success commits it; a broadcast with an
 * unknown outcome keeps it until its TTL.
 */
export async function settlePayment(
  payment: X402VerifiedPayment,
  deps: X402ServerDeps,
): Promise<X402Settlement> {
  // Only results verifyPayment produced carry details, and everything
  // echoed or acted on comes from them, never from the public object.
  const details = verifiedDetails(payment);
  const network = details ? details.network : "";
  const payer = !details
    ? undefined
    : details.kind === "evm"
      ? details.authorization.from
      : details.authority;
  const attempt: Attempt = {};
  let settlement: X402SettlementResponse;
  try {
    if (!details) refuse("invalid_payload");
    const transaction =
      details.kind === "evm"
        ? await settleEvm(details, deps, attempt)
        : await settleSvm(details, deps, attempt);
    settlement = {
      success: true,
      transaction,
      network,
      ...(payer ? { payer } : {}),
    };
    const done = attempt.claim;
    if (done) {
      await quietly(() =>
        done.store.commit(done.key, done.reservation, done.ttl),
      );
    }
  } catch (cause) {
    settlement = {
      success: false,
      errorReason:
        cause instanceof SettleFailure
          ? cause.reason
          : "unexpected_settle_error",
      transaction: "",
      network,
      ...(payer ? { payer } : {}),
    };
    const held = attempt.claim;
    if (held && !held.broadcast) {
      await quietly(() => held.store.release(held.key, held.reservation));
    }
  }
  return { settlement, header: encodeHeader(settlement) };
}
