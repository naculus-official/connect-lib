import {
  type SessionKeyManager,
  type SessionKeyTypedDataRequest,
  sessionKeyAddress,
} from "@naculus/connect-core";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  encodeCredential,
  isRecord,
  type MppChallenge,
  MppError,
  type MppRejectedChallenge,
} from "./wire";

/**
 * MPP `method="evm"`, `intent="charge"`, credential `type="authorization"`
 * (tempoxyz/mpp-specs `draft-evm-charge-00` at 08e7dd8; reference client
 * wevm/mppx `src/evm/client/Charge.ts`).
 *
 * The payer signs an EIP-3009 `TransferWithAuthorization` and the server
 * submits it — the same typed data a session key signs for x402, bounded by
 * the key's policy (token, payee, amount, chain, lifetime). Permit2,
 * `transaction` and `hash` credentials are refused: the policy engine cannot
 * bound a Permit2 witness transfer, and the other two would make the key sign
 * or broadcast a transfer transaction.
 */

/** Signs a TransferWithAuthorization as the session key, under its policy. */
export interface MppTypedDataSigner {
  /** The session key's own address; the authorization's `from`. */
  address: `0x${string}`;
  signTypedData(request: SessionKeyTypedDataRequest): Promise<`0x${string}`>;
}

/**
 * A signer backed by a SessionKeyManager. Payee, amount, token and chain are
 * enforced there, not here: give the key `allowedRecipients`,
 * `tokenAllowances` and `allowedChainIds` that describe what it may pay.
 */
export async function sessionKeyMppSigner(
  manager: SessionKeyManager,
  sessionId: string,
): Promise<MppTypedDataSigner> {
  const info = (await manager.listSessions()).find((s) => s.id === sessionId);
  if (!info) {
    throw new MppError("invalid_input", `Session key ${sessionId} not found.`);
  }
  return {
    address: sessionKeyAddress(info.publicKey),
    signTypedData: (request) =>
      manager.signTypedDataWithSessionKey(sessionId, request),
  };
}

/** A token's EIP-712 domain, which MPP challenges do not carry. */
export interface TokenDomain {
  chainId: number;
  address: `0x${string}`;
  name: string;
  version: string;
}

/**
 * Circle USDC on the chains Naculus supports for delegated session keys.
 * Each entry was read from the token (`name()`, `version()`) and checked
 * against its own `DOMAIN_SEPARATOR()` on 2026-09-26.
 */
export const USDC_DOMAINS: readonly TokenDomain[] = [
  {
    chainId: 1,
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    name: "USD Coin",
    version: "2",
  },
  {
    chainId: 11155111,
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    name: "USDC",
    version: "2",
  },
  {
    chainId: 8453,
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
  },
  {
    chainId: 84532,
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
  },
  {
    chainId: 42161,
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    name: "USD Coin",
    version: "2",
  },
  {
    chainId: 10,
    address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    name: "USD Coin",
    version: "2",
  },
  {
    chainId: 137,
    address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    name: "USD Coin",
    version: "2",
  },
];

/** The authorization's lifetime when a challenge has no `expires` (as mppx). */
export const DEFAULT_VALIDITY_SECONDS = 300;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;

export interface EvmChargeRequest {
  amount: string;
  currency: `0x${string}`;
  recipient: `0x${string}`;
  chainId: number;
  externalId?: string;
}

export interface SelectOptions {
  /** EIP-155 chain ids this client will pay on. Omitted: any. */
  chainIds?: readonly number[];
  /**
   * EIP-712 domains of tokens this client will pay with, checked before the
   * built-in USDC table (so an entry here overrides it).
   */
  tokenDomains?: readonly TokenDomain[];
  /** Milliseconds since the epoch; defaults to now. */
  now?: number;
}

/** A challenge this client can pay, with what it takes to sign it. */
export interface SelectedCharge {
  challenge: MppChallenge;
  request: EvmChargeRequest;
  domain: TokenDomain;
}

function readRequest(
  request: Record<string, unknown>,
): EvmChargeRequest | string {
  const { amount, currency, recipient, methodDetails, externalId } = request;
  if (typeof amount !== "string" || !DECIMAL.test(amount)) {
    return "amount is not a decimal integer string";
  }
  const value = BigInt(amount);
  if (value === 0n || value > UINT256_MAX) {
    return "amount is not a positive uint256";
  }
  if (typeof currency !== "string" || !ADDRESS.test(currency)) {
    return "currency is not a token address";
  }
  if (typeof recipient !== "string" || !ADDRESS.test(recipient)) {
    return "recipient is not an EVM address";
  }
  if (!isRecord(methodDetails)) return "methodDetails is missing";
  const { chainId, credentialTypes, splits } = methodDetails;
  if (
    typeof chainId !== "number" ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    return "methodDetails.chainId is not a positive integer";
  }
  // Absent means "transaction" (and maybe "hash") only, per the spec.
  if (
    !Array.isArray(credentialTypes) ||
    !credentialTypes.includes("authorization")
  ) {
    return "the challenge does not accept an EIP-3009 authorization";
  }
  if (splits !== undefined && (!Array.isArray(splits) || splits.length > 0)) {
    return "payment splits are not supported";
  }
  if (externalId !== undefined && typeof externalId !== "string") {
    return "externalId is not a string";
  }
  return {
    amount,
    currency: currency as `0x${string}`,
    recipient: recipient as `0x${string}`,
    chainId,
    ...(externalId !== undefined ? { externalId } : {}),
  };
}

function findDomain(
  request: EvmChargeRequest,
  options: SelectOptions,
): TokenDomain | undefined {
  const matches = (d: TokenDomain) =>
    d.chainId === request.chainId &&
    d.address.toLowerCase() === request.currency.toLowerCase();
  return options.tokenDomains?.find(matches) ?? USDC_DOMAINS.find(matches);
}

/** Why a challenge is unusable by this client, or null when it is usable. */
export function unsupportedReason(
  challenge: MppChallenge,
  options: SelectOptions = {},
): string | null {
  const { method, intent } = challenge.params;
  if (method !== "evm") return `method ${method} is not supported`;
  if (intent !== "charge") return `intent ${intent} is not supported`;
  const now = options.now ?? Date.now();
  // validBefore is whole seconds: an expiry inside the current second leaves
  // nothing to sign for.
  if (
    challenge.expiresAt !== undefined &&
    Math.floor(challenge.expiresAt / 1000) <= Math.floor(now / 1000)
  ) {
    return "the challenge has expired";
  }
  const request = readRequest(challenge.request);
  if (typeof request === "string") return request;
  if (options.chainIds && !options.chainIds.includes(request.chainId)) {
    return `chain ${request.chainId} is not in the allowed list`;
  }
  if (!findDomain(request, options)) {
    return `no EIP-712 domain is known for token ${request.currency} on chain ${request.chainId}`;
  }
  return null;
}

/** The first challenge, in the server's order, this client can pay. */
export function selectCharge(
  challenges: readonly MppChallenge[],
  options: SelectOptions = {},
  rejected: readonly MppRejectedChallenge[] = [],
): SelectedCharge {
  const reasons = rejected.map((r) => r.reason);
  for (const challenge of challenges) {
    const reason = unsupportedReason(challenge, options);
    if (reason) {
      reasons.push(reason);
      continue;
    }
    const request = readRequest(challenge.request) as EvmChargeRequest;
    return {
      challenge,
      request,
      domain: findDomain(request, options) as TokenDomain,
    };
  }
  throw new MppError(
    "no_acceptable_challenge",
    `No payable challenge: ${reasons.join("; ") || "none offered"}.`,
  );
}

/**
 * The EIP-3009 nonce the spec binds to the challenge:
 * `keccak256(challenge.id ‖ challenge.realm)` over their UTF-8 bytes.
 */
export function challengeNonce(challenge: {
  id: string;
  realm: string;
}): `0x${string}` {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(`${challenge.id}${challenge.realm}`)))}`;
}

/** The EIP-3009 typed data that pays `selected` from `from`. */
export function buildChargeAuthorization(
  selected: SelectedCharge,
  from: `0x${string}`,
  options: { now?: number } = {},
): SessionKeyTypedDataRequest {
  const { challenge, request, domain } = selected;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const validBefore =
    challenge.expiresAt !== undefined
      ? Math.floor(challenge.expiresAt / 1000)
      : nowSeconds + DEFAULT_VALIDITY_SECONDS;
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: request.chainId,
      verifyingContract: request.currency,
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: request.recipient,
      value: request.amount,
      validAfter: "0",
      validBefore: String(validBefore),
      nonce: challengeNonce(challenge.params),
    },
  };
}

/**
 * Sign `selected` and build the credential. Returns the HTTP field the
 * challenge selected and its value.
 */
export async function createChargeCredential(
  selected: SelectedCharge,
  signer: MppTypedDataSigner,
  options: { now?: number } = {},
): Promise<{ header: string; value: string }> {
  const typedData = buildChargeAuthorization(selected, signer.address, options);
  const signature = await signer.signTypedData(typedData);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new MppError(
      "invalid_input",
      "Signer did not return a 65-byte signature.",
    );
  }
  return encodeCredential({
    challenge: selected.challenge.params,
    payload: { type: "authorization", ...typedData.message, signature },
    source: `did:pkh:eip155:${selected.request.chainId}:${signer.address}`,
  });
}
