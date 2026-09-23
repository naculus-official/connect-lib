/**
 * EIP-7702 delegation, read from account code.
 *
 * A delegated EOA has exactly 23 bytes of code: the three-byte prefix
 * `0xef0100` followed by the 20-byte address it delegates to. That prefix is
 * fixed by the spec — it reuses the EIP-3541 reserved `0xef` opcode space
 * precisely so a delegation cannot be confused with deployed contract code.
 *
 * Reading it answers a question nothing else here could: whether an ordinary
 * address is currently able to execute like a contract account.
 */

import { eip155Reference, isEvmAddress } from "./caip";
import { WalletError } from "./errors";

/** `0xef0100`, the delegation designator EIP-7702 fixes. */
export const DELEGATION_PREFIX = "0xef0100";

/** 3 prefix bytes + 20 address bytes. */
const DELEGATION_CODE_LENGTH = 2 + 46;

export interface DelegationStatus {
  /**
   * Whether this account currently delegates.
   *
   * `null` means the code was never read — a different fact from an account
   * with no code, and the one a caller must not treat as "no".
   */
  delegated: boolean | null;
  /** The address executing on this account's behalf, when delegated. */
  delegate: `0x${string}` | null;
}

export const UNKNOWN_DELEGATION: DelegationStatus = {
  delegated: null,
  delegate: null,
};

/**
 * Read a delegation out of `eth_getCode` output.
 *
 * Returns "not delegated" only for code that was actually read. Anything that
 * is not a hex string is unknown, because a caller cannot distinguish a failed
 * RPC from an empty account otherwise — and treating a failure as "no
 * delegation" is how an account that can batch gets sent down the path for one
 * that cannot.
 */
export function readDelegation(code: unknown): DelegationStatus {
  if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(code)) {
    return UNKNOWN_DELEGATION;
  }
  // `0x` is a real answer: this account has no code and does not delegate.
  if (code.length !== DELEGATION_CODE_LENGTH) {
    return { delegated: false, delegate: null };
  }
  if (!code.toLowerCase().startsWith(DELEGATION_PREFIX)) {
    // 23 bytes of ordinary code is not a delegation. Contracts that short are
    // vanishingly rare but nothing rules them out.
    return { delegated: false, delegate: null };
  }
  const delegate = `0x${code.slice(DELEGATION_PREFIX.length)}` as const;
  // The spec allows delegating to the zero address to clear a delegation, and
  // the result is an account that no longer delegates to anything.
  if (/^0x0{40}$/.test(delegate)) {
    return { delegated: false, delegate: null };
  }
  return { delegated: true, delegate: delegate as `0x${string}` };
}

// ── Producing a delegation (owner path) ──────────────────────────────

/** `address(0)`: delegating to it clears the account's delegation. */
export const REVOKE_DELEGATE = "0x0000000000000000000000000000000000000000";

/**
 * An EIP-7702 authorization to be signed by the account itself.
 *
 * `chainId` is CAIP-2 and always names one chain: the any-chain form
 * (`eip155:0`) is not representable here, because one signature would then
 * delegate the account on every chain it exists on.
 */
export interface DelegationAuthorizationRequest {
  /**
   * The account whose nonce this carries and who must sign it. A connector
   * whose key belongs to any other address refuses the request.
   */
  account: `0x${string}`;
  chainId: string;
  address: `0x${string}`;
  /** The account's nonce at inclusion, as a canonical hex quantity. */
  nonce: `0x${string}`;
}

export interface SignedDelegationAuthorization
  extends DelegationAuthorizationRequest {
  yParity: 0 | 1;
  r: `0x${string}`;
  s: `0x${string}`;
}

export interface PrepareDelegationInput {
  /** The EOA that will delegate. */
  account: `0x${string}`;
  /** CAIP-2 EIP-155 chain. */
  chainId: string;
  /** Implementation to delegate to, or `REVOKE_DELEGATE` to clear. */
  delegate: `0x${string}`;
  /**
   * Implementations this app trusts to run with full control of the account.
   * Explicit and empty by default: which contract an EOA runs is the
   * security decision here, and Naculus ships no default.
   */
  allowlist: readonly string[];
  /**
   * Who sends the type-4 transaction. When the account sends it itself, the
   * transaction consumes the current nonce first, so the authorization must
   * carry nonce + 1 — the most common EIP-7702 integration bug, and the reason
   * the nonce is computed here rather than accepted from the caller.
   */
  sender: "self" | "relayer";
  /** `eth_getTransactionCount(account, "pending")` on `chainId`. */
  getTransactionCount: (
    account: `0x${string}`,
    blockTag: "pending",
  ) => Promise<unknown>;
}

/** What `prepareDelegationAuthorization` returns. */
export interface PreparedDelegationAuthorization
  extends DelegationAuthorizationRequest {
  /**
   * For `sender: "self"`: the nonce the type-4 transaction itself must use,
   * read in the same call as the authorization's, so the pair is consistent.
   */
  transactionNonce?: `0x${string}`;
}

/**
 * Build the authorization an account signs to delegate (or revoke).
 *
 * Refuses a delegate outside the allowlist; `REVOKE_DELEGATE` is always
 * allowed so an account can get out of any delegation. Fails closed when the
 * nonce cannot be read as a non-negative integer.
 */
export async function prepareDelegationAuthorization(
  input: PrepareDelegationInput,
): Promise<PreparedDelegationAuthorization> {
  const { account, chainId, delegate, allowlist, sender } = input;
  if (eip155Reference(chainId) === null) {
    throw new WalletError(
      "invalid_chain",
      `EIP-7702 authorization needs a single EIP-155 chain, got ${chainId}.`,
    );
  }
  if (!isEvmAddress(account) || !isEvmAddress(delegate)) {
    throw new WalletError(
      "invalid_input",
      "Account and delegate must be 20-byte EVM addresses.",
    );
  }
  if (sender !== "self" && sender !== "relayer") {
    throw new WalletError("invalid_input", "sender must be self or relayer.");
  }
  const target = delegate.toLowerCase();
  const allowed =
    target === REVOKE_DELEGATE ||
    allowlist.some(
      (entry) => isEvmAddress(entry) && entry.toLowerCase() === target,
    );
  if (!allowed) {
    throw new WalletError(
      "method_not_allowed",
      `Delegate ${delegate} is not in this app's EIP-7702 allowlist.`,
    );
  }

  let raw: unknown;
  try {
    raw = await input.getTransactionCount(account, "pending");
  } catch (cause) {
    throw new WalletError(
      "rpc_error",
      "Could not read the account nonce; refusing to guess it.",
      cause,
    );
  }
  const count = parseNonce(raw);
  if (count === null) {
    throw new WalletError(
      "rpc_error",
      "Could not read the account nonce; refusing to guess it.",
    );
  }
  const nonce = sender === "self" ? count + 1n : count;
  if (nonce >= MAX_AUTHORIZATION_NONCE) {
    throw new WalletError(
      "invalid_input",
      "Account nonce is out of range for EIP-7702.",
    );
  }
  return {
    account,
    chainId,
    address: delegate,
    nonce: `0x${nonce.toString(16)}`,
    ...(sender === "self"
      ? { transactionNonce: `0x${count.toString(16)}` as const }
      : {}),
  };
}

/** EIP-7702: an authorization nonce must be below 2^64 - 1. */
const MAX_AUTHORIZATION_NONCE = 2n ** 64n - 1n;

function parseNonce(value: unknown): bigint | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "bigint" && value >= 0n) return value;
  return null;
}
