import { type EvmChargeRequest, readEvmRequest } from "../evm-charge";
import type { SolanaChargeRequest } from "../solana-charge";
import {
  decodeBase64UrlJson,
  isRecord,
  type MppChallengeParams,
  type MppReceipt,
  type PAYMENT_AUTHORIZATION_HEADER,
} from "../wire";
import {
  type ChallengeSecret,
  challengeId,
  encodeCanonical,
  parseRfc3339,
  readServerSolanaRequest,
  timingSafeEqual,
} from "./challenge";
import {
  type MppEvmSettleDeps,
  type MppEvmVerifyOptions,
  settleEvmAuthorization,
  type VerifiedEvmPayment,
  verifyEvmAuthorization,
} from "./evm";
import { problem, toPaymentProblem } from "./problems";
import type { MppReplayStore } from "./replay";
import {
  type MppSolanaSettleDeps,
  type MppSolanaVerifyOptions,
  settleSolanaTransaction,
  type VerifiedSolanaPayment,
  verifySolanaTransaction,
} from "./solana";

/** A charge this resource sells: the method and the request it is priced at. */
export interface MppOffer {
  method: string;
  request: Record<string, unknown>;
}

export interface VerifyCredentialOptions {
  /** The binding secret challenges are issued with. */
  secret: ChallengeSecret;
  /** Secrets rotated out but still honoured until their challenges expire. */
  previousSecrets?: readonly ChallengeSecret[];
  /** This server's realm; a challenge of another realm is refused. */
  realm: string;
  /**
   * What this resource charges. The echoed challenge's method and request
   * must equal one of these, so a credential for a cheaper challenge of the
   * same server cannot pay for this resource.
   */
  accept: readonly MppOffer[];
  /**
   * The field the credential was read from. Default `Authorization`; it must
   * be the one the challenge selected.
   */
  field?: "Authorization" | typeof PAYMENT_AUTHORIZATION_HEADER;
  /**
   * RFC 9530 digest of this request's body, computed by the server. Required
   * when the challenge binds a `digest`.
   */
  digest?: string;
  /** Epoch milliseconds; default now. */
  now?: number;
  /** Refuse an already-used challenge early (settlement consumes it). */
  replay?: MppReplayStore;
  /** Required to accept `evm` charges. */
  evm?: MppEvmVerifyOptions;
  /** Limits for `solana` charges. */
  solana?: MppSolanaVerifyOptions;
}

interface VerifiedBase {
  /** The challenge as echoed, bound and checked. */
  challenge: MppChallengeParams;
  /** The challenge's `expires`, epoch ms. */
  expiresAt: number;
  /** CAIP-2 network of the payment. */
  network: string;
  /** The paying address. */
  payer: string;
  source?: string;
}

export interface VerifiedEvmCredential extends VerifiedBase {
  method: "evm";
  request: EvmChargeRequest;
  evm: VerifiedEvmPayment;
}

export interface VerifiedSolanaCredential extends VerifiedBase {
  method: "solana";
  request: SolanaChargeRequest;
  solana: VerifiedSolanaPayment;
}

export type VerifiedCredential =
  | VerifiedEvmCredential
  | VerifiedSolanaCredential;

/** Only what verifyCredential returned may be settled. */
const verifiedResults = new WeakSet<object>();

/** Credentials above this size are refused unread (the spec asks for 4 KiB). */
export const MAX_CREDENTIAL_LENGTH = 16_384;

const CREDENTIAL = /^[ \t]*Payment +([A-Za-z0-9_-]+)[ \t]*$/i;
const REQUIRED = ["id", "realm", "method", "intent", "request"] as const;
const OPTIONAL = [
  "expires",
  "digest",
  "description",
  "header",
  "opaque",
] as const;

function readCredential(value: string | null | undefined): {
  challenge: MppChallengeParams;
  payload: Record<string, unknown>;
  source?: string;
} {
  if (typeof value !== "string" || value.length === 0) {
    problem("payment-required", "No Payment credential was sent.");
  }
  if (value.length > MAX_CREDENTIAL_LENGTH) {
    problem("malformed-credential", "The credential is too large.");
  }
  const match = CREDENTIAL.exec(value);
  if (!match) {
    problem(
      "malformed-credential",
      "The credential is not Payment <base64url>.",
    );
  }
  const decoded = decodeBase64UrlJson(match[1] as string);
  if (
    !isRecord(decoded) ||
    !isRecord(decoded.challenge) ||
    !isRecord(decoded.payload) ||
    (decoded.source !== undefined && typeof decoded.source !== "string")
  ) {
    problem(
      "malformed-credential",
      "The credential is not a JSON object with challenge and payload.",
    );
  }
  const echoed = decoded.challenge as Record<string, unknown>;
  const challenge = {} as MppChallengeParams;
  for (const name of REQUIRED) {
    if (typeof echoed[name] !== "string") {
      problem("malformed-credential", `challenge.${name} is missing.`);
    }
    challenge[name] = echoed[name] as string;
  }
  for (const name of OPTIONAL) {
    if (echoed[name] === undefined) continue;
    if (typeof echoed[name] !== "string") {
      problem("malformed-credential", `challenge.${name} is not a string.`);
    }
    challenge[name] = echoed[name] as string;
  }
  return {
    challenge,
    payload: decoded.payload as Record<string, unknown>,
    ...(decoded.source !== undefined
      ? { source: decoded.source as string }
      : {}),
  };
}

/**
 * Verify a Payment credential (the `Authorization` or
 * `Payment-Authorization` field value) without settling it.
 *
 * In order: the credential's shape; the challenge id re-derived from the
 * echoed parameters (any edited parameter fails here); realm, field,
 * method and intent; expiry; the body digest; that the challenge is one this
 * resource sells; then the method's proof. Throws a `PaymentProblem` for
 * every refusal (`problemResponse` turns it into the response); anything
 * unexpected becomes `internal-payment-error`.
 */
export async function verifyCredential(
  authorization: string | null | undefined,
  options: VerifyCredentialOptions,
): Promise<VerifiedCredential> {
  try {
    const result = await verify(authorization, options);
    verifiedResults.add(result);
    return result;
  } catch (error) {
    throw toPaymentProblem(error);
  }
}

async function verify(
  authorization: string | null | undefined,
  options: VerifyCredentialOptions,
): Promise<VerifiedCredential> {
  const { challenge, payload, source } = readCredential(authorization);
  const secrets = [options.secret, ...(options.previousSecrets ?? [])];
  if (
    !secrets.some((s) =>
      timingSafeEqual(challenge.id, challengeId(challenge, s)),
    )
  ) {
    problem(
      "invalid-challenge",
      "The challenge was not issued by this server or was altered.",
    );
  }
  if (challenge.realm !== options.realm) {
    problem("invalid-challenge", "The challenge is for another realm.");
  }
  const field = options.field ?? "Authorization";
  if ((challenge.header ?? "Authorization") !== field) {
    problem(
      "invalid-challenge",
      `The credential must be sent in ${challenge.header ?? "Authorization"}.`,
    );
  }
  if (challenge.intent !== "charge") {
    problem(
      "method-unsupported",
      `Intent ${challenge.intent} is not supported.`,
    );
  }
  const method = challenge.method;
  if (method !== "evm" && method !== "solana") {
    problem("method-unsupported", `Method ${method} is not supported.`);
  }
  if (challenge.expires === undefined) {
    problem("invalid-challenge", "The challenge has no expiry.");
  }
  const expiresAt = parseRfc3339(challenge.expires as string);
  if (!Number.isFinite(expiresAt)) {
    problem("invalid-challenge", "The challenge expiry is unreadable.");
  }
  const now = options.now ?? Date.now();
  if (now >= expiresAt)
    problem("payment-expired", "The challenge has expired.");
  if (challenge.digest !== undefined && challenge.digest !== options.digest) {
    problem(
      "verification-failed",
      "The request body does not match the challenge digest.",
    );
  }
  if (
    !options.accept.some(
      (offer) =>
        offer.method === method &&
        encodeCanonical(offer.request) === challenge.request,
    )
  ) {
    problem("invalid-challenge", "The challenge is not for this resource.");
  }
  if (
    options.replay?.has &&
    (await options.replay.has(challengeKey(challenge)))
  ) {
    problem("invalid-challenge", "The challenge was already used.");
  }
  const decoded = decodeBase64UrlJson(challenge.request);
  if (!isRecord(decoded)) {
    problem("invalid-challenge", "The challenge request is unreadable.");
  }
  const base = {
    challenge,
    expiresAt,
    ...(source !== undefined ? { source } : {}),
  };

  if (method === "evm") {
    const request = readEvmRequest(decoded as Record<string, unknown>);
    if (typeof request === "string") {
      problem(
        "invalid-challenge",
        `The challenge request is refused: ${request}.`,
      );
    }
    const evm = await verifyEvmAuthorization(
      challenge,
      request as EvmChargeRequest,
      payload,
      source,
      options.evm,
      now,
      expiresAt,
    );
    return Object.freeze({
      ...base,
      method: "evm",
      request: request as EvmChargeRequest,
      network: `eip155:${(request as EvmChargeRequest).chainId}`,
      payer: evm.payer,
      evm,
    });
  }
  const request = readServerSolanaRequest(decoded as Record<string, unknown>);
  if (typeof request === "string") {
    problem(
      "invalid-challenge",
      `The challenge request is refused: ${request}.`,
    );
  }
  const solana = verifySolanaTransaction(
    request as SolanaChargeRequest,
    payload,
    source,
    options.solana,
  );
  return Object.freeze({
    ...base,
    method: "solana",
    request: request as SolanaChargeRequest,
    network: (request as SolanaChargeRequest).network,
    payer: solana.payer,
    solana,
  });
}

function challengeKey(challenge: MppChallengeParams): string {
  return `mpp:challenge:${challenge.id}`;
}

/** How long a Solana payer signature stays recorded past the challenge. */
const SIGNATURE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface SettleDeps {
  /** Records used challenges and proofs; `consume` must be atomic. */
  replay: MppReplayStore;
  /** Epoch milliseconds; default now. */
  now?: number;
  /** Required to settle `evm` charges. */
  evm?: MppEvmSettleDeps;
  /** Required to settle `solana` charges. */
  solana?: MppSolanaSettleDeps;
}

export interface SettledCredential {
  receipt: MppReceipt;
  /** The `Payment-Receipt` field value (base64url JCS JSON). */
  header: string;
}

/**
 * Settle a verified credential: record it as used (challenge id, and for
 * Solana the payer's signature, so the same transaction cannot pay two
 * challenges), then submit it through `deps` and build the
 * `Payment-Receipt`. The server's keys stay behind `deps`.
 *
 * The challenge is consumed before anything is sent: a settlement that then
 * fails leaves it used, and the client pays a fresh challenge. Throws a
 * `PaymentProblem` like `verifyCredential`.
 */
export async function settleCredential(
  verified: VerifiedCredential,
  deps: SettleDeps,
): Promise<SettledCredential> {
  try {
    return await settle(verified, deps);
  } catch (error) {
    throw toPaymentProblem(error);
  }
}

async function settle(
  verified: VerifiedCredential,
  deps: SettleDeps,
): Promise<SettledCredential> {
  if (!verifiedResults.has(verified)) {
    throw new TypeError(
      "settleCredential takes only verifyCredential results.",
    );
  }
  if (!deps?.replay)
    throw new TypeError("settleCredential needs a replay store.");
  const now = deps.now ?? Date.now();
  if (now >= verified.expiresAt) {
    problem("payment-expired", "The challenge has expired.");
  }
  const { challenge } = verified;
  const consume = async (key: string, until: number) => {
    if ((await deps.replay.consume(key, until)) !== true) {
      problem(
        "invalid-challenge",
        "The challenge or its payment was already used.",
      );
    }
  };
  await consume(challengeKey(challenge), verified.expiresAt);

  let reference: string;
  const extra: Record<string, unknown> = {};
  if (verified.method === "evm") {
    const m = verified.evm.authorization.message;
    await consume(
      `mpp:evm:${verified.request.chainId}:${verified.request.currency.toLowerCase()}:${m.from.toLowerCase()}:${m.nonce.toLowerCase()}`,
      Number(m.validBefore) * 1000,
    );
    reference = await settleEvmAuthorization(verified.evm, deps.evm);
    extra.chainId = verified.request.chainId;
  } else {
    await consume(
      `mpp:solana:${verified.solana.messageHash}`,
      verified.expiresAt + SIGNATURE_RETENTION_MS,
    );
    reference = await settleSolanaTransaction(
      verified.request,
      verified.solana,
      deps.solana,
    );
  }
  if (verified.request.externalId !== undefined) {
    extra.externalId = verified.request.externalId;
  }
  const receipt: MppReceipt = {
    status: "success",
    method: verified.method,
    timestamp: new Date(deps.now ?? Date.now()).toISOString(),
    reference,
    challengeId: challenge.id,
    ...extra,
  };
  return { receipt, header: encodeCanonical(receipt) };
}
