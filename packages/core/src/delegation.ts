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
