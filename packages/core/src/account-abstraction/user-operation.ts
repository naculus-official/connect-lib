/**
 * UserOperation Builder & Signer
 *
 * Provides utilities for constructing, signing, and sending ERC-4337
 * UserOperations without depending on @account-abstraction/sdk.
 *
 * @see docs/features/account-abstraction.md
 */

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
} from "./types";

// ─── EIP-712 Domain & Types for UserOperation ──────────────────────────

/**
 * EIP-712 typed data for UserOperation signing.
 * Used for eth_signTypedData / eth_signTypedData_v4.
 */
export const USER_OP_EIP712_DOMAIN = (
  chainId: number,
  verifyingContract: Address,
) => ({
  name: "Account",
  version: "1",
  chainId,
  verifyingContract,
});

/**
 * EIP-712 type definitions for UserOperation.
 * Matches eth-infinitism's entry point contracts.
 */
export const USER_OP_EIP712_TYPES = {
  UserOperation: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" },
    { name: "accountGasLimits", type: "bytes32" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "maxPriorityFeePerGas", type: "uint256" },
    { name: "paymasterAndData", type: "bytes" },
    { name: "signature", type: "bytes" },
  ],
};

/**
 * EIP-712 type definitions for UserOperation (v0.6 format).
 * Uses callGasLimit and verificationGasLimit separately instead of accountGasLimits.
 */
export const USER_OP_EIP712_TYPES_V06 = {
  UserOperation: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" },
    { name: "callGasLimit", type: "uint256" },
    { name: "verificationGasLimit", type: "uint256" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "maxPriorityFeePerGas", type: "uint256" },
    { name: "paymasterAndData", type: "bytes" },
    { name: "signature", type: "bytes" },
  ],
};

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
    sender: params.sender ?? "0x",
    nonce: params.nonce ?? 0n,
    initCode: params.initCode ?? "0x",
    callData: params.callData ?? "0x",
    accountGasLimits:
      params.accountGasLimits ??
      encodeGasLimits(DEFAULT_VERIFICATION_GAS_LIMIT, DEFAULT_CALL_GAS_LIMIT),
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
 * For multiple calls, encodes as executeBatch(to[], value[], data[]).
 *
 * @param calls - Array of calls to include
 * @returns Encoded calldata
 */
export function buildCallData(calls: Call[]): Hex {
  if (!calls.length) {
    throw new AccountAbstractionError("aa_no_calls");
  }

  if (calls.length === 1) {
    return encodeExecute(calls[0].to, calls[0].value, calls[0].data);
  }

  return encodeExecuteBatch(calls);
}

/**
 * Encode a single execute call for SimpleAccount.
 */
function encodeExecute(to: Address, value: bigint, data: Hex): Hex {
  const selector = "0xb61d27f6"; // execute(address,uint256,bytes)
  const toArg = to.toLowerCase().replace("0x", "").padStart(64, "0");
  const valueArg = value.toString(16).padStart(64, "0");

  // Dynamic bytes encoding: offset(32B) + length(32B) + data
  const rawData = data.replace("0x", "");
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
function encodeExecuteBatch(calls: Call[]): Hex {
  const selector = "0x47e1da2a";
  const n = calls.length;
  const nWord = n.toString(16).padStart(64, "0");

  // Build arrays
  const toArray =
    nWord +
    calls
      .map((c) => c.to.toLowerCase().replace("0x", "").padStart(64, "0"))
      .join("");
  const valuesArray =
    nWord + calls.map((c) => c.value.toString(16).padStart(64, "0")).join("");

  // Datas: array of dynamic bytes
  const datasEntries = calls
    .map((c) => {
      const rawData = c.data.replace("0x", "");
      const len = rawData.length / 2;
      return len.toString(16).padStart(64, "0") + rawData;
    })
    .join("");
  const datasArray = nWord + datasEntries;

  const toLen = 32 + n * 32;
  const valuesLen = 32 + n * 32;
  const datasLen = 32 + datasEntries.length / 2;

  const headSize = 32 * 3; // 3 offsets
  const toOffset = headSize;
  const valuesOffset = headSize + toLen;
  const datasOffset = headSize + toLen + valuesLen;

  return (`${selector}` +
    toOffset.toString(16).padStart(64, "0") +
    valuesOffset.toString(16).padStart(64, "0") +
    datasOffset.toString(16).padStart(64, "0") +
    toArray +
    valuesArray +
    datasArray) as Hex;
}

// ─── Sign ──────────────────────────────────────────────────────────────

/**
 * Compute the EIP-712 hash of a UserOperation for signing.
 *
 * @param userOp - The UserOperation to hash
 * @param entryPoint - EntryPoint contract address
 * @param chainId - EVM chain ID
 * @returns The EIP-712 typed data hash
 */
/**
 * EIP-712 domain separator for UserOperation hashing.
 */
function computeDomainSeparator(
  entryPoint: Address,
  chainId: number,
): Uint8Array {
  const { concatBytes: concat } = (() => {
    return {
      concatBytes: (...arrays: Uint8Array[]) => {
        const total = arrays.reduce((a, b) => a + b.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const arr of arrays) {
          result.set(arr, offset);
          offset += arr.length;
        }
        return result;
      },
    };
  })();

  const toBytes = (hex: Hex): Uint8Array => {
    const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(raw.length / 2);
    for (let i = 0; i < raw.length; i += 2) {
      bytes[i / 2] = parseInt(raw.slice(i, i + 2), 16);
    }
    return bytes;
  };

  const stringToBytes = (s: string): Uint8Array => new TextEncoder().encode(s);
  const padded32 = (b: Uint8Array): Uint8Array => {
    if (b.length >= 32) return b.slice(0, 32);
    const result = new Uint8Array(32);
    result.set(b);
    return result;
  };

  // EIP-712 domain: keccak256(abi.encode(
  //   keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  //   keccak256("Account"), keccak256("1"),
  //   uint256(chainId), address(entryPoint)
  // ))
  const domainTypeHash = keccak256Sync(
    stringToBytes(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ),
  );
  const nameHash = keccak256Sync(stringToBytes("Account"));
  const versionHash = keccak256Sync(stringToBytes("1"));

  const chainIdBytes = new Uint8Array(32);
  const chainIdBigInt = BigInt(chainId);
  const chainIdHex = chainIdBigInt.toString(16).padStart(64, "0");
  const chainIdArray = toBytes(`0x${chainIdHex}`);

  const entryPointBytes = toBytes(entryPoint);
  const entryPointPadded = new Uint8Array(32);
  entryPointPadded.set(entryPointBytes, 12); // address is right-aligned (last 20 bytes)

  return keccak256Sync(
    concat(
      domainTypeHash,
      nameHash,
      versionHash,
      chainIdArray,
      entryPointPadded,
    ),
  );
}

export function hashUserOperation(
  userOp: UserOperation,
  entryPoint: Address,
  chainId: number,
): Hex {
  const {
    sender,
    nonce,
    initCode,
    callData,
    accountGasLimits,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymasterAndData,
  } = userOp;

  const packed = packUserOp({
    sender,
    nonce,
    initCode,
    callData,
    accountGasLimits,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymasterAndData,
  });

  // Inner userOp hash
  const userOpHash = keccak256Sync(packed);

  // EIP-712 domain separator
  const domainSeparator = computeDomainSeparator(entryPoint, chainId);

  // Combined: \x19\x01 || domainSeparator || userOpHash
  const { concatBytes } = (() => {
    return {
      concatBytes: (...arrays: Uint8Array[]) => {
        const total = arrays.reduce((a, b) => a + b.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const arr of arrays) {
          result.set(arr, offset);
          offset += arr.length;
        }
        return result;
      },
    };
  })();

  const prefix = new Uint8Array([0x19, 0x01]);
  const finalHash = keccak256Sync(
    concatBytes(prefix, domainSeparator, userOpHash),
  );

  const { bytesToHex } = requireBytesToHex();
  return `0x${bytesToHex(finalHash)}` as Hex;
}

/**
 * Pack UserOperation fields into a single bytes hash.
 * Follows the eth-infinitism pattern of hashing all fields together.
 */
function packUserOp(
  userOp: Pick<
    UserOperation,
    | "sender"
    | "nonce"
    | "initCode"
    | "callData"
    | "accountGasLimits"
    | "preVerificationGas"
    | "maxFeePerGas"
    | "maxPriorityFeePerGas"
    | "paymasterAndData"
  >,
): Uint8Array {
  const { concatBytes, bytesToHex } = (() => {
    // Synchronous utilities
    const encoder = new TextEncoder();
    return {
      concatBytes: (...arrays: Uint8Array[]) => {
        const total = arrays.reduce((a, b) => a + b.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const arr of arrays) {
          result.set(arr, offset);
          offset += arr.length;
        }
        return result;
      },
      bytesToHex: (bytes: Uint8Array) => {
        return Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      },
    };
  })();

  const toBytes = (hex: Hex): Uint8Array => {
    const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(raw.length / 2);
    for (let i = 0; i < raw.length; i += 2) {
      bytes[i / 2] = parseInt(raw.slice(i, i + 2), 16);
    }
    return bytes;
  };

  const bigintTo32Bytes = (n: bigint): Uint8Array => {
    const hex = n.toString(16).padStart(64, "0");
    return toBytes(`0x${hex}`);
  };

  return concatBytes(
    toBytes(userOp.sender),
    bigintTo32Bytes(userOp.nonce),
    keccak256Sync(toBytes(userOp.initCode)),
    keccak256Sync(toBytes(userOp.callData)),
    toBytes(userOp.accountGasLimits),
    bigintTo32Bytes(userOp.preVerificationGas),
    bigintTo32Bytes(userOp.maxFeePerGas),
    bigintTo32Bytes(userOp.maxPriorityFeePerGas),
    keccak256Sync(toBytes(userOp.paymasterAndData)),
  );
}

/**
 * Synchronous keccak256 hash using @noble/hashes.
 */
function keccak256Sync(data: Uint8Array): Uint8Array {
  // Inline to avoid dynamic import constraints — we use a pure JS fallback
  // but if @noble/hashes is available it will be used
  const { keccak_256 } = requireKeccak();
  return keccak_256(data);
}

/**
 * Memoized require for keccak256 to avoid re-importing.
 */
let _keccakFn: ((data: Uint8Array) => Uint8Array) | null = null;

function requireKeccak(): { keccak_256: (data: Uint8Array) => Uint8Array } {
  if (_keccakFn) return { keccak_256: _keccakFn };

  // Try @noble/hashes first
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const noble = require("@noble/hashes/sha3");
    _keccakFn = noble.keccak_256;
  } catch {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "keccak256 not available. @noble/hashes is required.",
    );
  }

  return { keccak_256: _keccakFn! };
}

let _bytesToHexFn: ((bytes: Uint8Array) => string) | null = null;

function requireBytesToHex(): { bytesToHex: (bytes: Uint8Array) => string } {
  if (_bytesToHexFn) return { bytesToHex: _bytesToHexFn };

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const noble = require("@noble/hashes/utils");
    _bytesToHexFn = noble.bytesToHex;
  } catch {
    _bytesToHexFn = (bytes: Uint8Array) =>
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
  }

  return { bytesToHex: _bytesToHexFn! };
}

/**
 * Encode account gas limits as a packed 32-byte value (v0.7).
 */
export function encodeGasLimits(
  verificationGasLimit: bigint,
  callGasLimit: bigint,
): Hex {
  const vglHex = verificationGasLimit.toString(16).padStart(32, "0");
  const cglHex = callGasLimit.toString(16).padStart(32, "0");
  return `0x${vglHex}${cglHex}` as Hex;
}

// ─── Sign ──────────────────────────────────────────────────────────────

/**
 * Sign a UserOperation using EIP-191 or EIP-712.
 *
 * For SimpleAccount, the signature is a standard ECDSA signature.
 *
 * @param userOp - The UserOperation to sign (without signature)
 * @param signer - A function that signs arbitrary data (e.g. personal_sign)
 * @param entryPoint - EntryPoint contract address
 * @param chainId - EVM chain ID
 * @returns The UserOperation with signature field filled
 */
export async function signUserOperation(
  userOp: UserOperation,
  signer: (hash: Hex) => Promise<Hex> | Hex,
  entryPoint: Address,
  chainId: number,
): Promise<UserOperation> {
  try {
    const hash = hashUserOperation(userOp, entryPoint, chainId);

    // Wrap the hash in the EIP-191 personal_sign format
    const messageHash = await wrapEIP191(hash);

    const signature = await signer(messageHash);

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

/**
 * Wrap data in EIP-191 personal_sign format:
 * \x19Ethereum Signed Message:\n + len(message) + message
 */
async function wrapEIP191(hash: Hex): Promise<Hex> {
  const rawMessage = hash.startsWith("0x") ? hash.slice(2) : hash;
  const prefix = `\x19Ethereum Signed Message:\n${rawMessage.length / 2}`;
  const encoder = new TextEncoder();
  const prefixBytes = encoder.encode(prefix);
  const messageBytes = new Uint8Array(rawMessage.length / 2);
  for (let i = 0; i < rawMessage.length; i += 2) {
    messageBytes[i / 2] = parseInt(rawMessage.slice(i, i + 2), 16);
  }

  const combined = new Uint8Array(prefixBytes.length + messageBytes.length);
  combined.set(prefixBytes);
  combined.set(messageBytes, prefixBytes.length);

  const { keccak_256 } = await import("@noble/hashes/sha3");
  const { bytesToHex } = await import("@noble/hashes/utils");
  return `0x${bytesToHex(keccak_256(combined))}` as Hex;
}

// ─── Send ──────────────────────────────────────────────────────────────

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
): Promise<UserOperationResponse> {
  if (!bundlerUrl) {
    throw new AccountAbstractionError("aa_no_bundler");
  }

  // Serialize for RPC: bigint → hex string
  const serializedOp = {
    sender: userOp.sender,
    nonce: `0x${userOp.nonce.toString(16)}`,
    initCode: userOp.initCode,
    callData: userOp.callData,
    accountGasLimits: userOp.accountGasLimits,
    preVerificationGas: `0x${userOp.preVerificationGas.toString(16)}`,
    maxFeePerGas: `0x${userOp.maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${userOp.maxPriorityFeePerGas.toString(16)}`,
    paymasterAndData: userOp.paymasterAndData,
    signature: userOp.signature,
  };

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

    return {
      userOpHash: json.result as Hex,
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
): Promise<UserOperationGasEstimate> {
  if (!bundlerUrl) {
    throw new AccountAbstractionError("aa_no_bundler");
  }

  // Serialize for RPC
  const serializedOp = {
    sender: userOp.sender ?? "0x0000000000000000000000000000000000000000",
    nonce: `0x${(userOp.nonce ?? 0n).toString(16)}`,
    initCode: userOp.initCode ?? "0x",
    callData: userOp.callData ?? "0x",
    accountGasLimits:
      userOp.accountGasLimits ??
      `0x${DEFAULT_VERIFICATION_GAS_LIMIT.toString(16).padStart(32, "0")}${DEFAULT_CALL_GAS_LIMIT.toString(16).padStart(32, "0")}`,
    preVerificationGas: `0x${(userOp.preVerificationGas ?? DEFAULT_PRE_VERIFICATION_GAS).toString(16)}`,
    maxFeePerGas: `0x${(userOp.maxFeePerGas ?? 0n).toString(16)}`,
    maxPriorityFeePerGas: `0x${(userOp.maxPriorityFeePerGas ?? 0n).toString(16)}`,
    paymasterAndData: userOp.paymasterAndData ?? "0x",
    signature: userOp.signature ?? "0x",
  };

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
    } catch {
      // Network error (DNS failure, timeout, etc.) — return defaults
      return {
        callGasLimit: DEFAULT_CALL_GAS_LIMIT,
        verificationGasLimit: DEFAULT_VERIFICATION_GAS_LIMIT,
        preVerificationGas: DEFAULT_PRE_VERIFICATION_GAS,
      };
    }

    if (!response.ok) {
      return {
        callGasLimit: DEFAULT_CALL_GAS_LIMIT,
        verificationGasLimit: DEFAULT_VERIFICATION_GAS_LIMIT,
        preVerificationGas: DEFAULT_PRE_VERIFICATION_GAS,
      };
    }

    const json = (await response.json().catch(() => ({}))) as {
      result?: {
        callGasLimit?: string;
        verificationGasLimit?: string;
        preVerificationGas?: string;
        accountGasLimits?: string;
      };
      error?: { code: number; message: string };
    };

    if (json.error || !json.result) {
      // If estimation fails, return default values
      return {
        callGasLimit: DEFAULT_CALL_GAS_LIMIT,
        verificationGasLimit: DEFAULT_VERIFICATION_GAS_LIMIT,
        preVerificationGas: DEFAULT_PRE_VERIFICATION_GAS,
      };
    }

    const result = json.result!;

    // Try to decode accountGasLimits (v0.7)
    if (result.accountGasLimits) {
      const raw = result.accountGasLimits.replace("0x", "");
      return {
        callGasLimit: BigInt(`0x${raw.slice(32, 64)}`),
        verificationGasLimit: BigInt(`0x${raw.slice(0, 32)}`),
        preVerificationGas: result.preVerificationGas
          ? BigInt(result.preVerificationGas)
          : DEFAULT_PRE_VERIFICATION_GAS,
        accountGasLimits: result.accountGasLimits as Hex,
      };
    }

    return {
      callGasLimit: result.callGasLimit
        ? BigInt(result.callGasLimit)
        : DEFAULT_CALL_GAS_LIMIT,
      verificationGasLimit: result.verificationGasLimit
        ? BigInt(result.verificationGasLimit)
        : DEFAULT_VERIFICATION_GAS_LIMIT,
      preVerificationGas: result.preVerificationGas
        ? BigInt(result.preVerificationGas)
        : DEFAULT_PRE_VERIFICATION_GAS,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
