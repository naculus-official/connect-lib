/**
 * ERC20TokenHelper — ABI encoding, RPC queries, and transaction building
 * for ERC-20 tokens.
 *
 * Design:
 * - Zero dependency on viem/ethers for ABI encoding
 * - Uses @noble/hashes/keccak_256 (already in monorepo) for selector computation
 * - All methods are static (composition over inheritance)
 * - Transaction builder methods return raw TransactionRequest objects
 *
 * @see SRS-007
 */

import { rpcCall } from "../abortable-fetch";
import { isValidAddress } from "../address-validation";
import { DEFAULT_RPC_URLS } from "../rpc";
import { ERC20_FUNCTION_SIGNATURES } from "./abi";
import { ERC20TokenError } from "./errors";
import type {
  ERC20ApproveTxParams,
  ERC20CallOptions,
  ERC20TransferFromTxParams,
  ERC20TransferTxParams,
  TokenConfig,
  TokenInfo,
} from "./types";
import { parseUnits } from "./units";

// ── Hex/Padding Utilities ──────────────────────────────────────────

/** Strip 0x prefix from a hex string */
function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/** Left-pad a hex string (without 0x) to 64 hex chars (32 bytes) */
function padLeftTo32Bytes(hex: string): string {
  return hex.padStart(64, "0");
}

function assertTokenAddress(
  address: string,
  field: string,
): asserts address is `0x${string}` {
  if (!isValidAddress(address, "eip155")) {
    throw new ERC20TokenError(
      "invalid_address",
      `Invalid EVM ${field} address.`,
    );
  }
}

function assertChainId(chainId: number): void {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new ERC20TokenError(
      "invalid_chain",
      `Invalid EVM chain ID: ${chainId}.`,
    );
  }
}

function assertTokenConfig(token: TokenConfig): void {
  assertTokenAddress(token.address, "token");
  assertChainId(token.chainId);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ERC20TokenError(
      "invalid_amount",
      `Invalid ERC-20 decimals: ${decimals}.`,
    );
  }
}

function normalizeRawAmount(
  amount: ERC20TransferTxParams["amount"],
  decimals: number,
): bigint {
  assertDecimals(decimals);
  if (typeof amount === "string") return parseUnits(amount, decimals);
  if (typeof amount !== "bigint" || amount < 0n) {
    throw new ERC20TokenError(
      "invalid_amount",
      "ERC-20 amount must be a non-negative decimal string or bigint.",
    );
  }
  return amount;
}

/**
 * Compute keccak256 hash from raw bytes and return as hex string.
 * Uses dynamic import of @noble/hashes to keep no direct import side-effect.
 */
async function keccak256Hex(data: Uint8Array): Promise<string> {
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const { bytesToHex } = await import("@noble/hashes/utils");
  return bytesToHex(keccak_256(data));
}

// ── ABI Encoding ───────────────────────────────────────────────────

/**
 * ABI-encode an address: left-pad to 32 bytes.
 * "0xabc" → "0x0000...000abc"
 */
export function abiEncodeAddress(addr: `0x${string}`): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new ERC20TokenError(
      "invalid_address",
      `Invalid EVM address: "${addr}". Expected 0x-prefixed 40-char hex.`,
    );
  }
  return `0x${padLeftTo32Bytes(strip0x(addr.toLowerCase()))}` as `0x${string}`;
}

/**
 * ABI-encode a uint256: left-pad to 32 bytes.
 */
export function abiEncodeUint256(value: bigint): `0x${string}` {
  if (value < 0n || value > (1n << 256n) - 1n) {
    throw new ERC20TokenError(
      "invalid_amount",
      `Cannot encode negative uint256: ${value}`,
    );
  }
  const hex = value.toString(16);
  // Ensure even-length hex
  const paddedHex = hex.length % 2 === 0 ? hex : `0${hex}`;
  return `0x${padLeftTo32Bytes(paddedHex)}` as `0x${string}`;
}

/**
 * Compute a 4-byte function selector from a canonical function signature.
 *
 * @example
 * abiFunctionSelector("transfer(address,uint256)")
 *   // → "0xa9059cbb"
 */
export async function abiFunctionSelector(
  signature: string,
): Promise<`0x${string}`> {
  const hash = await keccak256Hex(new TextEncoder().encode(signature));
  return `0x${hash.slice(0, 8)}` as `0x${string}`;
}

/**
 * Full ABI function call encoding: 4-byte selector + packed args.
 *
 * @example
 * const data = await abiEncodeFunctionCall(
 *   "transfer(address,uint256)",
 *   "0xRecipientAddress...",
 *   "0x0000...0001e240"  // already-encoded uint256
 * );
 */
export async function abiEncodeFunctionCall(
  signature: string,
  ...encodedArgs: string[]
): Promise<`0x${string}`> {
  const selector = await abiFunctionSelector(signature);
  const args = encodedArgs.map((a) => {
    const clean = strip0x(a);
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new ERC20TokenError(
        "encoding_error",
        "ABI arguments must be 32-byte encoded values.",
      );
    }
    return clean;
  });
  const data = args.join("");
  return `${selector}${data}` as `0x${string}`;
}

/**
 * Convenience: encode a transfer(address,uint256) call.
 */
async function encodeTransfer(
  to: `0x${string}`,
  rawAmount: bigint,
): Promise<`0x${string}`> {
  return abiEncodeFunctionCall(
    ERC20_FUNCTION_SIGNATURES.transfer,
    abiEncodeAddress(to),
    abiEncodeUint256(rawAmount),
  );
}

/**
 * Convenience: encode an approve(address,uint256) call.
 */
async function encodeApprove(
  spender: `0x${string}`,
  rawAmount: bigint,
): Promise<`0x${string}`> {
  return abiEncodeFunctionCall(
    ERC20_FUNCTION_SIGNATURES.approve,
    abiEncodeAddress(spender),
    abiEncodeUint256(rawAmount),
  );
}

/**
 * Convenience: encode a transferFrom(address,address,uint256) call.
 */
async function encodeTransferFrom(
  from: `0x${string}`,
  to: `0x${string}`,
  rawAmount: bigint,
): Promise<`0x${string}`> {
  return abiEncodeFunctionCall(
    ERC20_FUNCTION_SIGNATURES.transferFrom,
    abiEncodeAddress(from),
    abiEncodeAddress(to),
    abiEncodeUint256(rawAmount),
  );
}

// ── RPC Helpers ────────────────────────────────────────────────────

/**
 * Get the RPC URL for a given chain ID.
 */
function getRpcUrl(chainId: number, options?: ERC20CallOptions): string {
  assertChainId(chainId);
  if (options?.rpcUrl) return options.rpcUrl;
  const url = DEFAULT_RPC_URLS[`eip155:${chainId}`];
  if (!url) {
    throw new ERC20TokenError(
      "rpc_error",
      `No default RPC URL for chain ID ${chainId}. Provide options.rpcUrl.`,
    );
  }
  return url;
}

/**
 * Make a JSON-RPC eth_call with 10s timeout.
 */
async function ethCall(
  rpcUrl: string,
  to: `0x${string}`,
  data: `0x${string}`,
): Promise<string> {
  try {
    const result = await rpcCall<unknown>(rpcUrl, "eth_call", [
      { to, data },
      "latest",
    ]);
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) {
      throw new ERC20TokenError(
        "encoding_error",
        "RPC eth_call returned a non-hex result.",
      );
    }
    return result;
  } catch (err) {
    if (err instanceof ERC20TokenError) throw err;
    throw new ERC20TokenError("rpc_error", `RPC eth_call error: ${err}`, err);
  }
}

/**
 * Decode a hex-encoded bytes32 or string result from eth_call.
 * For simple uint256/address returns, just return the raw hex.
 */
function decodeUint256(hex: string): bigint {
  const clean = strip0x(hex);
  if (
    !/^0x?[0-9a-fA-F]+$/.test(hex) ||
    clean.length > 64 ||
    clean.length % 2 !== 0
  ) {
    throw new ERC20TokenError(
      "encoding_error",
      "RPC returned an invalid uint256 encoding.",
    );
  }
  return BigInt(`0x${clean}`);
}

function decodeString(hex: string): string {
  const clean = strip0x(hex);
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) return "";

  // A number of deployed ERC-20s predate the metadata interface and return a
  // bytes32 symbol/name. Accept that canonical legacy form as well as ABI
  // dynamic strings, without trusting an unbounded length from the RPC.
  if (clean.length === 64) {
    const end = clean.search(/00/);
    const dataHex = end === -1 ? clean : clean.slice(0, end);
    return new TextDecoder().decode(hexToBytes(dataHex));
  }

  // ABI-encoded string: offset (32 bytes) + length (32 bytes) + data.
  if (clean.length < 128 || BigInt(`0x${clean.slice(0, 64)}`) !== 32n) {
    return "";
  }
  const length = BigInt(`0x${clean.slice(64, 128)}`);
  const availableBytes = BigInt((clean.length - 128) / 2);
  if (length > availableBytes || length > BigInt(Number.MAX_SAFE_INTEGER)) {
    return "";
  }
  const dataHex = clean.slice(128, 128 + Number(length) * 2);
  const bytes = hexToBytes(dataHex);
  return new TextDecoder().decode(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new ERC20TokenError(
      "encoding_error",
      "RPC returned an invalid hexadecimal encoding.",
    );
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function decodeUint8(hex: string): number {
  const value = decodeUint256(hex);
  if (value > 255n) {
    throw new ERC20TokenError(
      "encoding_error",
      "RPC returned an out-of-range uint8 value.",
    );
  }
  return Number(value);
}

// ── Selector Cache ────────────────────────────────────────────────

const selectorCache = new Map<string, `0x${string}`>();

async function getSelector(signature: string): Promise<`0x${string}`> {
  const cached = selectorCache.get(signature);
  if (cached) return cached;
  const selector = await abiFunctionSelector(signature);
  selectorCache.set(signature, selector);
  return selector;
}

// ── ERC20TokenHelper ──────────────────────────────────────────────

export class ERC20TokenHelper {
  /**
   * Build a raw ERC-20 transfer TransactionRequest.
   *
   * The returned object can be fed into PocketWallet.sendTransaction()
   * or signed offline.
   */
  static async buildTransferTx(
    params: ERC20TransferTxParams,
    decimals: number,
  ): Promise<{
    to: `0x${string}`;
    from: `0x${string}`;
    data: `0x${string}`;
    value: "0x0";
  }> {
    assertTokenConfig(params.token);
    assertTokenAddress(params.from, "sender");
    assertTokenAddress(params.to, "recipient");
    const rawAmount = normalizeRawAmount(params.amount, decimals);

    const data = await encodeTransfer(params.to, rawAmount);

    return {
      to: params.token.address,
      from: params.from,
      data,
      value: "0x0",
    };
  }

  /**
   * Build a raw ERC-20 approve TransactionRequest.
   */
  static async buildApproveTx(
    params: ERC20ApproveTxParams,
    decimals: number,
  ): Promise<{
    to: `0x${string}`;
    from: `0x${string}`;
    data: `0x${string}`;
    value: "0x0";
  }> {
    assertTokenConfig(params.token);
    assertTokenAddress(params.owner, "owner");
    assertTokenAddress(params.spender, "spender");
    const rawAmount = normalizeRawAmount(params.amount, decimals);

    const data = await encodeApprove(params.spender, rawAmount);

    return {
      to: params.token.address,
      from: params.owner,
      data,
      value: "0x0",
    };
  }

  /**
   * Build a raw ERC-20 transferFrom TransactionRequest.
   * Requires the caller to have been approved first.
   */
  static async buildTransferFromTx(
    params: ERC20TransferFromTxParams,
    decimals: number,
  ): Promise<{
    to: `0x${string}`;
    from: `0x${string}`;
    data: `0x${string}`;
    value: "0x0";
  }> {
    assertTokenConfig(params.token);
    assertTokenAddress(params.from, "sender");
    assertTokenAddress(params.to, "recipient");
    const rawAmount = normalizeRawAmount(params.amount, decimals);

    const data = await encodeTransferFrom(params.from, params.to, rawAmount);

    return {
      to: params.token.address,
      from: params.from,
      data,
      value: "0x0",
    };
  }

  /**
   * Call allowance(address,address) on-chain.
   * Returns remaining allowance in smallest unit (bigint).
   */
  static async getAllowance(
    token: TokenConfig,
    owner: `0x${string}`,
    spender: `0x${string}`,
    options?: ERC20CallOptions,
  ): Promise<bigint> {
    assertTokenConfig(token);
    assertTokenAddress(owner, "owner");
    assertTokenAddress(spender, "spender");
    const rpcUrl = getRpcUrl(token.chainId, options);

    const selector = await getSelector(ERC20_FUNCTION_SIGNATURES.allowance);
    const data =
      `${selector}${strip0x(abiEncodeAddress(owner))}${strip0x(abiEncodeAddress(spender))}` as `0x${string}`;

    const result = await ethCall(rpcUrl, token.address, data);
    return decodeUint256(result);
  }

  /**
   * Fetch token metadata (name, symbol, decimals, totalSupply) from chain.
   * Makes 4 parallel RPC calls.
   */
  static async getTokenInfo(
    token: TokenConfig,
    options?: ERC20CallOptions,
  ): Promise<TokenInfo> {
    assertTokenConfig(token);
    const rpcUrl = getRpcUrl(token.chainId, options);
    const to = token.address;

    const nameSelector = await getSelector(ERC20_FUNCTION_SIGNATURES.name);
    const symbolSelector = await getSelector(ERC20_FUNCTION_SIGNATURES.symbol);
    const decimalsSelector = await getSelector(
      ERC20_FUNCTION_SIGNATURES.decimals,
    );
    const totalSupplySelector = await getSelector(
      ERC20_FUNCTION_SIGNATURES.totalSupply,
    );

    const call = async (data: `0x${string}`) => ethCall(rpcUrl, to, data);

    try {
      const [nameRaw, symbolRaw, decimalsRaw, totalSupplyRaw] =
        await Promise.all([
          call(nameSelector),
          call(symbolSelector),
          call(decimalsSelector),
          call(totalSupplySelector),
        ]);

      const name = decodeString(nameRaw);
      const symbol = decodeString(symbolRaw);
      const decimals = decodeUint8(decimalsRaw);
      const totalSupply = decodeUint256(totalSupplyRaw);

      return { name, symbol, decimals, totalSupply };
    } catch (err) {
      if (err instanceof ERC20TokenError) throw err;
      throw new ERC20TokenError(
        "token_info_fetch_failed",
        "Failed to fetch token metadata from chain.",
        err,
      );
    }
  }

  /**
   * Check if a token is deployed on the target chain.
   * Returns true if the contract has code (extcodesize > 0).
   */
  static async isTokenDeployed(
    token: TokenConfig,
    options?: ERC20CallOptions,
  ): Promise<boolean> {
    assertTokenConfig(token);
    const rpcUrl = getRpcUrl(token.chainId, options);

    try {
      const code = await rpcCall<unknown>(rpcUrl, "eth_getCode", [
        token.address,
        "latest",
      ]);
      if (typeof code !== "string" || !/^0x[0-9a-fA-F]*$/.test(code)) {
        throw new ERC20TokenError(
          "encoding_error",
          "RPC eth_getCode returned a non-hex result.",
        );
      }
      return !/^0x0*$/i.test(code);
    } catch (err) {
      throw new ERC20TokenError(
        "rpc_error",
        `RPC eth_getCode error: ${err}`,
        err,
      );
    }
  }

  /**
   * Fetch token decimals from chain (or return cached value).
   */
  static async getDecimals(
    token: TokenConfig,
    options?: ERC20CallOptions,
  ): Promise<number> {
    assertTokenConfig(token);
    if (token.decimals !== undefined) {
      assertDecimals(token.decimals);
      return token.decimals;
    }

    const rpcUrl = getRpcUrl(token.chainId, options);
    const selector = await getSelector(ERC20_FUNCTION_SIGNATURES.decimals);
    const data = selector;

    try {
      const result = await ethCall(rpcUrl, token.address, data);
      return decodeUint8(result);
    } catch (err) {
      if (err instanceof ERC20TokenError) throw err;
      throw new ERC20TokenError(
        "decimals_fetch_failed",
        `Failed to fetch decimals for token ${token.address} on chain ${token.chainId}.`,
        err,
      );
    }
  }

  /**
   * Convenience: parse a human-readable amount to raw units using the token's decimals.
   */
  static async parseToRawAmount(
    token: TokenConfig,
    amount: string | number,
    options?: ERC20CallOptions,
  ): Promise<bigint> {
    const decimals = await ERC20TokenHelper.getDecimals(token, options);
    return parseUnits(amount, decimals);
  }

  /**
   * Convenience: format a raw bigint amount to a human-readable string using the token's decimals.
   */
  static async formatRawAmount(
    token: TokenConfig,
    rawAmount: bigint,
    options?: ERC20CallOptions,
  ): Promise<string> {
    const decimals = await ERC20TokenHelper.getDecimals(token, options);
    const { formatUnits } = await import("./units");
    return formatUnits(rawAmount, decimals);
  }
}
