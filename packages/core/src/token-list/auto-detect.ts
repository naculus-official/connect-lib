/**
 * Auto-detect — fetch token metadata from chain and cache to localStorage.
 *
 * Uses ERC20TokenHelper.getTokenInfo() to retrieve name, symbol, decimals.
 * Results are cached in localStorage to avoid repeated RPC calls.
 */

import { createStorageAdapter, type StorageAdapter } from "../storage";
import type { TokenListEntry } from "./types";

const CACHE_KEY = "naculus_auto_detected_tokens";
const DEFAULT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CachedEntry {
  token: TokenListEntry;
  timestamp: number;
}

/**
 * A minimal on-chain token fetcher compatible with Node and browser.
 *
 * Makes eth_call RPC requests to invoke standard ERC-20 functions:
 *   name(), symbol(), decimals()
 */
export async function detectTokenInfo(
  address: string,
  chainId: number,
  rpcUrl: string,
  options?: { skipCache?: boolean },
): Promise<TokenListEntry> {
  // Check cache first
  if (!options?.skipCache) {
    const cached = await getFromCache(address, chainId);
    if (cached) return cached;
  }

  // Normalize address
  const addr = address.startsWith("0x")
    ? (address as `0x${string}`)
    : `0x${address}`;

  // Build selectors and eth_call data for name, symbol, decimals
  const nameData = "0x06fdde03"; // keccak256("name()")[0:4]
  const symbolData = "0x95d89b41"; // keccak256("symbol()")[0:4]
  const decimalsData = "0x313ce567"; // keccak256("decimals()")[0:4]

  const [nameRaw, symbolRaw, decimalsRaw] = await Promise.all([
    ethCall(rpcUrl, addr as `0x${string}`, nameData),
    ethCall(rpcUrl, addr as `0x${string}`, symbolData),
    ethCall(rpcUrl, addr as `0x${string}`, decimalsData),
  ]);

  const token: TokenListEntry = {
    address: addr,
    chainId,
    name: decodeString(nameRaw),
    symbol: decodeString(symbolRaw),
    decimals: decodeUint8(decimalsRaw),
    source: "auto-detect",
    tags: ["custom"],
  };

  // Cache the result
  await saveToCache(token);

  return token;
}

/**
 * Clear the auto-detect cache.
 */
export async function clearAutoDetectCache(): Promise<void> {
  const storage = createStorageAdapter("local", "");
  await storage.remove(CACHE_KEY);
}

// ── Cache Helpers ─────────────────────────────────────────────────

async function getFromCache(
  address: string,
  chainId: number,
): Promise<TokenListEntry | null> {
  const storage = createStorageAdapter("local", "");
  try {
    const data = await storage.get<Record<string, CachedEntry>>(CACHE_KEY);
    if (!data) return null;

    const key = `${chainId}:${address.toLowerCase()}`;
    const entry = data[key];
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > DEFAULT_CACHE_TTL) {
      return null;
    }

    return entry.token;
  } catch {
    return null;
  }
}

async function saveToCache(token: TokenListEntry): Promise<void> {
  const storage = createStorageAdapter("local", "");
  try {
    const data =
      (await storage.get<Record<string, CachedEntry>>(CACHE_KEY)) ?? {};
    const key = `${token.chainId}:${token.address.toLowerCase()}`;
    data[key] = { token, timestamp: Date.now() };
    await storage.set(CACHE_KEY, data);
  } catch {
    // Non-fatal
  }
}

// ── RPC Helpers ───────────────────────────────────────────────────

async function ethCall(
  rpcUrl: string,
  to: `0x${string}`,
  data: `0x${string}`,
): Promise<string> {
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

  if (!res.ok) {
    throw new Error(`RPC call failed: HTTP ${res.status}`);
  }

  const json: any = await res.json();
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`);
  }

  return json.result as string;
}

function decodeString(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;

  // ABI-encoded string: offset (32 bytes) + length (32 bytes) + data
  if (clean.length < 128) {
    // Try raw bytes decoding as fallback
    try {
      const bytes = Buffer.from(clean, "hex");
      return new TextDecoder().decode(bytes).replace(/\0/g, "");
    } catch {
      return "";
    }
  }

  const lengthHex = clean.slice(64, 128);
  const length = parseInt(lengthHex, 16);
  if (length <= 0 || length * 2 > clean.length - 128) return "";

  const dataHex = clean.slice(128, 128 + length * 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function decodeUint8(hex: string): number {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return parseInt(clean || "0", 16);
}
