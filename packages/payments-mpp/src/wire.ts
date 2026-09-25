/**
 * MPP wire format over HTTP (tempoxyz/mpp-specs `draft-httpauth-payment-01`
 * at 08e7dd8, checked 2026-09-26).
 *
 * A 402 carries one or more `WWW-Authenticate: Payment` challenges made of
 * RFC 9110 auth-params. The client answers one of them with
 * `Payment <base64url JSON>` in `Authorization` (or `Payment-Authorization`
 * when the challenge says so); a paid response may carry `Payment-Receipt`.
 *
 * Parsing fails closed: every field of a challenge decides what a session key
 * is asked to sign, so a challenge that does not match the grammar exactly is
 * refused, never partially trusted.
 */

export const WWW_AUTHENTICATE_HEADER = "WWW-Authenticate";
export const PAYMENT_RECEIPT_HEADER = "Payment-Receipt";
export const PAYMENT_AUTHORIZATION_HEADER = "Payment-Authorization";

export type MppErrorCode =
  | "invalid_challenge"
  | "no_acceptable_challenge"
  | "invalid_receipt"
  | "payment_rejected"
  | "invalid_input";

export class MppError extends Error {
  override name = "MppError";
  constructor(
    readonly code: MppErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: MppErrorCode, message: string): never {
  throw new MppError(code, message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── base64url (RFC 4648 §5, no padding) ─────────────────────────────

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** UTF-8 JSON → base64url without padding. */
export function encodeBase64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** base64url (no padding) → UTF-8 JSON; `null` when it is not exactly that. */
export function decodeBase64UrlJson(value: string): unknown {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  try {
    const padded =
      value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (value.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

// ── WWW-Authenticate (RFC 9110 §11.6.1) ─────────────────────────────

const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;
const TOKEN68_CHAR = /[A-Za-z0-9\-._~+/]/;

interface RawChallenge {
  scheme: string;
  params: Record<string, string>;
  /** Why the challenge is unusable (a duplicated parameter), or undefined. */
  error?: string;
}

/**
 * Split a `WWW-Authenticate` value into challenges. Several challenges may
 * share one field value (and `Headers.get` joins repeated fields with ", "),
 * so this is a real tokenizer rather than a split on commas. Throws on a value
 * that does not follow the grammar.
 */
export function parseAuthenticate(value: string): RawChallenge[] {
  const challenges: RawChallenge[] = [];
  let i = 0;
  const n = value.length;
  const bad = (why: string): never =>
    fail("invalid_challenge", `Malformed WWW-Authenticate: ${why}.`);
  const skipOws = () => {
    while (i < n && (value[i] === " " || value[i] === "\t")) i++;
  };
  const token = (): string => {
    const start = i;
    while (i < n && TCHAR.test(value[i] as string)) i++;
    return value.slice(start, i);
  };
  /** Does an auth-param (`token BWS "="`, not token68 padding) start here? */
  const atParam = (): boolean => {
    let j = i;
    while (j < n && TCHAR.test(value[j] as string)) j++;
    if (j === i) return false;
    while (j < n && (value[j] === " " || value[j] === "\t")) j++;
    if (value[j] !== "=") return false;
    j++;
    while (j < n && (value[j] === " " || value[j] === "\t")) j++;
    // `abc==` is token68; `abc="x"` or `abc=x` is a parameter.
    return j < n && value[j] !== "=" && value[j] !== ",";
  };
  const quoted = (): string => {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = value[i] as string;
      if (c === '"') {
        i++;
        return out;
      }
      let ch = c;
      if (c === "\\") {
        i++;
        if (i >= n) break;
        ch = value[i] as string;
      }
      // Quoted text and quoted-pairs both exclude control characters but tab.
      const code = ch.charCodeAt(0);
      if ((code < 0x20 && ch !== "\t") || code === 0x7f) {
        bad("control character");
      }
      out += ch;
      i++;
    }
    return bad("unterminated quoted-string");
  };

  for (;;) {
    while (
      i < n &&
      (value[i] === "," || value[i] === " " || value[i] === "\t")
    ) {
      i++;
    }
    if (i >= n) break;
    const scheme = token();
    if (!scheme) bad(`unexpected "${value[i]}"`);
    const challenge: RawChallenge = { scheme, params: {} };
    challenges.push(challenge);
    skipOws();
    if (i >= n || value[i] === ",") continue;
    if (!atParam()) {
      // token68: consumed and ignored; no Payment challenge uses it.
      const start = i;
      while (i < n && TOKEN68_CHAR.test(value[i] as string)) i++;
      while (i < n && value[i] === "=") i++;
      if (i === start) bad(`unexpected "${value[i]}"`);
      skipOws();
      if (i < n && value[i] !== ",") bad("token68 followed by more data");
      continue;
    }
    // auth-params, until the next challenge's scheme or the end.
    for (;;) {
      const name = token().toLowerCase();
      skipOws();
      if (value[i] !== "=") bad(`parameter ${name} has no value`);
      i++;
      skipOws();
      let paramValue: string;
      if (value[i] === '"') paramValue = quoted();
      else {
        paramValue = token();
        if (!paramValue) bad(`parameter ${name} has no value`);
      }
      if (Object.hasOwn(challenge.params, name)) {
        challenge.error = `parameter ${name} appears twice`;
      } else {
        challenge.params[name] = paramValue;
      }
      skipOws();
      if (i >= n) break;
      if (value[i] !== ",") bad(`unexpected "${value[i]}" after ${name}`);
      while (
        i < n &&
        (value[i] === "," || value[i] === " " || value[i] === "\t")
      ) {
        i++;
      }
      if (i >= n || !atParam()) break;
    }
  }
  return challenges;
}

// ── Payment challenges ──────────────────────────────────────────────

/** A `Payment` challenge exactly as received; echoed back in the credential. */
export interface MppChallengeParams {
  id: string;
  realm: string;
  method: string;
  intent: string;
  /** base64url JCS JSON, as received. */
  request: string;
  expires?: string;
  digest?: string;
  description?: string;
  /** Only `Payment-Authorization` is legal. */
  header?: string;
  opaque?: string;
}

export interface MppChallenge {
  params: MppChallengeParams;
  /** The decoded `request` object. */
  request: Record<string, unknown>;
  /** `expires` in milliseconds since the epoch, when present. */
  expiresAt?: number;
}

/** A `Payment` challenge this client could not read, and why. */
export interface MppRejectedChallenge {
  params: Record<string, string>;
  reason: string;
}

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const METHOD = /^[a-z]+$/;
const INTENT = /^[A-Za-z0-9-]+$/;

function readChallenge(raw: RawChallenge): MppChallenge | string {
  if (raw.error) return raw.error;
  const p = raw.params;
  for (const name of ["id", "realm", "method", "intent", "request"]) {
    if (typeof p[name] !== "string") return `${name} is missing`;
  }
  if (!p.id) return "id is empty";
  if (!METHOD.test(p.method as string)) return "method is not lowercase ASCII";
  if (!INTENT.test(p.intent as string)) return "intent is not a token";
  const request = decodeBase64UrlJson(p.request as string);
  if (!isRecord(request)) return "request is not base64url JSON";
  if (p.header !== undefined && p.header !== PAYMENT_AUTHORIZATION_HEADER) {
    return `header ${p.header} is not ${PAYMENT_AUTHORIZATION_HEADER}`;
  }
  if (p.opaque !== undefined) {
    const opaque = decodeBase64UrlJson(p.opaque);
    if (
      !isRecord(opaque) ||
      !Object.values(opaque).every((v) => typeof v === "string")
    ) {
      return "opaque is not a base64url JSON string map";
    }
  }
  let expiresAt: number | undefined;
  if (p.expires !== undefined) {
    expiresAt = RFC3339.test(p.expires) ? Date.parse(p.expires) : Number.NaN;
    if (!Number.isFinite(expiresAt)) return "expires is not an RFC 3339 time";
  }
  const params: MppChallengeParams = {
    id: p.id as string,
    realm: p.realm as string,
    method: p.method as string,
    intent: p.intent as string,
    request: p.request as string,
  };
  for (const name of [
    "expires",
    "digest",
    "description",
    "header",
    "opaque",
  ] as const) {
    if (p[name] !== undefined) params[name] = p[name];
  }
  return {
    params,
    request,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/**
 * The `Payment` challenges of a 402's `WWW-Authenticate` value, in the
 * server's order. Challenges of other schemes are ignored; unreadable
 * `Payment` challenges are returned in `rejected` with the reason.
 */
export function parsePaymentChallenges(value: string | null): {
  challenges: MppChallenge[];
  rejected: MppRejectedChallenge[];
} {
  if (!value) {
    fail("invalid_challenge", "The 402 carries no WWW-Authenticate header.");
  }
  const challenges: MppChallenge[] = [];
  const rejected: MppRejectedChallenge[] = [];
  for (const raw of parseAuthenticate(value)) {
    if (raw.scheme.toLowerCase() !== "payment") continue;
    const read = readChallenge(raw);
    if (typeof read === "string") {
      rejected.push({ params: raw.params, reason: read });
    } else {
      challenges.push(read);
    }
  }
  if (challenges.length === 0 && rejected.length === 0) {
    fail("invalid_challenge", "The 402 carries no Payment challenge.");
  }
  return { challenges, rejected };
}

// ── Credential and receipt ──────────────────────────────────────────

export interface MppCredential {
  challenge: MppChallengeParams;
  payload: Record<string, unknown>;
  source?: string;
}

/** The credential's field name and value (`Payment <base64url JSON>`). */
export function encodeCredential(credential: MppCredential): {
  header: string;
  value: string;
} {
  return {
    header: credential.challenge.header ?? "Authorization",
    value: `Payment ${encodeBase64UrlJson(credential)}`,
  };
}

export interface MppReceipt {
  status: "success";
  method: string;
  timestamp: string;
  reference: string;
  /** Method-specific fields (EVM: `challengeId`, `chainId`, `externalId`). */
  [field: string]: unknown;
}

/** Parse `Payment-Receipt`; `null` when absent, throws when malformed. */
export function parsePaymentReceipt(value: string | null): MppReceipt | null {
  if (value === null) return null;
  const receipt = decodeBase64UrlJson(value.trim());
  if (
    !isRecord(receipt) ||
    receipt.status !== "success" ||
    typeof receipt.method !== "string" ||
    typeof receipt.timestamp !== "string" ||
    typeof receipt.reference !== "string"
  ) {
    fail("invalid_receipt", "Payment-Receipt is malformed.");
  }
  return receipt as MppReceipt;
}
