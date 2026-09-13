/**
 * ERC-20 Token Utilities
 *
 * Pure helper functions and public ERC-20 method implementations
 * extracted from wallet.ts for modularity.
 *
 * These functions operate on wallet state via a context object,
 * keeping them decoupled from the PocketWallet class.
 */

import { WalletError } from "./errors";
import type { TransactionRequest, TransactionResult } from "./signers/types";

// ── Context ─────────────────────────────────────────────────────────

export interface Erc20WalletContext {
  address?: string | null;
  rpcUrl?: string;
  chainId: string;
  sendTransaction: (tx: TransactionRequest) => Promise<TransactionResult>;
}

// ── ABI Helpers ─────────────────────────────────────────────────────

export function abiEncodeAddress(addr: `0x${string}`): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new WalletError("invalid_input", "Invalid ERC-20 address.");
  }
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

export function abiEncodeUint256(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) {
    throw new WalletError("invalid_input", "ERC-20 amount exceeds uint256.");
  }
  return value.toString(16).padStart(64, "0");
}

export async function getSelector(signature: string): Promise<string> {
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const { bytesToHex } = await import("@noble/hashes/utils");
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8)}`;
}

export async function encodeERC20Transfer(
  to: `0x${string}`,
  rawAmount: bigint,
): Promise<`0x${string}`> {
  const selector = await getSelector("transfer(address,uint256)");
  const args = abiEncodeAddress(to) + abiEncodeUint256(rawAmount);
  return `${selector}${args}` as `0x${string}`;
}

export async function encodeERC20Approve(
  spender: `0x${string}`,
  rawAmount: bigint,
): Promise<`0x${string}`> {
  const selector = await getSelector("approve(address,uint256)");
  const args = abiEncodeAddress(spender) + abiEncodeUint256(rawAmount);
  return `${selector}${args}` as `0x${string}`;
}

export async function getERC20Decimals(
  rpcUrl: string,
  tokenAddress: `0x${string}`,
): Promise<number> {
  const raw = await erc20Call(
    rpcUrl,
    tokenAddress,
    await getSelector("decimals()"),
    "",
  );
  return decodeUint8(raw);
}

export async function erc20Call(
  rpcUrl: string,
  to: `0x${string}`,
  selector: string,
  argsHex: string,
): Promise<string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new WalletError("invalid_input", "Invalid ERC-20 contract address.");
  }
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) {
    throw new WalletError("invalid_input", "Invalid ERC-20 function selector.");
  }
  const data = selector + argsHex.replace(/^0x/, "");
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) {
    throw new WalletError("invalid_input", "Invalid ERC-20 calldata.");
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new WalletError("rpc_error", `RPC returned HTTP ${res.status}.`);
    }
    const json = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (json.error) {
      throw new WalletError(
        "rpc_error",
        `RPC error: ${json.error.message ?? "unknown error"}`,
      );
    }
    if (typeof json.result !== "string") {
      throw new WalletError("rpc_error", "RPC returned no hex result.");
    }
    return json.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function parseUnits(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new WalletError(
      "invalid_input",
      "Decimals must be an integer from 0 to 255.",
    );
  }
  if (typeof amount !== "string") {
    throw new WalletError("invalid_input", "Amount must be a string.");
  }
  const trimmed = amount.trim();
  // Character loop avoids ReDoS from ambiguous regex quantifiers
  let hasDot = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === ".") {
      if (hasDot)
        throw new WalletError(
          "invalid_input",
          `Multiple decimal points in amount: ${amount}`,
        );
      hasDot = true;
    } else if (ch < "0" || ch > "9")
      throw new WalletError(
        "invalid_input",
        `Invalid character '${ch}' in amount: ${amount}`,
      );
  }
  if (trimmed === "" || trimmed === ".") {
    throw new WalletError("invalid_input", `Invalid amount: ${amount}`);
  }
  const parts = trimmed.split(".");
  const integerPart = parts[0].replace(/^0+/, "") || "0";
  let fractionalPart = parts[1] || "";
  if (fractionalPart.length > decimals) {
    throw new WalletError(
      "invalid_input",
      `Amount has ${fractionalPart.length} decimal places, max is ${decimals}.`,
    );
  }
  fractionalPart = fractionalPart.padEnd(decimals, "0");
  return BigInt(integerPart + fractionalPart);
}

export function decodeERC20String(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) return "";
  if (clean.length === 64) {
    const end = clean.search(/00/);
    const dataHex = end === -1 ? clean : clean.slice(0, end);
    return decodeHexText(dataHex);
  }
  if (clean.length < 128 || BigInt(`0x${clean.slice(0, 64)}`) !== 32n)
    return "";
  const length = BigInt(`0x${clean.slice(64, 128)}`);
  const availableBytes = BigInt((clean.length - 128) / 2);
  if (length > availableBytes || length > BigInt(Number.MAX_SAFE_INTEGER))
    return "";
  return decodeHexText(clean.slice(128, 128 + Number(length) * 2));
}

function decodeHexText(hex: string): string {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return "";
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function decodeUint256(hex: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new WalletError("rpc_error", "RPC returned an invalid uint256.");
  }
  const clean = hex.slice(2);
  if (clean.length > 64 || clean.length % 2 !== 0) {
    throw new WalletError("rpc_error", "RPC returned an invalid uint256.");
  }
  return BigInt(hex);
}

function decodeUint8(hex: string): number {
  const value = decodeUint256(hex);
  if (value > 255n) {
    throw new WalletError(
      "rpc_error",
      "RPC returned an out-of-range decimals value.",
    );
  }
  return Number(value);
}

function assertChainContext(ctx: Erc20WalletContext, chainId: number): void {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new WalletError(
      "invalid_input",
      "Chain ID must be a positive safe integer.",
    );
  }
  const configured = ctx.chainId.startsWith("eip155:")
    ? ctx.chainId.slice("eip155:".length)
    : ctx.chainId;
  if (configured !== String(chainId)) {
    throw new WalletError(
      "chain_mismatch",
      `ERC-20 operation requested chain ${chainId}, but wallet is configured for ${ctx.chainId}.`,
    );
  }
}

// ── Public ERC-20 Methods ───────────────────────────────────────────

export async function sendERC20Transfer(
  ctx: Erc20WalletContext,
  chainId: number,
  tokenAddress: `0x${string}`,
  to: `0x${string}`,
  amount: string,
): Promise<TransactionResult> {
  assertChainContext(ctx, chainId);
  if (!ctx.address) throw new WalletError("no_wallet", "No wallet loaded.");
  if (!ctx.rpcUrl) throw new WalletError("no_rpc", "RPC URL not configured.");

  const decimals = await getERC20Decimals(ctx.rpcUrl, tokenAddress);
  const rawAmount = parseUnits(amount, decimals);
  const from = ctx.address as `0x${string}`;

  const data = await encodeERC20Transfer(to, rawAmount);

  return ctx.sendTransaction({
    to: tokenAddress,
    from,
    data,
    value: "0x0",
  });
}

export async function sendERC20Approve(
  ctx: Erc20WalletContext,
  chainId: number,
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  amount: string,
): Promise<TransactionResult> {
  assertChainContext(ctx, chainId);
  if (!ctx.address) throw new WalletError("no_wallet", "No wallet loaded.");
  if (!ctx.rpcUrl) throw new WalletError("no_rpc", "RPC URL not configured.");

  const decimals = await getERC20Decimals(ctx.rpcUrl, tokenAddress);
  const rawAmount = parseUnits(amount, decimals);

  const data = await encodeERC20Approve(spender, rawAmount);

  return ctx.sendTransaction({
    to: tokenAddress,
    from: ctx.address as `0x${string}`,
    data,
    value: "0x0",
  });
}

export async function getERC20Allowance(
  ctx: Erc20WalletContext,
  chainId: number,
  tokenAddress: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  assertChainContext(ctx, chainId);
  if (!ctx.rpcUrl) throw new WalletError("no_rpc", "RPC URL not configured.");
  const result = await erc20Call(
    ctx.rpcUrl,
    tokenAddress,
    await getSelector("allowance(address,address)"),
    abiEncodeAddress(owner) + abiEncodeAddress(spender),
  );
  return decodeUint256(result);
}

export async function getERC20TokenInfo(
  ctx: Erc20WalletContext,
  chainId: number,
  tokenAddress: `0x${string}`,
): Promise<{
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}> {
  assertChainContext(ctx, chainId);
  if (!ctx.rpcUrl) throw new WalletError("no_rpc", "RPC URL not configured.");
  const rpcUrl = ctx.rpcUrl;

  const [nameRaw, symbolRaw, decimalsRaw, totalSupplyRaw] = await Promise.all([
    erc20Call(rpcUrl, tokenAddress, await getSelector("name()"), ""),
    erc20Call(rpcUrl, tokenAddress, await getSelector("symbol()"), ""),
    erc20Call(rpcUrl, tokenAddress, await getSelector("decimals()"), ""),
    erc20Call(rpcUrl, tokenAddress, await getSelector("totalSupply()"), ""),
  ]);

  return {
    name: decodeERC20String(nameRaw),
    symbol: decodeERC20String(symbolRaw),
    decimals: decodeUint8(decimalsRaw),
    totalSupply: decodeUint256(totalSupplyRaw),
  };
}
