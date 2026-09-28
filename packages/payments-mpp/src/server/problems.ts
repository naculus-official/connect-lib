import { PAYMENT_RECEIPT_HEADER, WWW_AUTHENTICATE_HEADER } from "../wire";

/**
 * Problem types of `draft-httpauth-payment-01` §Error Codes, as RFC 9457
 * problem details under `https://paymentauth.org/problems/`.
 */
export const PROBLEM_TYPES = {
  "payment-required": { status: 402, title: "Payment Required" },
  "payment-insufficient": { status: 402, title: "Payment Insufficient" },
  "payment-expired": { status: 402, title: "Payment Expired" },
  "verification-failed": { status: 402, title: "Verification Failed" },
  "method-unsupported": { status: 400, title: "Method Unsupported" },
  "malformed-credential": { status: 402, title: "Malformed Credential" },
  "invalid-challenge": { status: 402, title: "Invalid Challenge" },
  "bad-request": { status: 400, title: "Bad Request" },
  "invalid-payload": { status: 402, title: "Invalid Payload" },
  "internal-payment-error": { status: 500, title: "Internal Payment Error" },
  "payment-action-required": {
    status: 402,
    title: "Payment Action Required",
  },
} as const;

export type ProblemCode = keyof typeof PROBLEM_TYPES;

export const PROBLEM_BASE_URI = "https://paymentauth.org/problems/";

/** RFC 9457 problem details, as serialized. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
}

/**
 * Why a credential was refused. `detail` never carries the credential, the
 * binding secret or anything an RPC said: it is safe to return to the client.
 */
export class PaymentProblem extends Error {
  override name = "PaymentProblem";
  readonly type: string;
  readonly title: string;
  readonly status: number;
  constructor(
    readonly code: ProblemCode,
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(detail, options);
    this.type = `${PROBLEM_BASE_URI}${code}`;
    this.title = PROBLEM_TYPES[code].title;
    this.status = PROBLEM_TYPES[code].status;
  }

  toJSON(): ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.detail,
    };
  }
}

export function problem(code: ProblemCode, detail: string): never {
  throw new PaymentProblem(code, detail);
}

/**
 * Any error as a PaymentProblem: itself, or `internal-payment-error` with a
 * generic detail (the original stays in `cause`, not in the response).
 */
export function toPaymentProblem(error: unknown): PaymentProblem {
  if (error instanceof PaymentProblem) return error;
  return new PaymentProblem(
    "internal-payment-error",
    "The payment could not be processed.",
    { cause: error },
  );
}

/**
 * The response for a refused or missing credential: problem JSON, and for a
 * 402 the fresh `WWW-Authenticate: Payment` challenges the spec requires
 * (a 402 without one is refused here). `Cache-Control: no-store` always.
 */
export function problemResponse(
  error: unknown,
  challenges: readonly string[] = [],
): Response {
  const p = toPaymentProblem(error);
  const headers = new Headers({
    "Content-Type": "application/problem+json",
    "Cache-Control": "no-store",
  });
  if (p.status === 402) {
    if (challenges.length === 0) {
      throw new TypeError("A 402 needs at least one fresh Payment challenge.");
    }
    for (const c of challenges) headers.append(WWW_AUTHENTICATE_HEADER, c);
  }
  return new Response(JSON.stringify(p.toJSON()), {
    status: p.status,
    headers,
  });
}

/** The first 402 for an unpaid request (`payment-required`). */
export function paymentRequiredResponse(
  challenges: readonly string[],
  detail = "This resource requires payment.",
): Response {
  return problemResponse(
    new PaymentProblem("payment-required", detail),
    challenges,
  );
}

/**
 * Headers for the paid response: `Payment-Receipt` and
 * `Cache-Control: private`, which the spec requires with a receipt.
 */
export function receiptHeaders(receiptHeader: string): Headers {
  return new Headers({
    [PAYMENT_RECEIPT_HEADER]: receiptHeader,
    "Cache-Control": "private",
  });
}
