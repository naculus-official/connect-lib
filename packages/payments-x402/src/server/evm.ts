import {
  eip155Reference,
  recoverTypedDataSigner,
  type SessionKeyTypedDataRequest,
  validateTypedDataRequest,
} from "@naculus/connect-core";
import type { X402PaymentRequirements } from "../wire";
import { exactKeys, type Failure, failure, isRecord } from "./common";

/**
 * Facilitator side of x402 `exact` on EVM, EIP-3009 only
 * (`specs/schemes/exact/scheme_exact_evm.md`, coinbase/x402 at
 * dd927a26cfefc98c24b3ec38b3a8f204dad0c60d): check the signed
 * `TransferWithAuthorization` against the requirement and the chain, and
 * build the `transferWithAuthorization` call that settles it. Nothing here
 * holds a key or broadcasts; the caller's `submit` does.
 */

/** A read-only call (`eth_call` at the latest block). */
export interface X402EvmCall {
  chainId: number;
  to: `0x${string}`;
  data: `0x${string}`;
}

/**
 * The chain reads verification needs. `call` resolves to the call's return
 * data and rejects when the call reverts; route it by `chainId` to an RPC
 * that serves that chain.
 */
export interface X402EvmRpc {
  call(request: X402EvmCall): Promise<string>;
}

export interface EvmAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export interface VerifiedEvm {
  kind: "evm";
  chainId: number;
  asset: `0x${string}`;
  authorization: EvmAuthorization;
  signature: `0x${string}`;
}

const AUTHORIZATION_KEYS = [
  "from",
  "to",
  "value",
  "validAfter",
  "validBefore",
  "nonce",
] as const;
const WORD = /^0x[0-9a-fA-F]{64}$/;

// authorizationState(address,bytes32), balanceOf(address),
// transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
const AUTHORIZATION_STATE = "e94a0102";
const BALANCE_OF = "70a08231";
const TRANSFER_WITH_AUTHORIZATION = "e3ee160e";

function address(value: string): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function uint(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function readWord(value: unknown): bigint | null {
  return typeof value === "string" && WORD.test(value) ? BigInt(value) : null;
}

/** Calldata for `transferWithAuthorization(from, to, value, …, v, r, s)`. */
export function transferWithAuthorizationData(
  authorization: EvmAuthorization,
  signature: `0x${string}`,
): `0x${string}` {
  const r = signature.slice(2, 66);
  const s = signature.slice(66, 130);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return `0x${TRANSFER_WITH_AUTHORIZATION}${[
    address(authorization.from),
    address(authorization.to),
    uint(BigInt(authorization.value)),
    uint(BigInt(authorization.validAfter)),
    uint(BigInt(authorization.validBefore)),
    authorization.nonce.slice(2).toLowerCase(),
    uint(v),
    r.toLowerCase(),
    s.toLowerCase(),
  ].join("")}`;
}

/**
 * Verify an EVM `exact` payload against the requirement it names (already
 * matched against what the server offered).
 */
export async function verifyEvmPayload(
  payload: unknown,
  requirement: X402PaymentRequirements,
  rpc: X402EvmRpc | undefined,
  now: number,
): Promise<VerifiedEvm | Failure> {
  if (!isRecord(payload) || !exactKeys(payload, ["signature", "authorization"]))
    return failure(
      "invalid_payload",
      "payload is not {signature, authorization}.",
    );
  const { signature, authorization } = payload;
  if (
    !isRecord(authorization) ||
    !exactKeys(authorization, AUTHORIZATION_KEYS) ||
    AUTHORIZATION_KEYS.some((k) => typeof authorization[k] !== "string")
  ) {
    return failure(
      "invalid_payload",
      "authorization must hold exactly from, to, value, validAfter, validBefore and nonce as strings.",
    );
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
    return failure(
      "invalid_exact_evm_payload_signature",
      "signature is not 65 bytes of hex.",
    );
  const chainId = eip155Reference(requirement.network);
  const extra = requirement.extra ?? {};
  if (
    chainId === null ||
    typeof extra.name !== "string" ||
    typeof extra.version !== "string"
  ) {
    return failure(
      "invalid_payment_requirements",
      "The requirement has no EIP-155 chain or token domain.",
    );
  }
  const auth = { ...authorization } as unknown as EvmAuthorization;
  const request: SessionKeyTypedDataRequest = {
    domain: {
      name: extra.name,
      version: extra.version,
      chainId,
      verifyingContract: requirement.asset as `0x${string}`,
    },
    primaryType: "TransferWithAuthorization",
    message: auth,
  };
  const invalid = validateTypedDataRequest(request);
  if (invalid) return failure("invalid_payload", invalid);

  if (auth.to.toLowerCase() !== requirement.payTo.toLowerCase()) {
    return failure(
      "invalid_exact_evm_payload_recipient_mismatch",
      "authorization.to is not the requirement's payTo.",
    );
  }
  if (BigInt(auth.value) !== BigInt(requirement.amount)) {
    return failure(
      "invalid_exact_evm_payload_authorization_value_mismatch",
      "authorization.value is not the requirement's amount.",
    );
  }
  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  const at = BigInt(now);
  if (validAfter > at) {
    return failure(
      "invalid_exact_evm_payload_authorization_valid_after",
      "The authorization is not valid yet.",
    );
  }
  if (validBefore <= at) {
    return failure(
      "invalid_exact_evm_payload_authorization_valid_before",
      "The authorization has expired.",
    );
  }
  if (validBefore - at > BigInt(requirement.maxTimeoutSeconds)) {
    return failure(
      "invalid_exact_evm_payload_authorization_valid_before",
      "The authorization outlives the requirement's maxTimeoutSeconds.",
    );
  }
  const signer = recoverTypedDataSigner(request, signature);
  if (!signer || signer.toLowerCase() !== auth.from.toLowerCase()) {
    return failure(
      "invalid_exact_evm_payload_signature",
      "The signature does not recover to authorization.from.",
    );
  }

  if (!rpc) {
    return failure("invalid_network", "No EVM RPC is configured.");
  }
  const token = requirement.asset as `0x${string}`;
  const verified: VerifiedEvm = {
    kind: "evm",
    chainId,
    asset: token,
    authorization: auth,
    signature: signature as `0x${string}`,
  };
  let used: bigint | null;
  let balance: bigint | null;
  try {
    [used, balance] = await Promise.all([
      rpc
        .call({
          chainId,
          to: token,
          data: `0x${AUTHORIZATION_STATE}${address(auth.from)}${auth.nonce.slice(2).toLowerCase()}`,
        })
        .then(readWord),
      rpc
        .call({
          chainId,
          to: token,
          data: `0x${BALANCE_OF}${address(auth.from)}`,
        })
        .then(readWord),
    ]);
  } catch {
    return failure("unexpected_verify_error", "The token could not be read.");
  }
  if (used === null || used > 1n || balance === null) {
    return failure(
      "unexpected_verify_error",
      "The token answered authorizationState or balanceOf with something other than one word.",
    );
  }
  if (used !== 0n) {
    return failure(
      "invalid_transaction_state",
      "The authorization's nonce has already been used.",
    );
  }
  if (balance < BigInt(auth.value)) {
    return failure("insufficient_funds", "The payer's balance is too low.");
  }
  try {
    await rpc.call({
      chainId,
      to: token,
      data: transferWithAuthorizationData(auth, verified.signature),
    });
  } catch {
    return failure(
      "invalid_transaction_state",
      "transferWithAuthorization does not succeed in simulation.",
    );
  }
  return verified;
}
