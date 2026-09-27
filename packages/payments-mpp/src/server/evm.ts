import {
  recoverTypedDataSigner,
  type SessionKeyTypedDataRequest,
} from "@naculus/connect-core";
import {
  challengeNonce,
  type EvmChargeRequest,
  type TokenDomain,
  USDC_DOMAINS,
} from "../evm-charge";
import type { MppChallengeParams } from "../wire";
import { problem } from "./problems";

/**
 * Server side of MPP `method="evm"`, credential `type="authorization"`
 * (`draft-evm-charge-00` §Authorization Verification / Settlement): the
 * payer's EIP-3009 `TransferWithAuthorization`, which the server submits.
 * Permit2, `transaction` and `hash` credentials are refused, as on the
 * client.
 */

/** Chain reads the verification needs; answerable by any JSON-RPC node. */
export interface MppEvmRpc {
  /**
   * EIP-3009 `authorizationState(authorizer, nonce)` on `token`: true once
   * the nonce was used or canceled.
   */
  authorizationState(query: {
    chainId: number;
    token: `0x${string}`;
    authorizer: `0x${string}`;
    nonce: `0x${string}`;
  }): Promise<boolean>;
  /** ERC-20 `balanceOf(owner)` on `token`, in base units. */
  balanceOf(query: {
    chainId: number;
    token: `0x${string}`;
    owner: `0x${string}`;
  }): Promise<bigint>;
}

export interface MppEvmVerifyOptions {
  rpc: MppEvmRpc;
  /**
   * EIP-712 domains of the EIP-3009 tokens this server accepts, checked
   * before the built-in USDC table. A currency in neither is refused: the
   * spec requires the token to be known to implement EIP-3009.
   */
  tokenDomains?: readonly TokenDomain[];
}

/** What `deps.evm.submit` is asked to send. */
export interface EvmSubmission {
  chainId: number;
  /** The token contract; call `transferWithAuthorization` on it. */
  token: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
  /** The 65-byte signature, and its parts for the `(v, r, s)` overload. */
  signature: `0x${string}`;
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

export interface MppEvmSettleDeps {
  /**
   * Submit `transferWithAuthorization` with the server's own key (never held
   * here). Resolve only once the transaction is in a block and succeeded,
   * with its hash; reject otherwise. Simulating first (`eth_call`) is
   * recommended by the spec.
   */
  submit(submission: EvmSubmission): Promise<{ transactionHash: string }>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const ZERO = `0x${"0".repeat(40)}`;
const UINT256_MAX = (1n << 256n) - 1n;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface VerifiedEvmPayment {
  domain: TokenDomain;
  authorization: SessionKeyTypedDataRequest;
  signature: `0x${string}`;
  payer: `0x${string}`;
}

/** Check an authorization payload against its (already bound) challenge. */
export async function verifyEvmAuthorization(
  challenge: MppChallengeParams,
  request: EvmChargeRequest,
  payload: Record<string, unknown>,
  source: string | undefined,
  options: MppEvmVerifyOptions | undefined,
  now: number,
  expiresAt: number,
): Promise<VerifiedEvmPayment> {
  if (!options?.rpc) {
    throw new TypeError("verifyCredential needs evm.rpc for evm charges.");
  }
  if (payload.type !== "authorization") {
    problem(
      "invalid-payload",
      `Credential type ${String(payload.type)} is not accepted; use authorization.`,
    );
  }
  const { from, to, value, validAfter, validBefore, nonce, signature } =
    payload;
  if (
    typeof from !== "string" ||
    !ADDRESS.test(from) ||
    typeof to !== "string" ||
    !ADDRESS.test(to) ||
    typeof nonce !== "string" ||
    !BYTES32.test(nonce) ||
    typeof signature !== "string" ||
    !SIGNATURE.test(signature)
  ) {
    problem("invalid-payload", "The authorization payload is malformed.");
  }
  for (const [name, v] of [
    ["value", value],
    ["validAfter", validAfter],
    ["validBefore", validBefore],
  ] as const) {
    if (typeof v !== "string" || !DECIMAL.test(v) || BigInt(v) > UINT256_MAX) {
      problem("invalid-payload", `${name} is not a decimal uint256.`);
    }
  }
  const matches = (d: TokenDomain) =>
    d.chainId === request.chainId && same(d.address, request.currency);
  const domain =
    options.tokenDomains?.find(matches) ?? USDC_DOMAINS.find(matches);
  if (!domain) {
    problem(
      "verification-failed",
      "The currency is not a token this server accepts EIP-3009 authorizations for.",
    );
  }
  if (same(from, ZERO)) problem("verification-failed", "from is zero.");
  if (!same(to, request.recipient)) {
    problem("verification-failed", "to does not match the recipient.");
  }
  if (value !== request.amount) {
    problem("verification-failed", "value does not match the amount.");
  }
  if (!same(nonce, challengeNonce(challenge))) {
    problem(
      "verification-failed",
      "nonce is not keccak256(challenge.id ‖ challenge.realm).",
    );
  }
  const nowSeconds = BigInt(Math.floor(now / 1000));
  if (BigInt(validAfter as string) > nowSeconds) {
    problem("verification-failed", "The authorization is not valid yet.");
  }
  if (BigInt(validBefore as string) <= nowSeconds) {
    problem("payment-expired", "The authorization has expired.");
  }
  if (BigInt(validBefore as string) > BigInt(Math.floor(expiresAt / 1000))) {
    problem("verification-failed", "The authorization outlives the challenge.");
  }
  const authorization: SessionKeyTypedDataRequest = {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.address,
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: from as `0x${string}`,
      to: to as `0x${string}`,
      value: value as string,
      validAfter: validAfter as string,
      validBefore: validBefore as string,
      nonce: nonce as `0x${string}`,
    },
  };
  const signer = recoverTypedDataSigner(authorization, signature as string);
  if (!signer || !same(signer, from as string)) {
    problem("verification-failed", "The signature does not recover to from.");
  }
  if (
    source !== undefined &&
    !same(source, `did:pkh:eip155:${request.chainId}:${from}`)
  ) {
    problem("verification-failed", "source does not match from.");
  }
  const query = {
    chainId: request.chainId,
    token: domain.address,
  };
  const used = await options.rpc.authorizationState({
    ...query,
    authorizer: from as `0x${string}`,
    nonce: nonce as `0x${string}`,
  });
  if (used !== false) {
    problem("invalid-challenge", "This authorization was already used.");
  }
  const balance = await options.rpc.balanceOf({
    ...query,
    owner: from as `0x${string}`,
  });
  if (typeof balance !== "bigint" || balance < BigInt(request.amount)) {
    problem("verification-failed", "The payer's balance is insufficient.");
  }
  return {
    domain,
    authorization,
    signature: signature as `0x${string}`,
    payer: from as `0x${string}`,
  };
}

/** Submit a verified authorization; resolves to its transaction hash. */
export async function settleEvmAuthorization(
  verified: VerifiedEvmPayment,
  deps: MppEvmSettleDeps | undefined,
): Promise<`0x${string}`> {
  if (!deps?.submit) {
    throw new TypeError("settleCredential needs evm.submit for evm charges.");
  }
  const { authorization, signature } = verified;
  const m = authorization.message;
  const { transactionHash } = await deps.submit({
    chainId: authorization.domain.chainId,
    token: authorization.domain.verifyingContract,
    from: m.from,
    to: m.to,
    value: BigInt(m.value),
    validAfter: BigInt(m.validAfter),
    validBefore: BigInt(m.validBefore),
    nonce: m.nonce,
    signature,
    v: Number.parseInt(signature.slice(130, 132), 16),
    r: `0x${signature.slice(2, 66)}`,
    s: `0x${signature.slice(66, 130)}`,
  });
  if (typeof transactionHash !== "string" || !BYTES32.test(transactionHash)) {
    throw new TypeError("evm.submit did not return a transaction hash.");
  }
  return transactionHash.toLowerCase() as `0x${string}`;
}
