/**
 * MetaMask Delegation Framework v1.3.0: the on-chain side of an `eip7702`
 * session key (docs/design/eip7702-session-delegation.md).
 *
 * The owner's EOA is delegated (EIP-7702) to `EIP7702StatelessDeleGatorImpl`.
 * The owner signs an EIP-712 `Delegation` naming the session key as delegate,
 * with caveats that encode the session scope; the session key redeems it
 * through `DelegationManager`, whose enforcers check every execution on chain.
 *
 * This module only builds and hashes delegations. It signs nothing, and it
 * refuses a scope it cannot express on chain rather than approximating it —
 * a delegation that is looser than the policy it came from is the failure
 * this code exists to prevent.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createSessionKeyError } from "./errors";
import { DEFAULT_SESSION_KEY_CONFIG, type SessionKeyScope } from "./types";

/**
 * v1.3.0 deployments (github.com/MetaMask/delegation-framework,
 * `documents/Deployments.md`). Deterministic: the same addresses on every
 * supported chain. On 2026-09-25 eth_getCode on every chain in
 * `DELEGATION_FRAMEWORK_CHAIN_IDS` found DelegationManager,
 * EIP7702StatelessDeleGatorImpl, TimestampEnforcer and
 * ERC20TransferAmountEnforcer with identical code sizes; the other enforcers
 * are from the same deterministic deployment (a missing one fails closed: a
 * call to an address without code reverts the redemption).
 */
export const DELEGATION_FRAMEWORK = {
  version: "1.3.0",
  delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  eip7702StatelessDeleGator: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
  enforcers: {
    allowedCalldata: "0xc2b0d624c1c4319760C96503BA27C347F3260f55",
    allowedMethods: "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5",
    allowedTargets: "0x7F20f61b1f09b08D970938F6fa563634d65c4EeB",
    erc20TransferAmount: "0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc",
    limitedCalls: "0x04658B29F6b82ed55274221a06Fc97D318E25416",
    nativeTokenTransferAmount: "0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320",
    redeemer: "0xE144b0b2618071B4E56f746313528a669c7E65c5",
    timestamp: "0x1046bb45C8d673d4ea75321280DB34899413c069",
    valueLte: "0x92Bf12322527cAA612fd31a0e810472BBB106A8F",
  },
} as const;

/**
 * Chains the user chose (2026-09-25): Ethereum, Sepolia, Base, Base Sepolia,
 * Arbitrum One, Optimism, Polygon.
 */
export const DELEGATION_FRAMEWORK_CHAIN_IDS: readonly number[] = [
  1, 11155111, 8453, 84532, 42161, 10, 137,
];

/** A delegation that is not re-delegated: the owner's own authority. */
export const ROOT_AUTHORITY =
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const;
/** "Any redeemer" — never produced here. */
export const ANY_DELEGATE =
  "0x0000000000000000000000000000000000000a11" as const;

const TRANSFER_SELECTOR = "0xa9059cbb";

/**
 * Selectors refused in this mode on top of the manager's forbidden list:
 * called by the owner's account, they grant or withdraw beyond any caveat —
 * Permit2 `approve(address,address,uint160,uint48)` (a spender allowance over
 * tokens already approved to Permit2) and EntryPoint `withdrawTo(address,
 * uint256)` (the account's deposit). Review, 2026-09-25.
 */
const DELEGATION_FORBIDDEN_SELECTORS = ["0x87517c45", "0x205c2878"];

export interface FrameworkCaveat {
  enforcer: `0x${string}`;
  terms: `0x${string}`;
  /** Redemption-time arguments; not part of the signed hash. */
  args: `0x${string}`;
}

export interface FrameworkDelegation {
  /**
   * The chain the scope was checked for. Not part of the signed struct; the
   * digest and typed data are only produced for this chain.
   */
  chainId: number;
  delegate: `0x${string}`;
  delegator: `0x${string}`;
  authority: `0x${string}`;
  caveats: FrameworkCaveat[];
  salt: bigint;
  /** The delegator's EIP-712 signature; `0x` until signed. */
  signature: `0x${string}`;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR = /^0x[0-9a-fA-F]{8}$/;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function refuse(reason: string): never {
  throw createSessionKeyError(
    "session_key_invalid_input",
    `Cannot express this scope as an EIP-7702 delegation: ${reason}`,
  );
}

function word(value: bigint): string {
  if (typeof value !== "bigint" || value < 0n || value > UINT256_MAX) {
    refuse("a value is not a uint256 bigint");
  }
  return value.toString(16).padStart(64, "0");
}

function address20(value: string, what: string): string {
  if (!ADDRESS.test(value)) refuse(`${what} is not an EVM address`);
  return value.slice(2).toLowerCase();
}

function caveat(enforcer: `0x${string}`, termsHex: string): FrameworkCaveat {
  return { enforcer, terms: `0x${termsHex}`, args: "0x" };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The caveats that enforce `scope` on chain, or a refusal.
 *
 * Mapping (v1.3.0 enforcers):
 * - `expiry` → TimestampEnforcer, valid strictly before `expiry`
 * - `maxTxCount` → LimitedCallsEnforcer
 * - `allowedContracts` → AllowedTargetsEnforcer (required)
 * - `allowedMethods` → AllowedMethodsEnforcer (required: the chain has no
 *   deny-list to stand in for the forbidden selectors, and none of those may
 *   be allowed)
 * - `maxValuePerTx` → ValueLteEnforcer; `maxTotalValue` →
 *   NativeTokenTransferAmountEnforcer
 * - one `tokenAllowances` entry → ERC20TransferAmountEnforcer, which makes
 *   every execution a `transfer` on that token; the scope must say so
 *   (targets = [token], methods = [transfer]) and native value is fixed at 0
 * - one `allowedRecipients` entry (token scopes only) → AllowedCalldataEnforcer
 *   on the `transfer` recipient word
 * - `allowedChainIds` → the delegation's EIP-712 domain; must contain `chainId`
 * - always RedeemerEnforcer = [session key]: no re-delegated redeemer
 * - `maxGasPerTx` / `maxTotalGas` have no enforcer and stay off-chain checks:
 *   the session key pays its own gas.
 */
export interface CaveatOptions {
  /**
   * The owner's account. Refused as a target: a call to the account's own
   * `execute` runs inner calls no caveat sees. Required so no path skips it.
   */
  delegator: `0x${string}`;
  /**
   * The session key. Pinned as the only redeemer (RedeemerEnforcer): the key
   * is an EOA, and DelegationManager accepts a re-delegation it signs, so
   * without this a signature over an unbound digest could hand the whole
   * caveat budget to another redeemer, beyond revokeSession (review,
   * 2026-09-25).
   */
  delegate: `0x${string}`;
  /**
   * Selectors that must never be allowed; defaults to the manager's
   * built-in list. Pass the manager's configured list when it differs.
   */
  forbiddenMethods?: readonly string[];
}

export function caveatsFromScope(
  scope: SessionKeyScope,
  chainId: number,
  options: CaveatOptions,
): FrameworkCaveat[] {
  const e = DELEGATION_FRAMEWORK.enforcers;
  const forbidden = [
    ...(options.forbiddenMethods ??
      DEFAULT_SESSION_KEY_CONFIG.forbiddenMethods),
    ...DELEGATION_FORBIDDEN_SELECTORS,
  ].map((m) => m.toLowerCase());
  if (!options?.delegator || !ADDRESS.test(options.delegator)) {
    refuse("the delegator is required");
  }
  if (!options.delegate || !ADDRESS.test(options.delegate)) {
    refuse("the delegate is required");
  }
  if (scope.mode !== "eip7702") refuse(`mode is ${String(scope.mode)}`);
  if (!DELEGATION_FRAMEWORK_CHAIN_IDS.includes(chainId)) {
    refuse(`chain ${chainId} is not a supported delegation-framework chain`);
  }
  if (
    scope.allowedChainIds?.length &&
    !scope.allowedChainIds.includes(chainId)
  ) {
    refuse(`chain ${chainId} is not in allowedChainIds`);
  }
  if (
    !Number.isSafeInteger(scope.expiry) ||
    scope.expiry <= 0 ||
    BigInt(scope.expiry) > UINT128_MAX
  ) {
    refuse("expiry must be a positive Unix time");
  }

  const targets = scope.allowedContracts ?? [];
  if (targets.length === 0) refuse("allowedContracts is required");
  for (const target of targets) {
    // Calling the owner's account (its own execute) or the DelegationManager
    // (enableDelegation) from a redemption escapes every caveat: the
    // enforcers only see the outer call (independent review, 2026-09-25).
    if (sameAddress(target, DELEGATION_FRAMEWORK.delegationManager)) {
      refuse("the DelegationManager cannot be an allowed contract");
    }
    if (sameAddress(target, options.delegator)) {
      refuse("the owner's own account cannot be an allowed contract");
    }
  }
  const methods = (scope.allowedMethods ?? []).map((m) => m.toLowerCase());
  if (methods.length === 0) {
    refuse("allowedMethods is required: there is no on-chain deny-list");
  }
  for (const method of methods) {
    if (!SELECTOR.test(method)) refuse(`${method} is not a 4-byte selector`);
    if (forbidden.includes(method)) {
      refuse(`${method} is a forbidden selector`);
    }
  }

  const tokens = Object.entries(scope.tokenAllowances ?? {});
  if (tokens.length > 1) refuse("more than one token allowance");
  const recipients = scope.allowedRecipients ?? [];
  if (recipients.length > 1) refuse("more than one recipient");
  if (recipients.length === 1 && tokens.length === 0) {
    refuse("allowedRecipients needs a single token allowance");
  }

  const caveats: FrameworkCaveat[] = [
    caveat(
      e.timestamp,
      `${"0".repeat(32)}${BigInt(scope.expiry).toString(16).padStart(32, "0")}`,
    ),
    caveat(
      e.allowedTargets,
      targets.map((t) => address20(t, "an allowed contract")).join(""),
    ),
    caveat(e.allowedMethods, methods.map((m) => m.slice(2)).join("")),
  ];

  if (tokens.length === 1) {
    const [token, max] = tokens[0] as [string, bigint];
    if (targets.length !== 1 || !sameAddress(targets[0] as string, token)) {
      refuse(
        "a token allowance allows transfers on that token only; allowedContracts must be exactly [token]",
      );
    }
    if (methods.length !== 1 || methods[0] !== TRANSFER_SELECTOR) {
      refuse(
        "a token allowance allows transfer() only; allowedMethods must be exactly [0xa9059cbb]",
      );
    }
    if (typeof max !== "bigint" || max <= 0n) {
      refuse("the token allowance must be positive");
    }
    caveats.push(
      caveat(
        e.erc20TransferAmount,
        `${address20(token, "the token")}${word(max)}`,
      ),
    );
    caveats.push(caveat(e.valueLte, word(0n)));
    if (recipients.length === 1) {
      caveats.push(
        caveat(
          e.allowedCalldata,
          `${word(4n)}${address20(recipients[0] as string, "the recipient").padStart(64, "0")}`,
        ),
      );
    }
  } else {
    if (
      scope.maxValuePerTx === undefined &&
      scope.maxTotalValue === undefined
    ) {
      refuse(
        "a native value limit (maxValuePerTx or maxTotalValue) is required",
      );
    }
    if (scope.maxValuePerTx !== undefined) {
      caveats.push(caveat(e.valueLte, word(scope.maxValuePerTx)));
    }
    if (scope.maxTotalValue !== undefined) {
      caveats.push(
        caveat(e.nativeTokenTransferAmount, word(scope.maxTotalValue)),
      );
    }
  }

  if (scope.maxTxCount !== undefined) {
    if (!Number.isSafeInteger(scope.maxTxCount) || scope.maxTxCount <= 0) {
      refuse("maxTxCount must be a positive integer");
    }
    caveats.push(caveat(e.limitedCalls, word(BigInt(scope.maxTxCount))));
  }
  caveats.push(caveat(e.redeemer, address20(options.delegate, "the delegate")));
  return caveats;
}

export interface BuildDelegationInput {
  /** The owner's EOA, delegated to EIP7702StatelessDeleGatorImpl. */
  delegator: `0x${string}`;
  /** The session key's address. */
  delegate: `0x${string}`;
  scope: SessionKeyScope;
  chainId: number;
  /** Distinguishes otherwise identical delegations; random by default. */
  salt?: bigint;
  /** See CaveatOptions.forbiddenMethods. */
  forbiddenMethods?: readonly string[];
}

/** An unsigned root delegation from the owner to the session key. */
export function buildDelegation(
  input: BuildDelegationInput,
): FrameworkDelegation {
  const delegator =
    `0x${address20(input.delegator, "the delegator")}` as `0x${string}`;
  const delegate =
    `0x${address20(input.delegate, "the delegate")}` as `0x${string}`;
  if (sameAddress(delegate, ANY_DELEGATE) || /^0x0{40}$/.test(delegate)) {
    refuse("the delegate must be the session key, never an open delegation");
  }
  if (sameAddress(delegate, delegator)) refuse("the delegate is the delegator");
  let salt = input.salt;
  if (salt === undefined) {
    salt = BigInt(
      `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`,
    );
  }
  if (typeof salt !== "bigint" || salt < 0n || salt > UINT256_MAX) {
    refuse("salt is not a uint256 bigint");
  }
  // Frozen: chainId is not signed, so a delegation must not be relabelled
  // for a chain its scope was not checked against.
  const caveats = caveatsFromScope(input.scope, input.chainId, {
    delegator,
    delegate,
    forbiddenMethods: input.forbiddenMethods,
  }).map((c) => Object.freeze(c));
  return Object.freeze({
    chainId: input.chainId,
    delegate,
    delegator,
    authority: ROOT_AUTHORITY,
    caveats: Object.freeze(caveats) as unknown as FrameworkCaveat[],
    salt,
    signature: "0x",
  }) as FrameworkDelegation;
}

// ── EIP-712 ─────────────────────────────────────────────────────────

const utf8 = (s: string) => new TextEncoder().encode(s);
const DELEGATION_TYPEHASH = keccak_256(
  utf8(
    "Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)",
  ),
);
const CAVEAT_TYPEHASH = keccak_256(
  utf8("Caveat(address enforcer,bytes terms)"),
);
const DOMAIN_TYPEHASH = keccak_256(
  utf8(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);

function bytesOf(hex: string): Uint8Array {
  return hexToBytes(hex.slice(2));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
const w = (value: bigint) => bytesOf(`0x${word(value)}`);
const a = (address: string) =>
  bytesOf(`0x${address20(address, "an address").padStart(64, "0")}`);

/** keccak256 of the Delegation struct, as the framework's EncoderLib computes it. */
export function delegationHash(delegation: FrameworkDelegation): `0x${string}` {
  const caveatHashes = delegation.caveats.map((c) =>
    keccak_256(
      concat(CAVEAT_TYPEHASH, a(c.enforcer), keccak_256(bytesOf(c.terms))),
    ),
  );
  return `0x${bytesToHex(
    keccak_256(
      concat(
        DELEGATION_TYPEHASH,
        a(delegation.delegate),
        a(delegation.delegator),
        bytesOf(delegation.authority),
        keccak_256(concat(...caveatHashes)),
        w(delegation.salt),
      ),
    ),
  )}`;
}

/**
 * The chain a delegation may be signed for: the one its scope was checked
 * against, and a supported one.
 */
function signingChain(delegation: FrameworkDelegation): number {
  const { chainId } = delegation;
  if (!DELEGATION_FRAMEWORK_CHAIN_IDS.includes(chainId)) {
    refuse(`chain ${chainId} is not a supported delegation-framework chain`);
  }
  return chainId;
}

/** The EIP-712 digest the delegator signs, on the delegation's own chain. */
export function delegationSigningDigest(
  delegation: FrameworkDelegation,
): `0x${string}` {
  const chainId = signingChain(delegation);
  const domain = keccak_256(
    concat(
      DOMAIN_TYPEHASH,
      keccak_256(utf8("DelegationManager")),
      keccak_256(utf8("1")),
      w(BigInt(chainId)),
      a(DELEGATION_FRAMEWORK.delegationManager),
    ),
  );
  return `0x${bytesToHex(
    keccak_256(
      concat(
        new Uint8Array([0x19, 0x01]),
        domain,
        bytesOf(delegationHash(delegation)),
      ),
    ),
  )}`;
}

/** EIP-712 typed data for a wallet's `eth_signTypedData_v4`. */
export function delegationTypedData(delegation: FrameworkDelegation) {
  const chainId = signingChain(delegation);
  return {
    domain: {
      name: "DelegationManager",
      version: "1",
      chainId,
      verifyingContract: DELEGATION_FRAMEWORK.delegationManager,
    },
    types: {
      Delegation: [
        { name: "delegate", type: "address" },
        { name: "delegator", type: "address" },
        { name: "authority", type: "bytes32" },
        { name: "caveats", type: "Caveat[]" },
        { name: "salt", type: "uint256" },
      ],
      Caveat: [
        { name: "enforcer", type: "address" },
        { name: "terms", type: "bytes" },
      ],
    },
    primaryType: "Delegation" as const,
    message: {
      delegate: delegation.delegate,
      delegator: delegation.delegator,
      authority: delegation.authority,
      caveats: delegation.caveats.map(({ enforcer, terms }) => ({
        enforcer,
        terms,
      })),
      salt: delegation.salt.toString(),
    },
  };
}

// ── Redemption encoding (ABI) ───────────────────────────────────────

/** ERC-7579 ModeCode for one call, default execution: all zero. */
export const SINGLE_DEFAULT_MODE = `0x${"0".repeat(64)}` as const;

/** `redeemDelegations(bytes[],bytes32[],bytes[])` */
const REDEEM_SELECTOR = bytesToHex(
  keccak_256(utf8("redeemDelegations(bytes[],bytes32[],bytes[])")).slice(0, 4),
);

export interface FrameworkExecution {
  target: `0x${string}`;
  /** Wei, as a bigint. */
  value: bigint;
  callData: `0x${string}`;
}

function padRight(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
  out.set(bytes);
  return out;
}

/** ABI `bytes`: length word, then the data right-padded to 32 bytes. */
function abiBytes(hex: string): Uint8Array {
  const data = bytesOf(hex);
  return concat(w(BigInt(data.length)), padRight(data));
}

/**
 * Head/tail encoding of a tuple (or of a parameter list) whose members are
 * either static 32-byte words or already-encoded dynamic values.
 */
function abiTuple(
  members: Array<{ word: Uint8Array } | { dynamic: Uint8Array }>,
): Uint8Array {
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let offset = BigInt(members.length * 32);
  for (const member of members) {
    if ("word" in member) {
      heads.push(member.word);
    } else {
      heads.push(w(offset));
      tails.push(member.dynamic);
      offset += BigInt(member.dynamic.length);
    }
  }
  return concat(...heads, ...tails);
}

/** ABI array of dynamic elements: length, offsets, elements. */
function abiDynamicArray(elements: Uint8Array[]): Uint8Array {
  return concat(
    w(BigInt(elements.length)),
    abiTuple(elements.map((dynamic) => ({ dynamic }))),
  );
}

function encodeDelegationTuple(d: FrameworkDelegation): Uint8Array {
  const caveats = abiDynamicArray(
    d.caveats.map((c) =>
      abiTuple([
        { word: a(c.enforcer) },
        { dynamic: abiBytes(c.terms) },
        { dynamic: abiBytes(c.args) },
      ]),
    ),
  );
  return abiTuple([
    { word: a(d.delegate) },
    { word: a(d.delegator) },
    { word: bytesOf(d.authority) },
    { dynamic: caveats },
    { word: w(d.salt) },
    { dynamic: abiBytes(d.signature) },
  ]);
}

/**
 * `abi.encode(Delegation[])` — the permission context DelegationManager
 * decodes, leaf first (a single root delegation here).
 */
export function encodePermissionContext(
  delegations: readonly FrameworkDelegation[],
): `0x${string}` {
  return `0x${bytesToHex(
    abiTuple([
      { dynamic: abiDynamicArray(delegations.map(encodeDelegationTuple)) },
    ]),
  )}`;
}

/** ERC-7579 single-call execution: `abi.encodePacked(target, value, callData)`. */
export function encodeSingleExecution(
  execution: FrameworkExecution,
): `0x${string}` {
  address20(execution.target, "the execution target");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(execution.callData)) {
    refuse("the execution callData is not hex bytes");
  }
  return `0x${execution.target.slice(2).toLowerCase()}${word(execution.value)}${execution.callData.slice(2).toLowerCase()}`;
}

/**
 * Calldata for `DelegationManager.redeemDelegations` redeeming one signed
 * delegation for one single-call execution.
 */
export function encodeRedeemDelegations(
  delegation: FrameworkDelegation,
  execution: FrameworkExecution,
): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{130}$/.test(delegation.signature)) {
    refuse("the delegation is not signed");
  }
  return encodeRedeemDelegationsWithContext(
    encodePermissionContext([delegation]),
    encodeSingleExecution(execution),
  );
}

/** As encodeRedeemDelegations, from an encoded context and execution. */
export function encodeRedeemDelegationsWithContext(
  permissionContext: `0x${string}`,
  executionCallData: `0x${string}`,
): `0x${string}` {
  const bytesArray = (hex: `0x${string}`) => abiDynamicArray([abiBytes(hex)]);
  return `0x${REDEEM_SELECTOR}${bytesToHex(
    abiTuple([
      { dynamic: bytesArray(permissionContext) },
      { dynamic: concat(w(1n), bytesOf(SINGLE_DEFAULT_MODE)) },
      { dynamic: bytesArray(executionCallData) },
    ]),
  )}`;
}
