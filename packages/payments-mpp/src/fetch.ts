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
  type MppSolanaSessionKey,
  readSolanaRequest,
  sessionKeyMismatch,
} from "./solana-charge";
import {
  MppError,
  type MppReceipt,
  PAYMENT_RECEIPT_HEADER,
  parsePaymentChallenges,
  parsePaymentReceipt,
  problemDetail,
  WWW_AUTHENTICATE_HEADER,
} from "./wire";

export type MppChargeSettlementBinding =
  | {
      rail: "eip3009";
      chainId: string;
      token: string;
      from: string;
      to: string;
      amount: string;
      nonce: string;
    }
  | {
      rail: "solana";
      cluster: string;
      mint: string;
      payer: string;
      signer: string;
      recipient: string;
      amount: string;
      signedMessageHash: string;
    };

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
  settlementBinding: MppChargeSettlementBinding | null;
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
      return {
        response: first,
        paid: null,
        receipt: null,
        settlementBinding: null,
      };
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
    // A session key can pay only its own cluster, mint and sponsored fees.
    const payable = solana?.sessionKey
      ? await filterAsync(challenges, async (c) => {
          if (c.params.method !== "solana") return true;
          const request = readSolanaRequest(c.request, solana.networks);
          return (
            typeof request !== "string" &&
            (await sessionKeyMismatch(
              request,
              solana.sessionKey as MppSolanaSessionKey,
            )) === null
          );
        })
      : challenges;
    const selected = selectCharge(
      payable,
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
    const settlementBinding = credential.binding;

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
    return { response: second, paid: selected, receipt, settlementBinding };
  };
}

async function filterAsync<T>(
  items: readonly T[],
  keep: (item: T) => Promise<boolean>,
): Promise<T[]> {
  const kept = await Promise.all(items.map(keep));
  return items.filter((_, i) => kept[i]);
}
