import {
  createChargeCredential,
  type MppTypedDataSigner,
  type SelectedCharge,
  type SelectOptions,
  selectCharge,
} from "./evm-charge";
import {
  createSolanaChargeCredential,
  type MppSolanaNetwork,
  type MppSolanaOptions,
} from "./solana-charge";
import {
  MppError,
  type MppReceipt,
  PAYMENT_RECEIPT_HEADER,
  parsePaymentChallenges,
  parsePaymentReceipt,
  WWW_AUTHENTICATE_HEADER,
} from "./wire";

export interface MppFetchOptions
  extends Omit<SelectOptions, "now" | "evm" | "solana" | "solanaNetworks"> {
  /** Pays `evm` charges: a policy-bound session key (EIP-3009). */
  signer?: MppTypedDataSigner;
  /** Pays `solana` charges: the connected wallet signs each one. */
  solana?: MppSolanaOptions & { networks?: readonly MppSolanaNetwork[] };
  /**
   * Defaults to the global fetch. A replacement must report redirects
   * (`redirected` / `url`) and honour `redirect: "error"`; the redirect
   * refusals below rely on both.
   */
  fetch?: typeof fetch;
  /**
   * Last word before signing. Return false to decline this payment; the
   * session key's policy still applies when this returns true.
   */
  approve?: (selected: SelectedCharge) => boolean | Promise<boolean>;
}

export interface MppFetchResult {
  response: Response;
  /** The charge that was paid, or null when no payment was asked for. */
  paid: SelectedCharge | null;
  receipt: MppReceipt | null;
}

/** Bytes of a 402 problem body read for its `detail`; the rest is dropped. */
const PROBLEM_BODY_LIMIT = 4096;

async function problemDetail(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (
    !reader ||
    !response.headers.get("content-type")?.includes("application/problem+json")
  ) {
    void reader?.cancel().catch(() => {});
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < PROBLEM_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    return "";
  } finally {
    void reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const problem = JSON.parse(new TextDecoder().decode(body)) as {
      detail?: unknown;
    };
    if (typeof problem.detail !== "string") return "";
    // Server text goes into an error message: no control or escape codes.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them
    return `: ${problem.detail.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200)}`;
  } catch {
    return "";
  }
}

/**
 * fetch that pays an MPP `evm` charge once with a session key.
 *
 * A 402 with `WWW-Authenticate: Payment` challenges is answered by signing an
 * EIP-3009 authorization for the first challenge this client can pay, and the
 * request is retried exactly once with the credential in the field the
 * challenge selected. A second 402 is an error, not another payment. The
 * challenge must come from the requested origin without a redirect, and the
 * paid retry never follows a redirect. A paid response whose
 * `Payment-Receipt` is malformed or names another challenge is returned with
 * `receipt: null`.
 */
export function createMppFetch(options: MppFetchOptions) {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const { signer, solana } = options;
  if (!signer && !solana) {
    throw new MppError(
      "invalid_input",
      "createMppFetch needs a signer, a solana signer, or both.",
    );
  }

  return async function mppFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<MppFetchResult> {
    // Keep an unread copy: the retry must carry the same body (a challenge
    // with `digest` binds it).
    const request = new Request(input, init);
    const first = await send(request.clone());
    if (first.status !== 402) {
      return { response: first, paid: null, receipt: null };
    }

    void first.body?.cancel().catch(() => {});
    const requested = new URL(request.url);
    // A challenge reached through a redirect came from wherever the redirect
    // led, and fetch does not strip Payment-Authorization across origins.
    if (
      first.redirected ||
      (first.url && new URL(first.url).origin !== requested.origin)
    ) {
      throw new MppError(
        "invalid_challenge",
        "Payment challenge arrived through a redirect; refusing to pay.",
      );
    }
    const { challenges, rejected } = parsePaymentChallenges(
      first.headers.get(WWW_AUTHENTICATE_HEADER),
    );
    const selected = selectCharge(
      challenges,
      {
        ...(options.chainIds ? { chainIds: options.chainIds } : {}),
        ...(options.tokenDomains ? { tokenDomains: options.tokenDomains } : {}),
        evm: Boolean(signer),
        solana: Boolean(solana),
        ...(solana?.networks ? { solanaNetworks: solana.networks } : {}),
      },
      rejected,
    );
    if (options.approve && !(await options.approve(selected))) {
      throw new MppError("payment_rejected", "Payment declined by approve().");
    }
    const credential =
      selected.method === "solana"
        ? await createSolanaChargeCredential(
            selected.challenge,
            selected.request,
            solana as MppSolanaOptions,
          )
        : await createChargeCredential(selected, signer as MppTypedDataSigner);

    const headers = new Headers(request.headers);
    headers.set(credential.header, credential.value);
    // The signed credential must not follow a redirect anywhere.
    const second = await send(
      new Request(request, { headers, redirect: "error" }),
    );
    if (second.status === 402) {
      throw new MppError(
        "payment_rejected",
        `Server refused the payment${await problemDetail(second)}.`,
      );
    }
    let receipt: MppReceipt | null = null;
    try {
      receipt = parsePaymentReceipt(second.headers.get(PAYMENT_RECEIPT_HEADER));
    } catch {
      // Payment may already have settled; a malformed receipt must not cost
      // the caller the response it paid for.
    }
    if (
      receipt &&
      receipt.challengeId !== undefined &&
      receipt.challengeId !== selected.challenge.params.id
    ) {
      receipt = null;
    }
    return { response: second, paid: selected, receipt };
  };
}
