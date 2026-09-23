/**
 * EVM transaction and EIP-7702 authorization encoding, split into the two
 * halves around a signature: the digest to sign, and the raw transaction
 * assembled from that digest's signature.
 *
 * Shared by EVMSigner and the crypto worker. Before this module each carried
 * its own copy of the legacy and type-2 encoders — the same drift the RLP
 * helpers suffered (see rlp.ts) — and type 4 would have been a third pair.
 * Keeping hash and assemble apart also lets a signer that holds the key
 * somewhere else (a session-key policy engine, a worker) sign exactly the
 * digest this module produced and hand back only the signature.
 *
 * No key material here and no imports that would pull connect-core into the
 * worker bundle: validation failures are TransactionInputError, which
 * EVMSigner maps to WalletError("invalid_input").
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { encodeRlpList, toRlpBytes, toRlpQuantity } from "./rlp";
import type {
  Eip7702AuthorizationOptions,
  Eip7702AuthorizationRequest,
  SignedEip7702Authorization,
  TransactionRequest,
} from "./types";

export class TransactionInputError extends Error {
  override name = "TransactionInputError";
}

/** r, s and y-parity of a secp256k1 signature, as a transaction carries them. */
export interface TransactionSignature {
  r: `0x${string}`;
  s: `0x${string}`;
  yParity: 0 | 1;
}

const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** EIP-7702: an authorization nonce must be below 2^64 - 1. */
const MAX_AUTHORIZATION_NONCE = 2n ** 64n - 1n;
/** EIP-7702 SET_CODE_TX_TYPE and MAGIC. */
const SET_CODE_TX_TYPE = 0x04;
const AUTHORIZATION_MAGIC = 0x05;
const EIP1559_TX_TYPE = 0x02;
const EMPTY_ACCESS_LIST = new Uint8Array([0xc0]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CANONICAL_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

type TxKind = "legacy" | "eip1559" | "eip7702";

interface NormalizedTransaction {
  kind: TxKind;
  chainId: bigint;
  req: TransactionRequest;
}

function fail(message: string): never {
  throw new TransactionInputError(message);
}

function hex(value: bigint | number): string {
  return `0x${value.toString(16)}`;
}

/**
 * Read each field exactly once into a plain object.
 *
 * Validation, hashing and the returned value each read the request, so an
 * object whose getters answer differently on later reads could pass a check
 * with one value and be signed with another (review finding: a `chainId`
 * getter returning 1 then 0 bypassed the any-chain refusal). Every entry point
 * works on a copy made here; the worker gets one from structured clone anyway.
 */
export function snapshotAuthorization<T extends Eip7702AuthorizationRequest>(
  auth: T,
): T {
  if (!auth || typeof auth !== "object") fail("Authorization is required.");
  const { chainId, address, nonce } = auth;
  if (!("yParity" in auth)) return { chainId, address, nonce } as T;
  const { yParity, r, s } = auth as unknown as SignedEip7702Authorization;
  return { chainId, address, nonce, yParity, r, s } as unknown as T;
}

export function snapshotTransaction(
  req: TransactionRequest,
): TransactionRequest {
  if (!req || typeof req !== "object") fail("Transaction is required.");
  const {
    to,
    from,
    value,
    data,
    gas,
    nonce,
    chainId,
    gasPrice,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type,
    authorizationList,
  } = req;
  return {
    to,
    from,
    value,
    data,
    gas,
    nonce,
    chainId,
    gasPrice,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type,
    authorizationList: Array.isArray(authorizationList)
      ? authorizationList.map((auth) => snapshotAuthorization(auth))
      : authorizationList,
  };
}

/**
 * Validate a transaction request and decide its type. Every encoder goes
 * through here, so the hash and the assembled transaction cannot disagree
 * about what was checked.
 */
function normalizeTransaction(
  request: TransactionRequest,
): NormalizedTransaction {
  const req = snapshotTransaction(request);
  if (typeof req.to !== "string" || !req.to) {
    // Also the EIP-7702 rule: a set-code transaction cannot create a contract.
    fail("Missing 'to' address for transaction");
  }
  if (req.chainId === undefined) {
    fail("Transaction chainId is required; refusing to guess a network.");
  }
  if (!Number.isSafeInteger(req.chainId)) {
    fail("Transaction chainId must be a safe integer.");
  }
  const chainId = BigInt(req.chainId);
  if (chainId <= 0n) fail("Transaction chainId must be a positive integer.");
  if (!ADDRESS.test(req.to)) {
    fail("Transaction 'to' must be a 20-byte EVM address.");
  }
  const assertQuantity = (value: string | undefined, field: string): void => {
    if (value !== undefined && !CANONICAL_QUANTITY.test(value)) {
      fail(`Transaction ${field} must be a canonical hexadecimal quantity.`);
    }
  };
  assertQuantity(req.nonce, "nonce");
  assertQuantity(req.gasPrice, "gasPrice");
  assertQuantity(req.gas, "gas");
  assertQuantity(req.value, "value");
  assertQuantity(req.maxFeePerGas, "maxFeePerGas");
  assertQuantity(req.maxPriorityFeePerGas, "maxPriorityFeePerGas");
  const maxFeePerGas =
    req.maxFeePerGas === undefined ? 0n : BigInt(req.maxFeePerGas);
  const maxPriorityFeePerGas =
    req.maxPriorityFeePerGas === undefined
      ? 0n
      : BigInt(req.maxPriorityFeePerGas);
  if (maxPriorityFeePerGas > maxFeePerGas) {
    fail("maxPriorityFeePerGas cannot exceed maxFeePerGas.");
  }
  const hasEip1559Fees =
    req.maxFeePerGas !== undefined || req.maxPriorityFeePerGas !== undefined;
  if (req.type === "legacy" && hasEip1559Fees) {
    fail("Legacy transactions cannot include EIP-1559 fee fields.");
  }
  if (req.type === "eip1559" && !hasEip1559Fees) {
    fail("EIP-1559 transactions require maxFeePerGas or maxPriorityFeePerGas.");
  }
  if (req.type === "eip7702" && !hasEip1559Fees) {
    fail("EIP-7702 transactions require maxFeePerGas or maxPriorityFeePerGas.");
  }
  if (hasEip1559Fees && req.gasPrice !== undefined) {
    fail("EIP-1559 transactions cannot include gasPrice.");
  }
  if (req.data !== undefined && !/^0x(?:[0-9a-fA-F]{2})*$/.test(req.data)) {
    fail("Transaction data must be an even-length hex byte string.");
  }

  if (req.type === "eip7702") {
    const list = req.authorizationList;
    if (!Array.isArray(list) || list.length === 0) {
      fail("EIP-7702 transactions require a non-empty authorizationList.");
    }
    for (const auth of list) {
      assertSignedAuthorization(auth);
      // A mismatched authorization is skipped by the chain, not rejected, and
      // the transaction then runs against an account with no delegation. Chain ID 0
      // is refused here as well: an any-chain delegation is not something to
      // broadcast by default.
      if (BigInt(auth.chainId) !== chainId) {
        fail(
          `Authorization chainId ${auth.chainId} does not match transaction chainId ${chainId}.`,
        );
      }
    }
    return { kind: "eip7702", chainId, req };
  }
  if (req.authorizationList !== undefined) {
    fail("authorizationList is only valid on an EIP-7702 transaction.");
  }
  const kind: TxKind =
    req.type === "eip1559" || (req.type === undefined && hasEip1559Fees)
      ? "eip1559"
      : "legacy";
  return { kind, chainId, req };
}

function feeMarketFields(tx: NormalizedTransaction): Uint8Array[] {
  const { req } = tx;
  return [
    toRlpQuantity(hex(tx.chainId)),
    toRlpQuantity(req.nonce ?? "0x0"),
    toRlpQuantity(req.maxPriorityFeePerGas ?? "0x0"),
    toRlpQuantity(req.maxFeePerGas ?? "0x0"),
    toRlpQuantity(req.gas ?? "0x5208"),
    toRlpBytes(req.to),
    toRlpQuantity(req.value ?? "0x0"),
    toRlpBytes(req.data ?? "0x"),
    EMPTY_ACCESS_LIST,
    ...(tx.kind === "eip7702"
      ? [
          encodeRlpList(
            (req.authorizationList as SignedEip7702Authorization[]).map(
              (auth) =>
                encodeRlpList([
                  ...authorizationFields(auth),
                  toRlpQuantity(hex(auth.yParity)),
                  toRlpQuantity(auth.r),
                  toRlpQuantity(auth.s),
                ]),
            ),
          ),
        ]
      : []),
  ];
}

function legacyFields(tx: NormalizedTransaction): Uint8Array[] {
  const { req } = tx;
  return [
    toRlpQuantity(req.nonce ?? "0x0"),
    toRlpQuantity(req.gasPrice ?? "0x0"),
    toRlpQuantity(req.gas ?? "0x5208"),
    toRlpBytes(req.to),
    toRlpQuantity(req.value ?? "0x0"),
    toRlpBytes(req.data ?? "0x"),
  ];
}

function typePrefix(kind: TxKind): Uint8Array {
  return new Uint8Array([
    kind === "eip7702" ? SET_CODE_TX_TYPE : EIP1559_TX_TYPE,
  ]);
}

/**
 * The 32-byte digest a transaction's sender signs.
 *
 * - legacy: keccak256(rlp([nonce, gasPrice, gas, to, value, data, chainId, 0, 0])) (EIP-155)
 * - type 2: keccak256(0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, []]))
 * - type 4: keccak256(0x04 ‖ rlp([…type 2 fields…, authorizationList]))
 */
export function transactionSigningHash(req: TransactionRequest): Uint8Array {
  const tx = normalizeTransaction(req);
  if (tx.kind === "legacy") {
    return keccak_256(
      encodeRlpList([
        ...legacyFields(tx),
        toRlpQuantity(hex(tx.chainId)),
        toRlpBytes("0x"),
        toRlpBytes("0x"),
      ]),
    );
  }
  return keccak_256(
    concatBytes(typePrefix(tx.kind), encodeRlpList(feeMarketFields(tx))),
  );
}

/**
 * The raw signed transaction for `eth_sendRawTransaction`, from the request
 * and a signature over `transactionSigningHash(req)` produced elsewhere.
 *
 * Does not recover the signer: the caller that produced the signature knows
 * which key it used. It does refuse a signature no node would accept (r or s
 * out of range, high s), since that one came from outside this module.
 */
export function serializeSignedTransaction(
  req: TransactionRequest,
  signature: TransactionSignature,
): `0x${string}` {
  assertSignature(signature, "Transaction");
  return assembleSignedTransaction(req, signature);
}

/**
 * Assemble without the signature range check, for a signature this package
 * just produced from the digest via signDigest (canonical low-s by
 * construction). Shape is still guaranteed by `transactionSignature`.
 */
export function assembleSignedTransaction(
  req: TransactionRequest,
  signature: TransactionSignature,
): `0x${string}` {
  const tx = normalizeTransaction(req);
  const r = toRlpQuantity(signature.r);
  const s = toRlpQuantity(signature.s);
  if (tx.kind === "legacy") {
    const v = BigInt(signature.yParity) + 35n + tx.chainId * 2n;
    return `0x${bytesToHex(encodeRlpList([...legacyFields(tx), toRlpQuantity(hex(v)), r, s]))}`;
  }
  return `0x${bytesToHex(
    concatBytes(
      typePrefix(tx.kind),
      encodeRlpList([
        ...feeMarketFields(tx),
        toRlpQuantity(hex(signature.yParity)),
        r,
        s,
      ]),
    ),
  )}`;
}

/** r ‖ s from a 64-byte compact signature, with its recovery id as y-parity. */
export function transactionSignature(
  compact: Uint8Array,
  recovery: number,
): TransactionSignature {
  if (compact.length !== 64 || (recovery !== 0 && recovery !== 1)) {
    fail("Signature must be 64 compact bytes with recovery id 0 or 1.");
  }
  return {
    r: `0x${bytesToHex(compact.slice(0, 32))}`,
    s: `0x${bytesToHex(compact.slice(32, 64))}`,
    yParity: recovery,
  };
}

function assertSignature(sig: TransactionSignature, what: string): void {
  if (sig.yParity !== 0 && sig.yParity !== 1) {
    fail(`${what} signature yParity must be 0 or 1.`);
  }
  if (!WORD.test(sig.r) || !WORD.test(sig.s)) {
    fail(`${what} signature r and s must be 32-byte hex values.`);
  }
  const r = BigInt(sig.r);
  const s = BigInt(sig.s);
  // EIP-2: s in the lower half of the curve order. EIP-7702 applies the same
  // bound to authorizations, and a chain skips an out-of-range one silently
  // rather than rejecting the transaction — so authorizations are checked
  // even when this package signed them.
  if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_N / 2n) {
    fail(`${what} signature r or s is outside the valid secp256k1 range.`);
  }
}

function assertAuthorization(
  auth: Eip7702AuthorizationRequest,
  options: Eip7702AuthorizationOptions = {},
): void {
  if (!auth || typeof auth !== "object") fail("Authorization is required.");
  if (!Number.isSafeInteger(auth.chainId) || auth.chainId < 0) {
    fail("Authorization chainId must be a non-negative safe integer.");
  }
  if (auth.chainId === 0 && options.unsafeAllowAnyChainAuthorization !== true) {
    fail(
      "Authorization chainId 0 is valid on every chain; refusing without unsafeAllowAnyChainAuthorization.",
    );
  }
  if (typeof auth.address !== "string" || !ADDRESS.test(auth.address)) {
    fail("Authorization address must be a 20-byte EVM address.");
  }
  if (
    typeof auth.nonce !== "string" ||
    !CANONICAL_QUANTITY.test(auth.nonce) ||
    BigInt(auth.nonce) >= MAX_AUTHORIZATION_NONCE
  ) {
    fail(
      "Authorization nonce must be a canonical hex quantity below 2^64 - 1.",
    );
  }
}

function assertSignedAuthorization(auth: SignedEip7702Authorization): void {
  // The transaction builder re-checks the chain against its own chain ID, so
  // chain ID 0 passes this shape check and is refused there.
  assertAuthorization(auth, { unsafeAllowAnyChainAuthorization: true });
  assertSignature(auth, "Authorization");
}

function authorizationFields(auth: Eip7702AuthorizationRequest): Uint8Array[] {
  return [
    toRlpQuantity(hex(auth.chainId)),
    toRlpBytes(auth.address),
    toRlpQuantity(auth.nonce),
  ];
}

/**
 * The digest an EIP-7702 authority signs: keccak256(0x05 ‖ rlp([chainId, address, nonce])).
 *
 * Refuses `chainId: 0` unless `unsafeAllowAnyChainAuthorization` is set.
 * `address` 0x000…0 is accepted — that is how a delegation is revoked.
 */
export function authorizationHash(
  authorization: Eip7702AuthorizationRequest,
  options?: Eip7702AuthorizationOptions,
): Uint8Array {
  const auth = snapshotAuthorization(authorization);
  assertAuthorization(auth, options);
  return keccak_256(
    concatBytes(
      new Uint8Array([AUTHORIZATION_MAGIC]),
      encodeRlpList(authorizationFields(auth)),
    ),
  );
}

/**
 * Attach a signature over `authorizationHash(auth)` to the authorization.
 * Pass the same snapshot to both, so the result names what was signed.
 */
export function signedAuthorization(
  authorization: Eip7702AuthorizationRequest,
  signature: TransactionSignature,
): SignedEip7702Authorization {
  const auth = snapshotAuthorization(authorization);
  const signed: SignedEip7702Authorization = {
    chainId: auth.chainId,
    address: auth.address,
    nonce: auth.nonce,
    yParity: signature.yParity,
    r: signature.r,
    s: signature.s,
  };
  assertSignedAuthorization(signed);
  return signed;
}
