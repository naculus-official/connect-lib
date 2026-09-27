import {
  parseSolanaTransaction,
  verifySolanaSignature,
} from "@naculus/connect-core";
import { encodeHeader, type X402SettlementResponse } from "../wire";
import { bytesEqual, encodeBase64, unixNow } from "./common";
import { transferWithAuthorizationData, type VerifiedEvm } from "./evm";
import type { VerifiedSvm } from "./svm";
import {
  defaultSettlementStore,
  verifiedDetails,
  X402_SETTLEMENT_TTL_SECONDS,
  type X402ServerDeps,
  type X402VerifiedPayment,
} from "./verify";

export interface X402Settlement {
  settlement: X402SettlementResponse;
  /** The `PAYMENT-RESPONSE` header value for `settlement`. */
  header: string;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

class SettleFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function refuse(reason: string): never {
  throw new SettleFailure(reason);
}

async function settleEvm(
  details: VerifiedEvm,
  deps: X402ServerDeps,
): Promise<string> {
  const { authorization } = details;
  const now = unixNow(deps.now);
  if (BigInt(authorization.validBefore) <= BigInt(now)) {
    refuse("invalid_exact_evm_payload_authorization_valid_before");
  }
  if (!deps.submit) refuse("unexpected_settle_error");
  const ttl = Math.max(
    X402_SETTLEMENT_TTL_SECONDS,
    Number(BigInt(authorization.validBefore) - BigInt(now)),
  );
  const key = `evm:${details.chainId}:${details.asset}:${authorization.from}:${authorization.nonce}`;
  if (
    !(await (deps.store ?? defaultSettlementStore).claim(
      key.toLowerCase(),
      ttl,
    ))
  ) {
    refuse("duplicate_settlement");
  }
  const hash = await deps.submit({
    chainId: details.chainId,
    to: details.asset,
    data: transferWithAuthorizationData(authorization, details.signature),
  });
  if (typeof hash !== "string" || !TX_HASH.test(hash)) {
    refuse("unexpected_settle_error");
  }
  return hash;
}

async function settleSvm(
  details: VerifiedSvm,
  network: string,
  deps: X402ServerDeps,
): Promise<string> {
  const rpc = deps.rpc.solana;
  if (
    !deps.signAsFeePayer ||
    !rpc?.simulateTransaction ||
    !rpc.sendTransaction
  ) {
    refuse("unexpected_settle_error");
  }
  // Keyed on the decoded bytes, so two encodings of one transaction collide.
  if (
    !(await (deps.store ?? defaultSettlementStore).claim(
      `svm:${encodeBase64(details.wire)}`,
      X402_SETTLEMENT_TTL_SECONDS,
    ))
  ) {
    refuse("duplicate_settlement");
  }
  const signed = await deps.signAsFeePayer(details.wire.slice(), network);
  const tx = parseSolanaTransaction(signed);
  if (
    !bytesEqual(tx.message, details.message) ||
    !verifySolanaSignature(tx, details.feePayer) ||
    !verifySolanaSignature(tx, details.authority)
  ) {
    refuse("invalid_exact_svm_payload_transaction");
  }
  const wire = encodeBase64(signed);
  const simulation = await rpc.simulateTransaction(wire);
  if (simulation.err !== null) refuse("invalid_transaction_state");
  const signature = await rpc.sendTransaction(wire);
  if (typeof signature !== "string" || !SOLANA_SIGNATURE.test(signature)) {
    refuse("unexpected_settle_error");
  }
  return signature;
}

/**
 * Settle a payment `verifyPayment` accepted, and build the `PAYMENT-RESPONSE`
 * header. Never throws: any failure is a `success: false` settlement with an
 * `errorReason`, and the resource must not be served.
 *
 * EVM: the `transferWithAuthorization` call goes to `deps.submit`, which
 * signs and sends it with the facilitator's key. Solana: `deps.signAsFeePayer`
 * adds the fee payer's signature, then the transaction is simulated and sent
 * through `deps.rpc.solana`. Either way the payload is first claimed in the
 * duplicate-settlement store, and a second claim is refused.
 */
export async function settlePayment(
  payment: X402VerifiedPayment,
  deps: X402ServerDeps,
): Promise<X402Settlement> {
  const details = verifiedDetails(payment);
  // Echo nothing from an object verifyPayment did not produce.
  const network = details ? payment.requirement.network : "";
  const payer = details ? payment.payer : undefined;
  let settlement: X402SettlementResponse;
  try {
    // Only results verifyPayment produced carry details.
    if (!details) refuse("invalid_payload");
    const transaction =
      details.kind === "evm"
        ? await settleEvm(details, deps)
        : await settleSvm(details, network, deps);
    settlement = {
      success: true,
      transaction,
      network,
      ...(payer ? { payer } : {}),
    };
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
  }
  return { settlement, header: encodeHeader(settlement) };
}
