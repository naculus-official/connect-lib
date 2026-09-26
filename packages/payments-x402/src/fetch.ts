import {
  createPaymentPayload,
  type SelectOptions,
  selectRequirement,
  type X402TypedDataSigner,
} from "./evm-exact";
import { createSvmPaymentPayload, type X402SolanaOptions } from "./svm-exact";
import {
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  parsePaymentRequired,
  parseSettlementResponse,
  X402Error,
  type X402PaymentRequired,
  type X402PaymentRequirements,
  type X402SettlementResponse,
} from "./wire";

export interface X402FetchOptions
  extends Omit<SelectOptions, "evm" | "solana"> {
  /** Pays EVM requirements: a policy-bound session key (EIP-3009). */
  signer?: X402TypedDataSigner;
  /** Pays Solana requirements: the connected wallet signs each one. */
  solana?: X402SolanaOptions;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /**
   * Last word before signing. Return false to decline this payment; the
   * session key's policy still applies when this returns true.
   */
  approve?: (
    requirement: X402PaymentRequirements,
    required: X402PaymentRequired,
  ) => boolean | Promise<boolean>;
}

export interface X402FetchResult {
  response: Response;
  /** The requirement that was paid, or null when no payment was asked for. */
  paid: X402PaymentRequirements | null;
  settlement: X402SettlementResponse | null;
}

/**
 * fetch that pays an x402 challenge once with a session key.
 *
 * A 402 with a `PAYMENT-REQUIRED` header is answered by signing an EIP-3009
 * authorization for the first requirement this client can pay, and the
 * request is retried exactly once with `PAYMENT-SIGNATURE`. A second 402 is
 * an error, not another payment. The challenge must come from the requested
 * origin without a redirect and describe a resource there, and the paid
 * retry never follows a redirect. A paid response whose `PAYMENT-RESPONSE`
 * is malformed is returned with `settlement: null`.
 */
export function createX402Fetch(options: X402FetchOptions) {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const { signer, solana } = options;
  if (!signer && !solana) {
    throw new X402Error(
      "invalid_input",
      "createX402Fetch needs a signer, a solana signer, or both.",
    );
  }

  return async function x402Fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<X402FetchResult> {
    // Keep an unread copy: the retry must carry the same body.
    const request = new Request(input, init);
    const first = await send(request.clone());
    if (first.status !== 402) {
      return { response: first, paid: null, settlement: null };
    }

    // The challenge body is not part of the protocol; release the connection.
    void first.body?.cancel().catch(() => {});
    const requested = new URL(request.url);
    // A 402 reached through a redirect came from wherever the redirect led,
    // and the paid retry would follow it there too: fetch strips only
    // Authorization and cookies across origins, not PAYMENT-SIGNATURE. So a
    // redirected challenge is refused, whatever resource.url it names
    // (independent review, 2026-09-24).
    if (
      first.redirected ||
      (first.url && new URL(first.url).origin !== requested.origin)
    ) {
      throw new X402Error(
        "invalid_challenge",
        "Payment challenge arrived through a redirect; refusing to pay.",
      );
    }
    const required = parsePaymentRequired(
      first.headers.get(PAYMENT_REQUIRED_HEADER),
    );
    let resource: URL;
    try {
      resource = new URL(required.resource.url, requested);
    } catch {
      throw new X402Error(
        "invalid_challenge",
        "Challenge resource.url is not a URL.",
      );
    }
    if (resource.origin !== requested.origin) {
      throw new X402Error(
        "invalid_challenge",
        `Challenge is for ${resource.origin}, but the request went to ${requested.origin}.`,
      );
    }

    const requirement = selectRequirement(required, {
      ...(options.networks ? { networks: options.networks } : {}),
      evm: Boolean(signer),
      solana: Boolean(solana),
    });
    if (options.approve && !(await options.approve(requirement, required))) {
      throw new X402Error("payment_rejected", "Payment declined by approve().");
    }
    const payload = requirement.network.startsWith("solana:")
      ? await createSvmPaymentPayload(
          required,
          requirement,
          solana as X402SolanaOptions,
        )
      : await createPaymentPayload(
          required,
          requirement,
          signer as X402TypedDataSigner,
        );

    const headers = new Headers(request.headers);
    headers.set(PAYMENT_SIGNATURE_HEADER, encodeHeader(payload));
    // The signed payload must not follow a redirect anywhere.
    const second = await send(
      new Request(request, { headers, redirect: "error" }),
    );
    let settlement: X402SettlementResponse | null = null;
    try {
      settlement = parseSettlementResponse(
        second.headers.get(PAYMENT_RESPONSE_HEADER),
      );
    } catch (cause) {
      // Payment may already have settled; a malformed receipt must not cost
      // the caller the response it paid for.
      if (second.status === 402) throw cause;
    }
    if (second.status === 402) {
      throw new X402Error(
        "payment_rejected",
        `Server refused the payment${settlement?.errorReason ? `: ${settlement.errorReason}` : "."}`,
      );
    }
    return { response: second, paid: requirement, settlement };
  };
}
