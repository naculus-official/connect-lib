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
  exactKeys,
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
  /** Duplicate-settlement cache; defaults to one in-memory store per process. */
  store?: X402SettlementStore;
  /** Unix seconds; defaults to the system clock. */
  now?: () => number;
  /** Micro-lamports per compute unit; defaults to the spec's 5 lamports. */
  maxComputeUnitPrice?: bigint;
}

/** A payment that passed `verifyPayment`, ready for `settlePayment`. */
export interface X402VerifiedPayment {
  readonly ok: true;
  /** The offered requirement the payment matched. */
  readonly requirement: X402PaymentRequirements;
  /** The paying address: EIP-3009 `from`, or the SPL transfer authority. */
  readonly payer: string;
  readonly payload: X402PaymentPayload;
}

export type X402VerifyResult = X402VerifiedPayment | Failure;

/** What `settlePayment` needs, kept out of reach of callers. */
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
  const requirement = offered.find((r) => jsonEqual(r, decoded.accepted));
  if (!requirement) {
    return failure(
      "invalid_payment_requirements",
      "accepted is not one of the offered requirements.",
    );
  }
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
 * while the first is in flight (`scheme_exact_svm.md`, "Duplicate Settlement
 * Mitigation"). `claim` must be atomic: true the first time a key is seen
 * within `ttlSeconds`, false after.
 */
export interface X402SettlementStore {
  claim(key: string, ttlSeconds: number): boolean | Promise<boolean>;
}

/** The spec's recommendation: 120 s, about twice a blockhash's lifetime. */
export const X402_SETTLEMENT_TTL_SECONDS = 120;

/** An in-process `X402SettlementStore`. Use a shared one across instances. */
export function memorySettlementStore(
  options: { now?: () => number } = {},
): X402SettlementStore {
  const expiries = new Map<string, number>();
  return {
    claim(key, ttlSeconds) {
      const now = options.now ? options.now() * 1000 : Date.now();
      for (const [k, expiry] of expiries) {
        if (expiry <= now) expiries.delete(k);
      }
      if (expiries.has(key)) return false;
      expiries.set(key, now + ttlSeconds * 1000);
      return true;
    },
  };
}

export const defaultSettlementStore: X402SettlementStore =
  memorySettlementStore();
