import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { readEvmRequest } from "../evm-charge";
import { readSolanaRequest } from "../solana-charge";
import {
  isRecord,
  type MppChallengeParams,
  PAYMENT_AUTHORIZATION_HEADER,
} from "../wire";

/**
 * Challenge issuance and binding (tempoxyz/mpp-specs
 * `draft-httpauth-payment-01` §Challenge Binding, HMAC-SHA256, at fe0d414;
 * the spec text is unchanged since 08e7dd8, which the client pins).
 *
 * The id is `base64url(HMAC-SHA256(secret, realm|method|intent|request|
 * expires|digest[|header]|opaque))`, so a server can verify a credential's
 * echoed challenge without storing it, and any edited parameter changes the
 * id. `description` is not bound (display only).
 */

/** A binding secret: UTF-8 text or bytes, at least 16 bytes long. */
export type ChallengeSecret = string | Uint8Array;

const MIN_SECRET_BYTES = 16;

function secretBytes(secret: ChallengeSecret): Uint8Array {
  const bytes = typeof secret === "string" ? utf8ToBytes(secret) : secret;
  if (!(bytes instanceof Uint8Array) || bytes.length < MIN_SECRET_BYTES) {
    throw new TypeError(
      `The challenge secret must be at least ${MIN_SECRET_BYTES} bytes.`,
    );
  }
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * RFC 8785 (JCS) serialization of plain JSON data: object keys sorted by
 * UTF-16 code units, ECMAScript number and string serialization. Throws on
 * anything JSON cannot carry unchanged (undefined, functions, non-finite
 * numbers, lone surrogates, class instances) rather than dropping it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite number.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw new TypeError("JCS: lone surrogate.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Array.from visits holes (as undefined, which throws) where map skips.
    return `[${Array.from(value, canonicalJson).join(",")}]`;
  }
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    const entries = Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${canonicalJson(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      );
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`JCS: ${typeof value} is not JSON data.`);
}

/** base64url (no padding) of the JCS serialization of `value`. */
export function encodeCanonical(value: unknown): string {
  return base64Url(utf8ToBytes(canonicalJson(value)));
}

/** The bound parameters of a challenge (everything but `id`/`description`). */
export type BoundParams = Pick<
  MppChallengeParams,
  "realm" | "method" | "intent" | "request" | "expires" | "digest" | "header"
> & { opaque?: string };

/** The HMAC input exactly as the spec lays it out. */
export function challengeBindingInput(p: BoundParams): string {
  const values = [
    p.realm,
    p.method,
    p.intent,
    p.request,
    p.expires ?? "",
    p.digest ?? "",
  ];
  if (p.header !== undefined) values.push(p.header);
  values.push(p.opaque ?? "");
  return values.join("|");
}

/** The challenge `id` for these parameters under `secret`. */
export function challengeId(p: BoundParams, secret: ChallengeSecret): string {
  return base64Url(
    hmac(sha256, secretBytes(secret), utf8ToBytes(challengeBindingInput(p))),
  );
}

/** Constant-time string equality (length is not hidden). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = utf8ToBytes(a);
  const y = utf8ToBytes(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++)
    diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

export interface CreateChallengeInput {
  realm: string;
  /** `evm` and `solana` requests are checked; other methods are bound only. */
  method: string;
  intent: "charge";
  /** The request object; serialized here with JCS. */
  request: Record<string, unknown>;
  /**
   * When the challenge expires: RFC 3339 text or a Date. Required for `evm`
   * and `solana` (the method specs make it so; verification refuses a
   * challenge without it).
   */
  expires?: string | Date;
  secret: ChallengeSecret;
  /** RFC 9530 digest of the request body the credential must come with. */
  digest?: string;
  /** Display only; not bound. */
  description?: string;
  /** Ask for the credential in `Payment-Authorization`. */
  header?: typeof PAYMENT_AUTHORIZATION_HEADER;
  /** Server correlation data: a flat string map, bound and echoed. */
  opaque?: Record<string, string>;
}

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const METHOD = /^[a-z]+$/;
const INTENT = /^[A-Za-z0-9-]+$/;

/** Printable ASCII only: anything else cannot be sent as a quoted-string. */
function quotable(name: string, value: string): string {
  if (typeof value !== "string" || !/^[\x20-\x7e]*$/.test(value)) {
    throw new TypeError(`${name} must be printable ASCII.`);
  }
  return value;
}

/** Epoch milliseconds of an RFC 3339 time, or NaN. */
export function parseRfc3339(value: string): number {
  return RFC3339.test(value) ? Date.parse(value) : Number.NaN;
}

/**
 * The parameters of a new challenge, with its bound id. Throws on input the
 * server should not send: a request the method's client would refuse, a
 * missing `expires` for a chain method, a `header` other than
 * `Payment-Authorization`, non-ASCII parameter text.
 */
export function buildChallenge(
  input: CreateChallengeInput,
): MppChallengeParams {
  const { realm, method, intent, request, secret } = input;
  quotable("realm", realm);
  if (!realm) throw new TypeError("realm must not be empty.");
  if (!METHOD.test(method)) throw new TypeError("method is not lowercase.");
  if (!INTENT.test(intent)) throw new TypeError("intent is not a token.");
  if (!isRecord(request)) throw new TypeError("request must be an object.");
  let expires: string | undefined;
  if (input.expires instanceof Date) {
    if (!Number.isFinite(input.expires.getTime())) {
      throw new TypeError("expires is not a valid Date.");
    }
    expires = input.expires.toISOString();
  } else if (input.expires !== undefined) {
    if (!Number.isFinite(parseRfc3339(input.expires))) {
      throw new TypeError("expires is not an RFC 3339 time.");
    }
    expires = input.expires;
  }
  if (method === "evm" || method === "solana") {
    if (intent !== "charge") throw new TypeError("Only charge is supported.");
    if (expires === undefined) {
      throw new TypeError(`A ${method} challenge needs expires.`);
    }
    const reason =
      method === "evm"
        ? readEvmRequest(request)
        : readServerSolanaRequest(request);
    if (typeof reason === "string") {
      throw new TypeError(`The ${method} request is refused: ${reason}.`);
    }
  }
  if (
    input.header !== undefined &&
    input.header !== PAYMENT_AUTHORIZATION_HEADER
  ) {
    throw new TypeError(`header may only be ${PAYMENT_AUTHORIZATION_HEADER}.`);
  }
  let opaque: string | undefined;
  if (input.opaque !== undefined) {
    if (
      !isRecord(input.opaque) ||
      !Object.values(input.opaque).every((v) => typeof v === "string")
    ) {
      throw new TypeError("opaque must be a flat string map.");
    }
    opaque = encodeCanonical(input.opaque);
  }
  if (input.digest !== undefined) quotable("digest", input.digest);
  if (input.description !== undefined) {
    quotable("description", input.description);
  }
  const params: MppChallengeParams = {
    id: "",
    realm,
    method,
    intent,
    request: encodeCanonical(request),
    ...(expires !== undefined ? { expires } : {}),
    ...(input.digest !== undefined ? { digest: input.digest } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.header !== undefined ? { header: input.header } : {}),
    ...(opaque !== undefined ? { opaque } : {}),
  };
  params.id = challengeId(params, secret);
  return params;
}

/** A challenge's `WWW-Authenticate` field value. */
export function formatChallenge(params: MppChallengeParams): string {
  const order = [
    "id",
    "realm",
    "method",
    "intent",
    "request",
    "expires",
    "digest",
    "description",
    "header",
    "opaque",
  ] as const;
  const parts: string[] = [];
  for (const name of order) {
    const value = params[name];
    if (value === undefined) continue;
    parts.push(
      `${name}="${quotable(name, value).replace(/(["\\])/g, "\\$1")}"`,
    );
  }
  return `Payment ${parts.join(", ")}`;
}

/**
 * A new `WWW-Authenticate: Payment` field value whose `id` is bound to its
 * parameters with HMAC-SHA256 under `secret`.
 *
 * The id is a function of the parameters: two challenges with the same
 * parameters share it, and the replay store lets only one of them be paid.
 * When concurrent payers could be offered identical challenges, make them
 * differ (for example with a per-request `opaque`).
 */
export function createChallenge(input: CreateChallengeInput): string {
  return formatChallenge(buildChallenge(input));
}

/**
 * A Solana request this server can verify: what the client accepts, plus an
 * explicit `tokenProgram` (the destination account is derived from it).
 */
export function readServerSolanaRequest(request: Record<string, unknown>) {
  const read = readSolanaRequest(request);
  if (typeof read === "string") return read;
  if (!read.tokenProgram) return "methodDetails.tokenProgram is missing";
  return read;
}
