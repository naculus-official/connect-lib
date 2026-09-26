import {
  eip155Reference,
  type SessionKeyManager,
  type SessionKeyTypedDataRequest,
  sessionKeyAddress,
} from "@naculus/connect-core";
import { svmUnsupportedReason } from "./svm-exact";
import {
  X402_VERSION,
  X402Error,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402PaymentRequirements,
} from "./wire";

/**
 * The x402 `exact` scheme on EVM, EIP-3009 transfer method only
 * (`specs/schemes/exact/scheme_exact_evm.md`). The payer signs a
 * `TransferWithAuthorization`; the facilitator verifies and settles. Nothing
 * here broadcasts.
 *
 * Permit2, the scheme's fallback for tokens without EIP-3009, is refused: a
 * session key may sign exactly one kind of typed data, and the policy engine
 * cannot bound a Permit2 witness transfer.
 */

/** Signs a TransferWithAuthorization as the session key, under its policy. */
export interface X402TypedDataSigner {
  /** The session key's own address; the authorization's `from`. */
  address: `0x${string}`;
  signTypedData(request: SessionKeyTypedDataRequest): Promise<`0x${string}`>;
}

/**
 * A signer backed by a SessionKeyManager. Payee, amount, token and chain are
 * enforced there, not here: give the key `allowedRecipients`,
 * `tokenAllowances` and `allowedChainIds` that describe what it may pay.
 */
export async function sessionKeyX402Signer(
  manager: SessionKeyManager,
  sessionId: string,
): Promise<X402TypedDataSigner> {
  const info = (await manager.listSessions()).find((s) => s.id === sessionId);
  if (!info) {
    throw new X402Error("invalid_input", `Session key ${sessionId} not found.`);
  }
  return {
    address: sessionKeyAddress(info.publicKey),
    signTypedData: (request) =>
      manager.signTypedDataWithSessionKey(sessionId, request),
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
/** Tolerated clock skew between payer and facilitator, as validAfter slack. */
const VALID_AFTER_SLACK_SECONDS = 600;

/** Why a requirement is unusable by this client, or null when it is usable. */
export function unsupportedReason(
  requirement: X402PaymentRequirements,
): string | null {
  if (requirement.scheme !== "exact") {
    return `scheme ${requirement.scheme} is not supported`;
  }
  if (eip155Reference(requirement.network) === null) {
    return `network ${requirement.network} is not a single EIP-155 chain`;
  }
  const extra = requirement.extra ?? {};
  const method = extra.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") {
    return `asset transfer method ${String(method)} is not supported`;
  }
  if (typeof extra.name !== "string" || typeof extra.version !== "string") {
    return "extra.name and extra.version (the token's EIP-712 domain) are required";
  }
  if (!ADDRESS.test(requirement.asset)) return "asset is not a token address";
  if (!ADDRESS.test(requirement.payTo)) return "payTo is not an EVM address";
  if (
    !DECIMAL.test(requirement.amount) ||
    BigInt(requirement.amount) === 0n ||
    BigInt(requirement.amount) > UINT256_MAX
  ) {
    return "amount is not a positive uint256";
  }
  if (
    !Number.isSafeInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds <= 0
  ) {
    return "maxTimeoutSeconds is not a positive integer";
  }
  return null;
}

export interface SelectOptions {
  /** CAIP-2 chains this client will pay on. Omitted: any it can pay on. */
  networks?: readonly string[];
  /** Pay EIP-155 requirements (EIP-3009). Default true. */
  evm?: boolean;
  /** Pay Solana requirements (`svm-exact`). Default false. */
  solana?: boolean;
}

/** The first requirement, in the server's order, this client can pay. */
export function selectRequirement(
  required: X402PaymentRequired,
  options: SelectOptions = {},
): X402PaymentRequirements {
  const reasons: string[] = [];
  for (const requirement of required.accepts) {
    const reason = requirement.network.startsWith("solana:")
      ? options.solana
        ? svmUnsupportedReason(requirement)
        : "no Solana signer is configured"
      : (options.evm ?? true)
        ? unsupportedReason(requirement)
        : "no EVM signer is configured";
    if (reason) {
      reasons.push(reason);
      continue;
    }
    if (options.networks && !options.networks.includes(requirement.network)) {
      reasons.push(`network ${requirement.network} is not in the allowed list`);
      continue;
    }
    return requirement;
  }
  throw new X402Error(
    "no_acceptable_requirement",
    `No payable requirement: ${reasons.join("; ")}.`,
  );
}

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface AuthorizationOptions {
  /** Unix seconds; defaults to the current time. */
  now?: number;
  /** 32-byte hex; defaults to a random nonce. */
  nonce?: `0x${string}`;
}

/** The EIP-3009 typed data that pays `requirement` from `from`. */
export function buildTransferAuthorization(
  requirement: X402PaymentRequirements,
  from: `0x${string}`,
  options: AuthorizationOptions = {},
): SessionKeyTypedDataRequest {
  const reason = unsupportedReason(requirement);
  if (reason) throw new X402Error("no_acceptable_requirement", reason);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const extra = requirement.extra as { name: string; version: string };
  return {
    domain: {
      name: extra.name,
      version: extra.version,
      chainId: eip155Reference(requirement.network) as number,
      verifyingContract: requirement.asset as `0x${string}`,
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: requirement.payTo as `0x${string}`,
      value: requirement.amount,
      validAfter: String(Math.max(0, now - VALID_AFTER_SLACK_SECONDS)),
      validBefore: String(now + requirement.maxTimeoutSeconds),
      nonce: options.nonce ?? randomNonce(),
    },
  };
}

/**
 * Sign `requirement` and build the `PAYMENT-SIGNATURE` payload. The
 * requirement is echoed as `accepted`, and the challenge's extensions are
 * echoed unchanged, as the spec requires.
 */
export async function createPaymentPayload(
  required: X402PaymentRequired,
  requirement: X402PaymentRequirements,
  signer: X402TypedDataSigner,
  options: AuthorizationOptions = {},
): Promise<X402PaymentPayload> {
  const typedData = buildTransferAuthorization(
    requirement,
    signer.address,
    options,
  );
  const signature = await signer.signTypedData(typedData);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new X402Error(
      "invalid_input",
      "Signer did not return a 65-byte signature.",
    );
  }
  return {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted: requirement,
    payload: { signature, authorization: { ...typedData.message } },
    ...(required.extensions ? { extensions: required.extensions } : {}),
  };
}
