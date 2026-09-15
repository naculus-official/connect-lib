/**
 * UserOperation Builder & Signer
 *
 * Provides utilities for constructing, signing, and sending ERC-4337
 * UserOperations without depending on @account-abstraction/sdk.
 *
 * @see docs/features/account-abstraction.md
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { AccountAbstractionError } from "./errors";
import {
  type Address,
  type BundlerClient,
  type Call,
  DEFAULT_CALL_GAS_LIMIT,
  DEFAULT_PRE_VERIFICATION_GAS,
  DEFAULT_VERIFICATION_GAS_LIMIT,
  type Hex,
  type UserOperation,
  type UserOperationGasEstimate,
  type UserOperationReceipt,
  type UserOperationResponse,
  type UserOperationVersion,
} from "./types";

// ─── Build ─────────────────────────────────────────────────────────────

/**
 * Build a partial UserOperation from the given fields.
 *
 * @param params - UserOperation fields
 * @returns UserOperation with defaults applied for any missing fields
 */
export function buildUserOperation(
  params: Partial<UserOperation>,
): UserOperation {
  return {
    sender: params.sender ?? "0x0000000000000000000000000000000000000000",
    nonce: params.nonce ?? 0n,
    initCode: params.initCode ?? "0x",
    callData: params.callData ?? "0x",
    accountGasLimits:
      params.accountGasLimits ??
      encodeGasLimits(DEFAULT_VERIFICATION_GAS_LIMIT, DEFAULT_CALL_GAS_LIMIT),
    gasFees:
      params.gasFees ??
      encodeGasFees(
        params.maxPriorityFeePerGas ?? 0n,
        params.maxFeePerGas ?? 0n,
      ),
    preVerificationGas:
      params.preVerificationGas ?? DEFAULT_PRE_VERIFICATION_GAS,
    maxFeePerGas: params.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas ?? 0n,
    paymasterAndData: params.paymasterAndData ?? "0x",
    signature: params.signature ?? "0x",
  };
}

/**
 * Build the callData for a UserOperation from one or more calls.
 *
 * For a single call, encodes as execute(to, value, data).
 * For multiple calls, encodes the version-specific official SimpleAccount
 * executeBatch ABI. v0.6 uses `(address[],bytes[])` and only supports zero
 * native value; v0.7 uses `(address[],uint256[],bytes[])`.
 *
 * @param calls - Array of calls to include
 * @param version - SimpleAccount/EntryPoint ABI version (defaults to v0.7)
 * @returns Encoded calldata
 */
export function buildCallData(
  calls: Call[],
  version: UserOperationVersion = "0.7",
): Hex {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new AccountAbstractionError("aa_no_calls");
  }

  for (const call of calls) {
    if (
      !call ||
      typeof call !== "object" ||
      typeof call.to !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(call.to) ||
      typeof call.value !== "bigint" ||
      call.value < 0n ||
      call.value >= 1n << 256n ||
      typeof call.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data)
    ) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Calls must contain a 20-byte address, uint256 value, and even-length hex data.",
      );
    }
  }

  if (calls.length === 1) {
    return encodeExecute(calls[0].to, calls[0].value, calls[0].data);
  }

  if (version === "0.6" && calls.some((call) => call.value !== 0n)) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "SimpleAccount v0.6 executeBatch cannot transfer native value; use separate UserOperations or EntryPoint v0.7.",
    );
  }

  return version === "0.6"
    ? encodeExecuteBatchV06(calls)
    : encodeExecuteBatchV07(calls);
}

/**
 * Encode a single execute call for SimpleAccount.
 */
function encodeExecute(to: Address, value: bigint, data: Hex): Hex {
  const selector = "0xb61d27f6"; // execute(address,uint256,bytes)
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Call target must be a 20-byte address.",
    );
  }
  if (value >= 1n << 256n) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Call value must fit in uint256.",
    );
  }
  const toArg = to.toLowerCase().replace("0x", "").padStart(64, "0");
  if (value < 0n) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Call value cannot be negative.",
    );
  }
  const valueArg = value.toString(16).padStart(64, "0");

  // Dynamic bytes encoding: offset(32B) + length(32B) + data
  const rawData = data.replace("0x", "");
  if (rawData.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(rawData)) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Call data must be valid hexadecimal.",
    );
  }
  const dataLen = rawData.length / 2;

  // ABI encoding for execute(address,uint256,bytes):
  // Head: to(32B) | value(32B) | offset_to_bytes(32B)
  // Tail: length(32B) | data(padded to 32B)
  // Offset = 3 head params × 32 bytes = 96
  const bytesOffset = (96).toString(16).padStart(64, "0");
  const dataLenHex = dataLen.toString(16).padStart(64, "0");

  // Pad data to 32-byte boundary
  const paddedLen = Math.ceil(rawData.length / 64) * 64;
  const paddedData = rawData.padEnd(paddedLen, "0");

  return `${selector}${toArg}${valueArg}${bytesOffset}${dataLenHex}${paddedData}` as Hex;
}

/**
 * Encode a batch execute call for SimpleAccount.
 * executeBatch(address[],uint256[],bytes[])
 */
function encodeExecuteBatchV07(calls: Call[]): Hex {
  const selector = "0x47e1da2a";
  const n = calls.length;
  const word = (value: bigint | number): string => {
    if (
      typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Array length is invalid.",
      );
    }
    if (typeof value === "bigint" && (value < 0n || value >= 1n << 256n)) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "ABI integer is out of range.",
      );
    }
    return BigInt(value).toString(16).padStart(64, "0");
  };
  const toArray =
    word(n) +
    calls
      .map((c) => word(BigInt(`0x${c.to.toLowerCase().replace("0x", "")}`)))
      .join("");
  const valuesArray = word(n) + calls.map((c) => word(c.value)).join("");
  const tails = calls.map((c) => {
    if (c.value < 0n) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Call value cannot be negative.",
      );
    }
    const rawData = c.data.replace("0x", "");
    if (rawData.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(rawData)) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Call data must be valid hexadecimal.",
      );
    }
    const padded = rawData.padEnd(Math.ceil(rawData.length / 64) * 64, "0");
    return word(rawData.length / 2) + padded;
  });
  const datasArray =
    word(n) +
    tails
      .map((_, i) =>
        word(
          tails
            .slice(0, i)
            .reduce((sum, tail) => sum + tail.length / 2, n * 32),
        ),
      )
      .join("") +
    tails.join("");

  const toLen = 32 + n * 32;
  const valuesLen = 32 + n * 32;
  const datasLen = datasArray.length / 2;

  const headSize = 32 * 3;
  const toOffset = headSize;
  const valuesOffset = headSize + toLen;
  const datasOffset = headSize + toLen + valuesLen;

  return (`${selector}` +
    word(toOffset) +
    word(valuesOffset) +
    word(datasOffset) +
    toArray +
    valuesArray +
    datasArray) as Hex;
}

/**
 * Encode the v0.6 SimpleAccount batch call.
 *
 * SimpleAccount v0.6 exposes `executeBatch(address[],bytes[])` and always
 * forwards zero native value. v0.7 added the optional values array, so the
 * selector and ABI head are intentionally different.
 */
function encodeExecuteBatchV06(calls: Call[]): Hex {
  const selector = "0x18dfb3c7";
  const n = calls.length;
  const word = (value: bigint | number): string => {
    if (
      typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Array length is invalid.",
      );
    }
    if (typeof value === "bigint" && (value < 0n || value >= 1n << 256n)) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "ABI integer is out of range.",
      );
    }
    return BigInt(value).toString(16).padStart(64, "0");
  };

  const toArray =
    word(n) +
    calls
      .map((call) =>
        word(BigInt(`0x${call.to.toLowerCase().replace("0x", "")}`)),
      )
      .join("");
  const tails = calls.map((call) => {
    const rawData = call.data.replace("0x", "");
    const padded = rawData.padEnd(Math.ceil(rawData.length / 64) * 64, "0");
    return word(rawData.length / 2) + padded;
  });
  const dataArray =
    word(n) +
    tails
      .map((_, index) =>
        word(
          tails
            .slice(0, index)
            .reduce((sum, tail) => sum + tail.length / 2, n * 32),
        ),
      )
      .join("") +
    tails.join("");

  const toArrayLength = 32 + n * 32;
  const headSize = 32 * 2;
  return (`${selector}` +
    word(headSize) +
    word(headSize + toArrayLength) +
    toArray +
    dataArray) as Hex;
}

// ─── Sign ──────────────────────────────────────────────────────────────

export function hashUserOperation(
  userOp: UserOperation,
  entryPoint: Address,
  chainId: number | bigint,
): Hex {
  // ERC-4337 v0.7 EntryPoint.getUserOpHash is:
  // keccak256(abi.encode(keccak256(abi.encode(...packed fields...)),
  //                     address(entryPoint), block.chainid)).
  // It is deliberately not an EIP-191 personal-sign digest.
  const numericChainId = BigInt(chainId);
  if (numericChainId <= 0n) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Chain ID must be a positive integer.",
    );
  }
  const innerHash = keccak256Sync(packUserOp(userOp));
  const outer = concatBytesArray([
    innerHash,
    addressWord(entryPoint),
    bigintWord(numericChainId),
  ]);
  return `0x${bytesToHex(keccak256Sync(outer))}` as Hex;
}

/**
 * Hash a v0.6 UserOperation using EntryPoint.getUserOpHash.
 * v0.6 keeps gas limits and fees as separate uint256 fields.
 */
export function hashUserOperationV06(
  userOp: UserOperation,
  entryPoint: Address,
  chainId: number | bigint,
): Hex {
  const numericChainId = BigInt(chainId);
  if (numericChainId <= 0n) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Chain ID must be a positive integer.",
    );
  }
  const { verificationGasLimit, callGasLimit } = decodePackedGasLimits(
    userOp.accountGasLimits,
  );
  const inner = concatBytesArray([
    addressWord(userOp.sender),
    bigintWord(userOp.nonce),
    keccak256Sync(hexToBytes(userOp.initCode)),
    keccak256Sync(hexToBytes(userOp.callData)),
    bigintWord(callGasLimit),
    bigintWord(verificationGasLimit),
    bigintWord(userOp.preVerificationGas),
    bigintWord(userOp.maxFeePerGas),
    bigintWord(userOp.maxPriorityFeePerGas),
    keccak256Sync(hexToBytes(userOp.paymasterAndData)),
  ]);
  const innerHash = keccak256Sync(inner);
  return `0x${bytesToHex(
    keccak256Sync(
      concatBytesArray([
        innerHash,
        addressWord(entryPoint),
        bigintWord(numericChainId),
      ]),
    ),
  )}` as Hex;
}

/**
 * Pack UserOperation fields into a single bytes hash.
 * Follows the eth-infinitism pattern of hashing all fields together.
 */
function packUserOp(userOp: UserOperation): Uint8Array {
  const bigintTo32Bytes = (n: bigint): Uint8Array => {
    return bigintWord(n);
  };

  const gasFees =
    userOp.gasFees ??
    encodeGasFees(userOp.maxPriorityFeePerGas, userOp.maxFeePerGas);
  return concatBytesArray([
    addressWord(userOp.sender),
    bigintTo32Bytes(userOp.nonce),
    keccak256Sync(hexToBytes(userOp.initCode)),
    keccak256Sync(hexToBytes(userOp.callData)),
    bytes32Word(userOp.accountGasLimits),
    bigintTo32Bytes(userOp.preVerificationGas),
    bytes32Word(gasFees),
    keccak256Sync(hexToBytes(userOp.paymasterAndData)),
  ]);
}

/**
 * Synchronous keccak256 hash using @noble/hashes.
 */
function keccak256Sync(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

function hexToBytes(hex: Hex): Uint8Array {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(raw)) {
    throw new AccountAbstractionError("aa_encode_error", "Invalid hex value.");
  }
  const bytes = new Uint8Array(raw.length / 2);
  for (let i = 0; i < raw.length; i += 2) {
    bytes[i / 2] = Number.parseInt(raw.slice(i, i + 2), 16);
  }
  return bytes;
}

function bigintWord(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Integer exceeds uint256.",
    );
  }
  const bytes = new Uint8Array(32);
  let remaining = value;
  for (let i = 31; i >= 0 && remaining > 0n; i--) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function addressWord(address: Address): Uint8Array {
  const bytes = hexToBytes(address);
  if (bytes.length !== 20) {
    throw new AccountAbstractionError("aa_encode_error", "Invalid address.");
  }
  const word = new Uint8Array(32);
  word.set(bytes, 12);
  return word;
}

function bytes32Word(value: Hex): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Packed UserOperation fields must be exactly 32 bytes.",
    );
  }
  return bytes;
}

function decodePackedGasLimits(value: Hex): {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
} {
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Packed account gas limits must be exactly 32 bytes.",
    );
  }
  return {
    verificationGasLimit: BigInt(`0x${bytesToHex(bytes.slice(0, 16))}`),
    callGasLimit: BigInt(`0x${bytesToHex(bytes.slice(16))}`),
  };
}

function concatBytesArray(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

/**
 * Encode account gas limits as a packed 32-byte value (v0.7).
 */
export function encodeGasLimits(
  verificationGasLimit: bigint,
  callGasLimit: bigint,
): Hex {
  if (
    verificationGasLimit < 0n ||
    callGasLimit < 0n ||
    verificationGasLimit >= 1n << 128n ||
    callGasLimit >= 1n << 128n
  ) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "ERC-4337 v0.7 gas limits must each fit in 128 bits.",
    );
  }
  const vglHex = verificationGasLimit.toString(16).padStart(32, "0");
  const cglHex = callGasLimit.toString(16).padStart(32, "0");
  return `0x${vglHex}${cglHex}` as Hex;
}

/** Encode maxPriorityFeePerGas (high 128 bits) and maxFeePerGas (low 128 bits). */
export function encodeGasFees(
  maxPriorityFeePerGas: bigint,
  maxFeePerGas: bigint,
): Hex {
  const max128 = (value: bigint, label: string) => {
    if (value < 0n || value >= 1n << 128n) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        `${label} must fit in 128 bits for ERC-4337 v0.7.`,
      );
    }
    return value.toString(16).padStart(32, "0");
  };
  return `0x${max128(maxPriorityFeePerGas, "maxPriorityFeePerGas")}${max128(maxFeePerGas, "maxFeePerGas")}` as Hex;
}

// ─── Sign ──────────────────────────────────────────────────────────────

/**
 * Sign a UserOperation using the account's signature scheme.
 *
 * For SimpleAccount, the signature is a standard ECDSA signature.
 *
 * @param userOp - The UserOperation to sign (without signature)
 * @param signer - A function that signs the raw ERC-4337 userOpHash. The
 * account contract decides how to interpret the signature; do not wrap this
 * hash in EIP-191 unless the account explicitly requires that scheme.
 * @param entryPoint - EntryPoint contract address
 * @param chainId - EVM chain ID
 * @param signerMode - Sign the raw hash or the EIP-191-prefixed hash
 * @returns The UserOperation with signature field filled
 */
export async function signUserOperation(
  userOp: UserOperation,
  signer: (hash: Hex) => Promise<Hex> | Hex,
  entryPoint: Address,
  chainId: number | bigint,
  signerMode: "raw" | "eip191" = "raw",
): Promise<UserOperation> {
  try {
    const hash = hashUserOperation(userOp, entryPoint, chainId);
    const signature = await signer(
      signerMode === "eip191" ? toEthSignedMessageHash(hash) : hash,
    );

    return {
      ...userOp,
      signature,
    };
  } catch (error) {
    throw new AccountAbstractionError(
      "aa_signature_failed",
      "Failed to sign UserOperation",
      error,
    );
  }
}

/** Sign a v0.6 UserOperation with the account's configured scheme. */
export async function signUserOperationV06(
  userOp: UserOperation,
  signer: (hash: Hex) => Promise<Hex> | Hex,
  entryPoint: Address,
  chainId: number | bigint,
  signerMode: "raw" | "eip191" = "raw",
): Promise<UserOperation> {
  try {
    const hash = hashUserOperationV06(userOp, entryPoint, chainId);
    return {
      ...userOp,
      signature: await signer(
        signerMode === "eip191" ? toEthSignedMessageHash(hash) : hash,
      ),
    };
  } catch (error) {
    throw new AccountAbstractionError(
      "aa_signature_failed",
      "Failed to sign v0.6 UserOperation",
      error,
    );
  }
}

/** Apply the EIP-191 personal-sign prefix used by eth-infinitism SimpleAccount. */
export function toEthSignedMessageHash(hash: Hex): Hex {
  const message = hexToBytes(hash);
  if (message.length !== 32) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "UserOperation hash must be exactly 32 bytes.",
    );
  }
  const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n32");
  return `0x${bytesToHex(keccak256Sync(concatBytesArray([prefix, message])))}` as Hex;
}

// ─── Send ──────────────────────────────────────────────────────────────

export function quantity(value: bigint): string {
  if (value < 0n) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "UserOperation quantities cannot be negative.",
    );
  }
  return `0x${value.toString(16)}`;
}

function splitInitCode(initCode: Hex): Record<string, string> {
  if (initCode === "0x") return {};
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(initCode) || initCode.length < 42) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "ERC-4337 v0.7 initCode must contain a 20-byte factory address.",
    );
  }
  return {
    factory: `0x${initCode.slice(2, 42)}` as Address,
    factoryData: `0x${initCode.slice(42)}` as Hex,
  };
}

function splitPaymasterAndData(
  paymasterAndData: Hex,
): Record<string, string> {
  if (paymasterAndData === "0x") return {};
  const raw = paymasterAndData.slice(2);
  // address (20 bytes) + validation gas (16) + postOp gas (16)
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(raw) || raw.length < 104) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "ERC-4337 v0.7 paymasterAndData must contain the address and both uint128 gas limits.",
    );
  }
  return {
    paymaster: `0x${raw.slice(0, 40)}` as Address,
    paymasterVerificationGasLimit: quantity(
      BigInt(`0x${raw.slice(40, 72)}`),
    ),
    paymasterPostOpGasLimit: quantity(BigInt(`0x${raw.slice(72, 104)}`)),
    paymasterData: `0x${raw.slice(104)}` as Hex,
  };
}

/** Serialize the internal packed UserOperation into the versioned RPC shape. */
export function serializeUserOperationForRpc(
  userOp: UserOperation,
  version: UserOperationVersion,
): Record<string, string> {
  if (version === "0.6") {
    const { verificationGasLimit, callGasLimit } = decodePackedGasLimits(
      userOp.accountGasLimits,
    );
    return {
      sender: userOp.sender,
      nonce: quantity(userOp.nonce),
      initCode: userOp.initCode,
      callData: userOp.callData,
      callGasLimit: quantity(callGasLimit),
      verificationGasLimit: quantity(verificationGasLimit),
      preVerificationGas: quantity(userOp.preVerificationGas),
      maxFeePerGas: quantity(userOp.maxFeePerGas),
      maxPriorityFeePerGas: quantity(userOp.maxPriorityFeePerGas),
      paymasterAndData: userOp.paymasterAndData,
      signature: userOp.signature,
    };
  }
  const { verificationGasLimit, callGasLimit } = decodePackedGasLimits(
    userOp.accountGasLimits,
  );
  return {
    sender: userOp.sender,
    nonce: quantity(userOp.nonce),
    ...splitInitCode(userOp.initCode),
    callData: userOp.callData,
    callGasLimit: quantity(callGasLimit),
    verificationGasLimit: quantity(verificationGasLimit),
    preVerificationGas: quantity(userOp.preVerificationGas),
    maxFeePerGas: quantity(userOp.maxFeePerGas),
    maxPriorityFeePerGas: quantity(userOp.maxPriorityFeePerGas),
    ...splitPaymasterAndData(userOp.paymasterAndData),
    signature: userOp.signature,
  };
}

/**
 * Send a UserOperation to a bundler RPC endpoint.
 *
 * @param userOp - The signed UserOperation
 * @param bundlerUrl - Bundler RPC URL
 * @param entryPoint - EntryPoint contract address
 * @returns UserOperation response with userOpHash
 */
export async function sendUserOperation(
  userOp: UserOperation,
  bundlerUrl: string,
  entryPoint: Address,
  version: UserOperationVersion = "0.7",
): Promise<UserOperationResponse> {
  if (!bundlerUrl) {
    throw new AccountAbstractionError("aa_no_bundler");
  }

  const serializedOp = serializeUserOperationForRpc(userOp, version);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    let response: Response;
    try {
      response = await fetch(bundlerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendUserOperation",
          params: [serializedOp, entryPoint],
        }),
        signal: controller.signal,
      });
    } catch {
      throw new AccountAbstractionError(
        "aa_user_op_rejected",
        "Failed to connect to bundler",
      );
    }

    if (!response.ok) {
      throw new AccountAbstractionError(
        "aa_user_op_rejected",
        `Bundler returned status ${response.status}`,
      );
    }

    const json = (await response.json()) as {
      result?: Hex;
      error?: { code: number; message: string };
    };

    if (json.error) {
      throw new AccountAbstractionError(
        "aa_user_op_rejected",
        json.error.message,
        { code: json.error.code },
      );
    }

    if (
      typeof json.result !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(json.result)
    ) {
      throw new AccountAbstractionError(
        "aa_user_op_rejected",
        "Bundler returned an invalid UserOperation hash.",
      );
    }

    return {
      userOpHash: json.result,
      sender: userOp.sender,
      nonce: userOp.nonce,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Estimate Gas ──────────────────────────────────────────────────────

/**
 * Estimate gas for a UserOperation via the bundler's eth_estimateUserOperationGas.
 *
 * @param userOp - Partial UserOperation (signature not required)
 * @param entryPoint - EntryPoint contract address
 * @param bundlerUrl - Bundler RPC URL
 * @returns Gas estimates (callGasLimit, verificationGasLimit, preVerificationGas)
 */
export async function estimateUserOperationGas(
  userOp: Partial<UserOperation>,
  entryPoint: Address,
  bundlerUrl: string,
  version: UserOperationVersion = "0.7",
): Promise<UserOperationGasEstimate> {
  if (!bundlerUrl) {
    throw new AccountAbstractionError("aa_no_bundler");
  }

  // Serialize for RPC
  const partial = {
    sender: userOp.sender ?? "0x0000000000000000000000000000000000000000",
    nonce: userOp.nonce ?? 0n,
    initCode: userOp.initCode ?? "0x",
    callData: userOp.callData ?? "0x",
    accountGasLimits:
      userOp.accountGasLimits ??
      `0x${DEFAULT_VERIFICATION_GAS_LIMIT.toString(16).padStart(32, "0")}${DEFAULT_CALL_GAS_LIMIT.toString(16).padStart(32, "0")}`,
    gasFees:
      userOp.gasFees ??
      encodeGasFees(
        userOp.maxPriorityFeePerGas ?? 0n,
        userOp.maxFeePerGas ?? 0n,
      ),
    preVerificationGas:
      userOp.preVerificationGas ?? DEFAULT_PRE_VERIFICATION_GAS,
    paymasterAndData: userOp.paymasterAndData ?? "0x",
    signature: userOp.signature ?? "0x",
    maxFeePerGas: userOp.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: userOp.maxPriorityFeePerGas ?? 0n,
  } as UserOperation;
  const serializedOp = serializeUserOperationForRpc(partial, version);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    let response: Response;
    try {
      response = await fetch(bundlerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_estimateUserOperationGas",
          params: [serializedOp, entryPoint],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AccountAbstractionError(
        "aa_estimation_failed",
        "Failed to connect to bundler for gas estimation.",
        error,
      );
    }

    if (!response.ok) {
      throw new AccountAbstractionError(
        "aa_estimation_failed",
        `Bundler returned status ${response.status} during gas estimation.`,
      );
    }

    let json: {
      result?: {
        callGasLimit?: string;
        verificationGasLimit?: string;
        preVerificationGas?: string;
        accountGasLimits?: string;
        paymasterVerificationGasLimit?: string;
      };
      error?: { code: number; message: string };
    };
    try {
      json = (await response.json()) as typeof json;
    } catch (error) {
      throw new AccountAbstractionError(
        "aa_estimation_failed",
        "Bundler returned invalid JSON during gas estimation.",
        error,
      );
    }

    if (json.error || !json.result) {
      throw new AccountAbstractionError(
        "aa_estimation_failed",
        json.error?.message ?? "Bundler returned no gas estimate.",
        json.error,
      );
    }

    const result = json.result;
    const parseEstimate = (value: unknown, field: string): bigint => {
      if (
        typeof value !== "string" ||
        !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
      ) {
        throw new AccountAbstractionError(
          "aa_estimation_failed",
          `Bundler returned an invalid ${field}.`,
        );
      }
      return BigInt(value);
    };

    // Try to decode accountGasLimits (v0.7)
    if (result.accountGasLimits) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(result.accountGasLimits)) {
        throw new AccountAbstractionError(
          "aa_estimation_failed",
          "Bundler returned invalid packed accountGasLimits.",
        );
      }
      const raw = result.accountGasLimits.slice(2);
      return {
        callGasLimit: BigInt(`0x${raw.slice(32, 64)}`),
        verificationGasLimit: BigInt(`0x${raw.slice(0, 32)}`),
        preVerificationGas: parseEstimate(
          result.preVerificationGas,
          "preVerificationGas",
        ),
        accountGasLimits: result.accountGasLimits as Hex,
        ...(result.paymasterVerificationGasLimit === undefined
          ? {}
          : {
              paymasterVerificationGasLimit: parseEstimate(
                result.paymasterVerificationGasLimit,
                "paymasterVerificationGasLimit",
              ),
            }),
      };
    }

    return {
      callGasLimit: parseEstimate(result.callGasLimit, "callGasLimit"),
      verificationGasLimit: parseEstimate(
        result.verificationGasLimit,
        "verificationGasLimit",
      ),
      preVerificationGas: parseEstimate(
        result.preVerificationGas,
        "preVerificationGas",
      ),
      ...(result.paymasterVerificationGasLimit === undefined
        ? {}
        : {
            paymasterVerificationGasLimit: parseEstimate(
              result.paymasterVerificationGasLimit,
              "paymasterVerificationGasLimit",
            ),
          }),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
