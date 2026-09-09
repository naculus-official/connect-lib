/**
 * Solana JSON-RPC reads, with no framework import.
 *
 * Lives here rather than inside a React hook because logic that sits inside a
 * hook can only ever serve React. Everything below is callable from a Vue
 * composable, a Svelte store or a native binding unchanged — which is what
 * makes "write it once in React, ship it to Vue" true for the parts that are
 * not actually about React, and almost none of this is.
 */

import { logger } from "./logger";

/**
 * Protocol-defined, not a guess: a lamport is 1e-9 SOL, fixed by the runtime.
 * SPL token decimals are per-mint and must never be assumed the same way.
 */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export class SolanaRpcError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "SolanaRpcError";
    this.code = code;
  }
}

async function rpc<T>(
  endpoint: string,
  method: string,
  params: unknown[],
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new SolanaRpcError(
        `Solana RPC ${method} failed: HTTP ${res.status}`,
      );
    }
    const json = (await res.json()) as {
      result?: T;
      error?: { message?: string; code?: number };
    };
    if (json.error) {
      throw new SolanaRpcError(
        json.error.message ?? `Solana RPC ${method} failed`,
        json.error.code,
      );
    }
    if (json.result === undefined) {
      throw new SolanaRpcError(`Solana RPC ${method} returned no result`);
    }
    return json.result;
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new SolanaRpcError(
        `Solana RPC ${method} timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface SolanaBalance {
  /** Lamports. Integer arithmetic only — SOL amounts do not survive a float. */
  lamports: bigint;
  /** Decimal SOL for display, exact. */
  sol: string;
  /**
   * Whether this account exists on chain.
   *
   * An address with no account returns a zero balance, which reads
   * identically to a funded account that has been emptied. They are not the
   * same thing: one cannot receive a transfer without rent, the other can.
   */
  exists: boolean;
}

/** Exact lamports → SOL. No float: 0.1 SOL is not representable in binary
 *  floating point, and a balance that is off in the last digits is a balance
 *  a user will not trust again. */
export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const value = negative ? -lamports : lamports;
  const whole = value / LAMPORTS_PER_SOL;
  const fraction = (value % LAMPORTS_PER_SOL).toString().padStart(9, "0");
  const trimmed = fraction.replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`;
}

/** Exact SOL → lamports. Rejects more precision than a lamport rather than
 *  rounding a user's amount without telling them. */
export function parseSol(amount: string): bigint {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(amount.trim());
  if (!match || (!match[2] && !match[3])) {
    throw new SolanaRpcError(`Not a SOL amount: ${amount}`);
  }
  const [, sign, whole = "0", fraction = ""] = match;
  if (fraction.length > 9) {
    throw new SolanaRpcError(
      `${amount} is finer than one lamport (9 decimal places).`,
    );
  }
  const lamports =
    BigInt(whole || "0") * LAMPORTS_PER_SOL +
    BigInt(fraction.padEnd(9, "0") || "0");
  return sign === "-" ? -lamports : lamports;
}

export async function getSolanaBalance(
  endpoint: string,
  address: string,
): Promise<SolanaBalance> {
  const result = await rpc<{ value: number | null }>(
    endpoint,
    "getBalance",
    [address, { commitment: "confirmed" }],
  );
  // `getBalance` answers 0 for an address that has never been funded, so the
  // account has to be looked up separately to tell "empty" from "not there".
  const account = await rpc<{ value: unknown }>(
    endpoint,
    "getAccountInfo",
    [address, { commitment: "confirmed", encoding: "base64" }],
  ).catch((err) => {
    logger.warn("react/solana-rpc", "getAccountInfo failed", err);
    return { value: null };
  });

  const lamports = BigInt(result.value ?? 0);
  return {
    lamports,
    sol: formatSol(lamports),
    exists: account.value !== null,
  };
}

export async function getLatestBlockhash(
  endpoint: string,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const result = await rpc<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>(endpoint, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  return result.value;
}

export type SolanaConfirmationStatus =
  | "processed"
  | "confirmed"
  | "finalized"
  | "failed"
  | "unknown";

/**
 * The status of a submitted signature.
 *
 * `"unknown"` is its own answer. A signature the cluster has no record of may
 * be one that never landed, or one whose status has aged out of the node's
 * cache; reporting it as failed would tell a user their transfer did not
 * happen when it may well have.
 */
export async function getSignatureStatus(
  endpoint: string,
  signature: string,
): Promise<{ status: SolanaConfirmationStatus; error: string | null }> {
  const result = await rpc<{
    value: Array<{
      confirmationStatus?: string;
      err?: unknown;
    } | null>;
  }>(endpoint, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);

  const entry = result.value?.[0];
  if (!entry) return { status: "unknown", error: null };
  if (entry.err) {
    return { status: "failed", error: JSON.stringify(entry.err) };
  }
  const status = entry.confirmationStatus;
  if (status === "processed" || status === "confirmed" || status === "finalized") {
    return { status, error: null };
  }
  return { status: "unknown", error: null };
}
