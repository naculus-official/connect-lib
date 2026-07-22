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
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

export function abiEncodeUint256(value: bigint): string {
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
  return Number(BigInt(raw));
}

export async function erc20Call(
  rpcUrl: string,
  to: `0x${string}`,
  selector: string,
  argsHex: string,
): Promise<string> {
  const data = selector + argsHex.replace("0x", "");
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const json: any = await res.json();
  if (json.error)
    throw new WalletError("rpc_error", `RPC error: ${json.error.message}`);
  return json.result as string;
}

export function parseUnits(amount: string, decimals: number): bigint {
  if (typeof amount !== "string") {
    throw new WalletError("invalid_input", "Amount must be a string.");
  }
  const trimmed = amount.trim();
  if (!/^[0-9]*\.?[0-9]*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
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
  if (clean.length < 128) return "";
  const length = parseInt(clean.slice(64, 128), 16);
  const dataHex = clean.slice(128, 128 + length * 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

// ── Public ERC-20 Methods ───────────────────────────────────────────

export async function sendERC20Transfer(
  ctx: Erc20WalletContext,
  chainId: number,
  tokenAddress: `0x${string}`,
  to: `0x${string}`,
  amount: string,
): Promise<TransactionResult> {
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
  if (!ctx.rpcUrl) throw new WalletError("no_rpc", "RPC URL not configured.");
  const result = await erc20Call(
    ctx.rpcUrl,
    tokenAddress,
    await getSelector("allowance(address,address)"),
    abiEncodeAddress(owner) + abiEncodeAddress(spender),
  );
  return BigInt(result);
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
  if (!ctx.rpcUrl) throw new WalletError("no_rpc", "RPC URL not configured.");
  const rpcUrl = ctx.rpcUrl;
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const { bytesToHex } = await import("@noble/hashes/utils");

  const selector = (sig: string) =>
    `0x${bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8)}`;

  const call = async (data: string): Promise<string> => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: tokenAddress, data }, "latest"],
      }),
    });
    const json: any = await res.json();
    if (json.error)
      throw new WalletError("rpc_error", `RPC error: ${json.error.message}`);
    return json.result as string;
  };

  const [nameRaw, symbolRaw, decimalsRaw, totalSupplyRaw] = await Promise.all([
    call(selector("name()")),
    call(selector("symbol()")),
    call(selector("decimals()")),
    call(selector("totalSupply()")),
  ]);

  return {
    name: decodeERC20String(nameRaw),
    symbol: decodeERC20String(symbolRaw),
    decimals: Number(BigInt(decimalsRaw)),
    totalSupply: BigInt(totalSupplyRaw),
  };
}
