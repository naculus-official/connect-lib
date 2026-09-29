import type { SolanaPaymentRpc } from "@naculus/connect-core";
import { unsupportedReason } from "../evm-exact";
import { svmUnsupportedReason } from "../svm-exact";
import {
  decodeHeader,
  encodeHeader,
  X402_VERSION,
  X402Error,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402PaymentRequirements,
  type X402ResourceInfo,
} from "../wire";
import {
  deepFreeze,
  type Failure,
  failure,
  isFailure,
  isRecord,
  jsonEqual,
  unixNow,
} from "./common";
import { type VerifiedEvm, verifyEvmPayload, type X402EvmRpc } from "./evm";
import { type VerifiedSvm, verifySvmPayload } from "./svm";

export type { Failure as X402VerifyFailure } from "./common";

/**
 * What the server side needs from outside. Nothing here holds a private key:
 * the facilitator's key stays with the caller behind `submit` and
 * `signAsFeePayer`.
 */
export interface X402ServerDeps {
  rpc: {
    /** Token reads and simulation on EIP-155 chains. */
    evm?: X402EvmRpc;
    /**
     * Account reads for verification; `simulateTransaction` and
     * `sendTransaction` for settlement. Must serve the requirement's cluster.
     */
    solana?: SolanaPaymentRpc;
  };
  /**
   * Broadcast the EVM settlement call from the facilitator's account.
   * Resolve to the transaction hash only once it has succeeded on chain;
   * reject otherwise.
   */
  submit?: (transaction: {
    chainId: number;
    to: `0x${string}`;
    data: `0x${string}`;
  }) => Promise<string>;
  /**
   * Add the facilitator's fee-payer signature to a Solana wire transaction
   * and return it; the message must come back unchanged.
   */
  signAsFeePayer?: (
    transaction: Uint8Array,
    network: string,
  ) => Promise<Uint8Array>;
  /**
   * Wait for a sent Solana settlement to reach at least `confirmed`
   * commitment on `network`. Resolve true only when it did and executed
   * without error. Required to settle on Solana: `sendTransaction` answers
   * once the node accepts the transaction, which is not payment.
   */
  confirmSolana?: (signature: string, network: string) => Promise<boolean>;
  /** Duplicate-settlement cache; defaults to one in-memory store per process. */
  store?: X402SettlementStore;
  /** Unix seconds; defaults to the system clock. */
  now?: () => number;
  /** Micro-lamports per compute unit; defaults to the spec's 5 lamports. */
  maxComputeUnitPrice?: bigint;
}

/**
 * A payment that passed `verifyPayment`, ready for `settlePayment`. Verified
 * is not paid: nothing has moved until `settlePayment` reports success.
 * Frozen, and settlement reads none of it.
 */
export interface X402VerifiedPayment {
  readonly ok: true;
  /** A frozen snapshot of the offered requirement the payment matched. */
  readonly requirement: X402PaymentRequirements;
  /** The paying address: EIP-3009 `from`, or the SPL transfer authority. */
  readonly payer: string;
  readonly payload: X402PaymentPayload;
}

export type X402VerifyResult = X402VerifiedPayment | Failure;

/**
 * What `settlePayment` needs, kept out of reach of callers: settlement reads
 * the network, payer and payload from here, never from the public result.
 */
export type VerifiedDetails = VerifiedEvm | VerifiedSvm;

const verified = new WeakMap<X402VerifiedPayment, VerifiedDetails>();

/** The details behind a result `verifyPayment` produced, or undefined. */
export function verifiedDetails(
  payment: X402VerifiedPayment,
): VerifiedDetails | undefined {
  return verified.get(payment);
}

const PAYLOAD_KEYS = new Set([
  "x402Version",
  "resource",
  "accepted",
  "payload",
  "extensions",
]);

function checkOffered(requirement: X402PaymentRequirements): string | null {
  if (requirement.network.startsWith("eip155:"))
    return unsupportedReason(requirement);
  if (requirement.network.startsWith("solana:"))
    return svmUnsupportedReason(requirement);
  return `network ${requirement.network} is not an EIP-155 or Solana CAIP-2 chain`;
}

/**
 * The `PAYMENT-REQUIRED` header value for `resource`. Every requirement must
 * be one this module can verify (`exact`, EIP-3009 on an EIP-155 chain or
 * SPL on a Solana cluster, CAIP-2 network ids); anything else throws rather
 * than advertise a payment the server would then refuse.
 */
export function buildPaymentRequired(
  resource: X402ResourceInfo,
  accepts: readonly X402PaymentRequirements[],
  options: { error?: string; extensions?: Record<string, unknown> } = {},
): string {
  if (
    !isRecord(resource) ||
    typeof resource.url !== "string" ||
    !resource.url
  ) {
    throw new X402Error("invalid_input", "resource.url is required.");
  }
  if (accepts.length === 0) {
    throw new X402Error("invalid_input", "accepts lists no requirement.");
  }
  for (const requirement of accepts) {
    const reason = checkOffered(requirement);
    if (reason)
      throw new X402Error("invalid_input", `Cannot offer: ${reason}.`);
  }
  const required: X402PaymentRequired = {
    x402Version: X402_VERSION,
    ...(options.error !== undefined ? { error: options.error } : {}),
    resource: {
      url: resource.url,
      ...(resource.description !== undefined
        ? { description: resource.description }
        : {}),
      ...(resource.mimeType !== undefined
        ? { mimeType: resource.mimeType }
        : {}),
    },
    accepts: [...accepts],
    ...(options.extensions !== undefined
      ? { extensions: options.extensions }
      : {}),
  };
  return encodeHeader(required);
}

/**
 * Verify a `PAYMENT-SIGNATURE` header value against what the server offered.
 *
 * `accepted` must equal one offered requirement exactly; the scheme's rules
 * then decide. Anything unparseable, unexpected or unreadable on chain is a
 * refusal, never a partial acceptance. Nothing is broadcast.
 */
export async function verifyPayment(
  headerValue: string | null | undefined,
  offered: readonly X402PaymentRequirements[],
  deps: X402ServerDeps,
): Promise<X402VerifyResult> {
  if (typeof headerValue !== "string" || headerValue === "") {
    return failure("invalid_payload", "No PAYMENT-SIGNATURE header.");
  }
  const decoded = decodeHeader(headerValue);
  if (!isRecord(decoded)) {
    return failure("invalid_payload", "PAYMENT-SIGNATURE is not base64 JSON.");
  }
  if (decoded.x402Version !== X402_VERSION) {
    return failure(
      "invalid_x402_version",
      `x402Version ${String(decoded.x402Version)} is not ${X402_VERSION}.`,
    );
  }
  if (Object.keys(decoded).some((k) => !PAYLOAD_KEYS.has(k))) {
    return failure("invalid_payload", "The payload has unexpected fields.");
  }
  if (
    !isRecord(decoded.accepted) ||
    !isRecord(decoded.payload) ||
    (decoded.resource !== undefined && !isRecord(decoded.resource)) ||
    (decoded.extensions !== undefined && !isRecord(decoded.extensions))
  ) {
    return failure("invalid_payload", "The payload is not a PaymentPayload.");
  }
  const match = offered.find((r) => jsonEqual(r, decoded.accepted));
  if (!match) {
    return failure(
      "invalid_payment_requirements",
      "accepted is not one of the offered requirements.",
    );
  }
  // Verify against a snapshot, so the caller changing an offered
  // requirement mid-verification or afterwards changes nothing here. The
  // decoded `accepted` equals `match` and is a fresh JSON value.
  deepFreeze(decoded);
  const requirement = decoded.accepted as unknown as X402PaymentRequirements;
  const reason = checkOffered(requirement);
  if (reason) return failure("invalid_payment_requirements", reason);

  let details: VerifiedDetails | Failure;
  try {
    details = requirement.network.startsWith("eip155:")
      ? await verifyEvmPayload(
          decoded.payload,
          requirement,
          deps.rpc.evm,
          unixNow(deps.now),
        )
      : await verifySvmPayload(
          decoded.payload,
          requirement,
          deps.rpc.solana,
          deps.maxComputeUnitPrice,
        );
  } catch {
    return failure(
      "unexpected_verify_error",
      "Verification failed unexpectedly.",
    );
  }
  if (isFailure(details)) return details;
  deepFreeze(details);

  const result: X402VerifiedPayment = Object.freeze({
    ok: true as const,
    requirement,
    payer:
      details.kind === "evm" ? details.authorization.from : details.authority,
    payload: decoded as unknown as X402PaymentPayload,
  });
  verified.set(result, details);
  return result;
}

// ── Duplicate settlement ─────────────────────────────────────────────

/**
 * Remembers payloads being settled so the same one cannot be settled twice
 * (`scheme_exact_svm.md`, "Duplicate Settlement Mitigation").
 *
 * The lifecycle of a key, all under the `reservation` id `settlePayment`
 * picks per attempt:
 * - `claim` reserves it: atomically true the first time the key is seen
 *   within `ttlSeconds`, false while any reservation or commit holds it.
 * - `release` drops the reservation, so the payload can be settled again.
 *   `settlePayment` calls it only when nothing can have been broadcast.
 *   It must remove the key only while `reservation` still holds it.
 * - `commit` records a settlement that succeeded on chain (`submit`
 *   resolved, or `confirmSolana` answered true): the key stays for
 *   `ttlSeconds` from now and no `release` removes it.
 *
 * When the outcome of a broadcast is unknown, `settlePayment` calls neither,
 * and the claim holds until its TTL.
 */
export interface X402SettlementStore {
  claim(
    key: string,
    ttlSeconds: number,
    reservation: string,
  ): boolean | Promise<boolean>;
  release(key: string, reservation: string): void | Promise<void>;
  commit(
    key: string,
    reservation: string,
    ttlSeconds: number,
  ): void | Promise<void>;
}

/** The spec's recommendation: 120 s, about twice a blockhash's lifetime. */
export const X402_SETTLEMENT_TTL_SECONDS = 120;

/** An in-process `X402SettlementStore`. Use a shared one across instances. */
export function memorySettlementStore(
  options: { now?: () => number } = {},
): X402SettlementStore {
  // `holder` is the reservation id, or null once committed.
  const entries = new Map<string, { expiry: number; holder: string | null }>();
  const clock = () => (options.now ? options.now() * 1000 : Date.now());
  const live = (key: string, now: number) => {
    for (const [k, entry] of entries) {
      if (entry.expiry <= now) entries.delete(k);
    }
    return entries.get(key);
  };
  return {
    claim(key, ttlSeconds, reservation) {
      const now = clock();
      if (live(key, now)) return false;
      entries.set(key, {
        expiry: now + ttlSeconds * 1000,
        holder: reservation,
      });
      return true;
    },
    release(key, reservation) {
      if (live(key, clock())?.holder === reservation) entries.delete(key);
    },
    commit(key, reservation, ttlSeconds) {
      const now = clock();
      const entry = live(key, now);
      // Another reservation took the key after ours expired: leave it held.
      if (entry && entry.holder !== reservation && entry.holder !== null) {
        return;
      }
      entries.set(key, {
        expiry: Math.max(entry?.expiry ?? 0, now + ttlSeconds * 1000),
        holder: null,
      });
    },
  };
}

export const defaultSettlementStore: X402SettlementStore =
  memorySettlementStore();
