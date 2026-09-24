/**
 * x402 v2 wire format over HTTP (coinbase/x402 `specs/x402-specification-v2.md`
 * and `specs/transports-v2/http.md`, checked 2026-09-24).
 *
 * All protocol data travels in three headers, each base64-encoded JSON:
 * `PAYMENT-REQUIRED` (server → client, with status 402), `PAYMENT-SIGNATURE`
 * (client → server) and `PAYMENT-RESPONSE` (server → client). Response bodies
 * are not part of the protocol, so nothing here reads them.
 *
 * Parsing fails closed: a challenge that does not match the shape exactly is
 * refused, never partially trusted, because every field of it decides what a
 * session key is asked to sign.
 */

export const X402_VERSION = 2;

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** One way the server accepts payment (`accepts[]` entry). */
export interface X402PaymentRequirements {
  scheme: string;
  /** CAIP-2, e.g. `eip155:8453`. */
  network: string;
  /** Atomic token units, decimal string. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface X402PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface X402PaymentPayload {
  x402Version: 2;
  resource?: X402ResourceInfo;
  accepted: X402PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface X402SettlementResponse {
  success: boolean;
  /** Settlement transaction hash; empty on failure. */
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export type X402ErrorCode =
  | "invalid_challenge"
  | "no_acceptable_requirement"
  | "invalid_settlement"
  | "payment_rejected"
  | "invalid_input";

export class X402Error extends Error {
  override name = "X402Error";
  constructor(
    readonly code: X402ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: X402ErrorCode, message: string): never {
  throw new X402Error(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** UTF-8 JSON → base64, for a header value. */
export function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64 → UTF-8 JSON; `null` when the header is not valid base64 JSON. */
export function decodeHeader(value: string): unknown {
  try {
    const binary = atob(value.trim());
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function parseResource(value: unknown): X402ResourceInfo {
  if (!isRecord(value) || typeof value.url !== "string" || !value.url) {
    fail("invalid_challenge", "Challenge resource.url is missing.");
  }
  const resource: X402ResourceInfo = { url: value.url };
  if (typeof value.description === "string") {
    resource.description = value.description;
  }
  if (typeof value.mimeType === "string") resource.mimeType = value.mimeType;
  return resource;
}

function parseRequirements(value: unknown): X402PaymentRequirements | null {
  if (!isRecord(value)) return null;
  const { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra } =
    value;
  if (
    typeof scheme !== "string" ||
    typeof network !== "string" ||
    typeof amount !== "string" ||
    typeof asset !== "string" ||
    typeof payTo !== "string" ||
    typeof maxTimeoutSeconds !== "number" ||
    (extra !== undefined && !isRecord(extra))
  ) {
    return null;
  }
  return {
    scheme,
    network,
    amount,
    asset,
    payTo,
    maxTimeoutSeconds,
    ...(extra !== undefined ? { extra: { ...extra } } : {}),
  };
}

/**
 * Parse a `PAYMENT-REQUIRED` header. Entries of `accepts` with the wrong
 * shape are dropped (a server may list schemes this client cannot read);
 * a challenge with none left, or with the wrong version, is refused.
 */
export function parsePaymentRequired(
  header: string | null,
): X402PaymentRequired {
  if (!header)
    fail("invalid_challenge", "402 response has no PAYMENT-REQUIRED header.");
  const decoded = decodeHeader(header);
  if (!isRecord(decoded)) {
    fail("invalid_challenge", "PAYMENT-REQUIRED is not base64-encoded JSON.");
  }
  if (decoded.x402Version !== X402_VERSION) {
    fail(
      "invalid_challenge",
      `Unsupported x402Version ${String(decoded.x402Version)}; this client speaks ${X402_VERSION}.`,
    );
  }
  if (!Array.isArray(decoded.accepts)) {
    fail("invalid_challenge", "Challenge accepts must be an array.");
  }
  const accepts = decoded.accepts
    .map(parseRequirements)
    .filter((r): r is X402PaymentRequirements => r !== null);
  if (accepts.length === 0) {
    fail(
      "invalid_challenge",
      "Challenge lists no readable payment requirements.",
    );
  }
  if (decoded.extensions !== undefined && !isRecord(decoded.extensions)) {
    fail("invalid_challenge", "Challenge extensions must be an object.");
  }
  return {
    x402Version: X402_VERSION,
    ...(typeof decoded.error === "string" ? { error: decoded.error } : {}),
    resource: parseResource(decoded.resource),
    accepts,
    ...(decoded.extensions !== undefined
      ? { extensions: { ...(decoded.extensions as Record<string, unknown>) } }
      : {}),
  };
}

/** Parse a `PAYMENT-RESPONSE` header; `null` when the server sent none. */
export function parseSettlementResponse(
  header: string | null,
): X402SettlementResponse | null {
  if (!header) return null;
  const decoded = decodeHeader(header);
  if (
    !isRecord(decoded) ||
    typeof decoded.success !== "boolean" ||
    typeof decoded.transaction !== "string" ||
    typeof decoded.network !== "string"
  ) {
    fail(
      "invalid_settlement",
      "PAYMENT-RESPONSE is not a settlement response.",
    );
  }
  return {
    success: decoded.success,
    transaction: decoded.transaction,
    network: decoded.network,
    ...(typeof decoded.payer === "string" ? { payer: decoded.payer } : {}),
    ...(typeof decoded.errorReason === "string"
      ? { errorReason: decoded.errorReason }
      : {}),
  };
}
