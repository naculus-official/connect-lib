import {
  decodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type X402PaymentRequirements,
  type X402ResourceInfo,
} from "../wire";
import {
  buildPaymentRequired,
  verifyPayment,
  type X402ServerDeps,
  type X402VerifiedPayment,
} from "./verify";

export interface X402PaywallOptions {
  /** What the resource accepts, in order of preference. */
  accepts: readonly X402PaymentRequirements[];
  /** Described in the challenge; `url` defaults to the request's URL. */
  resource?: Partial<X402ResourceInfo>;
  deps: X402ServerDeps;
}

/**
 * `verified: true` means the payment checked out, not that it was paid:
 * serve nothing until `settlePayment` reports `success: true`.
 */
export type X402PaywallResult =
  | { verified: true; payment: X402VerifiedPayment }
  | { verified: false; response: Response; reason?: string };

/**
 * Gate a Fetch API `Request` behind x402, framework-neutral: without a valid
 * `PAYMENT-SIGNATURE` it answers with the `Response` to return (402 with a
 * `PAYMENT-REQUIRED` challenge, or 400 when the header is not base64 JSON);
 * with one it returns the verified payment. Nothing is paid yet: settle it
 * with `settlePayment`, serve the resource only when the settlement reports
 * `success: true`, and put the settlement's `header` on the response as
 * `PAYMENT-RESPONSE`.
 */
export async function requirePayment(
  request: Request,
  options: X402PaywallOptions,
): Promise<X402PaywallResult> {
  const resource: X402ResourceInfo = {
    ...options.resource,
    url: options.resource?.url ?? request.url,
  };
  const challenge = (status: number, error: string, reason?: string) => ({
    verified: false as const,
    ...(reason ? { reason } : {}),
    response: new Response("{}", {
      status,
      headers: {
        "content-type": "application/json",
        [PAYMENT_REQUIRED_HEADER]: buildPaymentRequired(
          resource,
          options.accepts,
          { error },
        ),
      },
    }),
  });

  const header = request.headers.get(PAYMENT_SIGNATURE_HEADER);
  if (!header) {
    return challenge(402, "PAYMENT-SIGNATURE header is required");
  }
  if (decodeHeader(header) === null) {
    return challenge(
      400,
      "PAYMENT-SIGNATURE is not base64 JSON",
      "invalid_payload",
    );
  }
  const result = await verifyPayment(header, options.accepts, options.deps);
  if (!result.ok) return challenge(402, result.reason, result.reason);
  return { verified: true, payment: result };
}
