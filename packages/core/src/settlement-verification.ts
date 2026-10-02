import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import {
  parseSolanaTransaction,
  verifySolanaSignature,
} from "./solana-payment";

export interface SettlementRpc {
  request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
}

export type SettlementVerification =
  | { status: "verified"; blockNumber?: bigint; slot?: bigint }
  | { status: "pending" }
  | { status: "failed"; reason?: string }
  | { status: "mismatch"; reason: string }
  | { status: "unavailable"; reason: string };

export interface Eip3009SettlementExpected {
  chainId: string;
  txHash: string;
  token: string;
  from: string;
  to: string;
  amount: bigint | string;
  nonce: string;
  minConfirmations?: number;
}

export interface SolanaTransferSettlementExpected {
  cluster: string;
  signature: string;
  mint: string;
  payer: string;
  /** Address whose signature authorizes the transaction (delegate or payer). */
  signer: string;
  recipient: string;
  amount: bigint | string;
  signedMessageHash?: string;
  commitment?: "confirmed" | "finalized";
}

export interface ChannelSettlementExpected {
  cluster: string;
  channelId: string;
  channelProgram: string;
  expectedSettled: bigint | string;
  afterForcedClose?: boolean;
}

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

const lower = (value: string) => value.toLowerCase();
const wordAddress = (value: string) => `0x${value.slice(-40)}`.toLowerCase();
const hexBigInt = (value: unknown): bigint | null => {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

/** Verify a server-reported EIP-3009 settlement against its signed nonce. */
export async function verifyEip3009Settlement(
  rpc: SettlementRpc,
  expected: Eip3009SettlementExpected,
): Promise<SettlementVerification> {
  try {
    const reference = expected.chainId.match(/^eip155:([1-9][0-9]*|0)$/)?.[1];
    if (!reference)
      return { status: "mismatch", reason: "Expected chainId is not EIP-155." };
    const served = await rpc.request<string>("eth_chainId", []);
    if (hexBigInt(served) !== BigInt(reference))
      return { status: "mismatch", reason: "RPC serves another chain." };
    const receipt = await rpc.request<Record<string, unknown> | null>(
      "eth_getTransactionReceipt",
      [expected.txHash],
    );
    if (!receipt) return { status: "pending" };
    const status = hexBigInt(receipt.status);
    if (status === 0n)
      return { status: "failed", reason: "Transaction reverted." };
    if (status !== 1n)
      return { status: "mismatch", reason: "Receipt status is malformed." };
    const blockNumber = hexBigInt(receipt.blockNumber);
    if (blockNumber === null)
      return {
        status: "mismatch",
        reason: "Receipt block number is malformed.",
      };
    const latest = hexBigInt(await rpc.request<string>("eth_blockNumber", []));
    if (latest === null)
      return {
        status: "mismatch",
        reason: "Latest block number is malformed.",
      };
    const minimum = expected.minConfirmations ?? 1;
    if (!Number.isSafeInteger(minimum) || minimum < 1)
      return {
        status: "mismatch",
        reason: "minConfirmations must be positive.",
      };
    if (latest < blockNumber || latest - blockNumber + 1n < BigInt(minimum))
      return { status: "pending" };

    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    const token = lower(expected.token);
    const from = lower(expected.from);
    const to = lower(expected.to);
    const nonce = lower(expected.nonce);
    let transfer = false;
    let authorization = false;
    for (const candidate of logs) {
      if (!candidate || typeof candidate !== "object") continue;
      const log = candidate as {
        address?: unknown;
        topics?: unknown;
        data?: unknown;
      };
      if (typeof log.address !== "string" || lower(log.address) !== token)
        continue;
      if (
        !Array.isArray(log.topics) ||
        log.topics.some((t) => typeof t !== "string")
      )
        continue;
      const topics = log.topics as string[];
      if (
        lower(topics[0] ?? "") === TRANSFER_TOPIC &&
        topics.length >= 3 &&
        wordAddress(topics[1] as string) === from &&
        wordAddress(topics[2] as string) === to &&
        hexBigInt(log.data) === BigInt(expected.amount)
      )
        transfer = true;
      if (
        lower(topics[0] ?? "") === AUTHORIZATION_USED_TOPIC &&
        topics.length >= 3 &&
        wordAddress(topics[1] as string) === from &&
        lower(topics[2] as string) === nonce
      )
        authorization = true;
    }
    if (!transfer)
      return {
        status: "mismatch",
        reason: "Expected Transfer log was not emitted.",
      };
    if (!authorization)
      return {
        status: "mismatch",
        reason: "Expected AuthorizationUsed log was not emitted.",
      };
    return { status: "verified", blockNumber };
  } catch (cause) {
    return { status: "unavailable", reason: rpcReason(cause) };
  }
}

type TokenBalance = {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  uiTokenAmount?: { amount?: unknown };
};

function balanceMap(value: unknown, mint: string): Map<string, bigint> | null {
  if (!Array.isArray(value)) return null;
  const out = new Map<string, bigint>();
  for (const item of value as TokenBalance[]) {
    if (item?.mint !== mint || typeof item.owner !== "string") continue;
    const amount = item.uiTokenAmount?.amount;
    if (typeof amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(amount))
      return null;
    out.set(item.owner, (out.get(item.owner) ?? 0n) + BigInt(amount));
  }
  return out;
}

function hashHex(bytes: Uint8Array): string {
  return `0x${Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function rpcServesSolanaCluster(
  rpc: SettlementRpc,
  cluster: string,
): Promise<boolean> {
  const reference = cluster.match(/^solana:(.+)$/)?.[1];
  const served = await rpc.request<string>("getGenesisHash", []);
  return reference !== undefined && served.slice(0, 32) === reference;
}

/** SHA-256 of the exact Solana message bytes covered by its signatures. */
export function hashSolanaTransactionMessage(transaction: string): string {
  return hashHex(parseSolanaTransaction(base64.decode(transaction)).message);
}

/** Verify a Solana token transfer using exact owner balance deltas. */
export async function verifySolanaTransferSettlement(
  rpc: SettlementRpc,
  expected: SolanaTransferSettlementExpected,
): Promise<SettlementVerification> {
  try {
    if (!(await rpcServesSolanaCluster(rpc, expected.cluster)))
      return {
        status: "mismatch",
        reason: "RPC serves another Solana cluster.",
      };
    const commitment = expected.commitment ?? "confirmed";
    const tx = await rpc.request<Record<string, unknown> | null>(
      "getTransaction",
      [
        expected.signature,
        { encoding: "base64", commitment, maxSupportedTransactionVersion: 0 },
      ],
    );
    if (!tx) return { status: "pending" };
    const slot =
      typeof tx.slot === "number" && Number.isSafeInteger(tx.slot)
        ? BigInt(tx.slot)
        : null;
    if (slot === null)
      return { status: "mismatch", reason: "Transaction slot is malformed." };
    const meta = tx.meta as Record<string, unknown> | null;
    if (!meta)
      return { status: "mismatch", reason: "Transaction metadata is missing." };
    if (meta.err !== null)
      return { status: "failed", reason: "Transaction failed." };
    const pre = balanceMap(meta.preTokenBalances, expected.mint);
    const post = balanceMap(meta.postTokenBalances, expected.mint);
    if (!pre || !post)
      return { status: "mismatch", reason: "Token balances are malformed." };
    const amount = BigInt(expected.amount);
    const recipientDelta =
      (post.get(expected.recipient) ?? 0n) -
      (pre.get(expected.recipient) ?? 0n);
    const payerDelta =
      (pre.get(expected.payer) ?? 0n) - (post.get(expected.payer) ?? 0n);
    if (recipientDelta !== amount)
      return {
        status: "mismatch",
        reason: "Recipient token balance delta does not match.",
      };
    if (payerDelta < amount)
      return {
        status: "mismatch",
        reason: "Payer token balance did not fall enough.",
      };
    if (expected.signedMessageHash !== undefined) {
      const encoded = Array.isArray(tx.transaction) ? tx.transaction[0] : null;
      if (typeof encoded !== "string")
        return {
          status: "mismatch",
          reason: "Transaction wire bytes are missing.",
        };
      let actual: string;
      try {
        const parsed = parseSolanaTransaction(base64.decode(encoded));
        actual = hashHex(parsed.message);
        if (
          base58.encode(parsed.signatures[0] as Uint8Array) !==
            expected.signature ||
          !verifySolanaSignature(parsed, expected.signer)
        ) {
          return {
            status: "mismatch",
            reason:
              "Transaction does not contain the expected signer signature.",
          };
        }
      } catch {
        return {
          status: "mismatch",
          reason: "Transaction wire bytes are malformed.",
        };
      }
      if (lower(actual) !== lower(expected.signedMessageHash))
        return {
          status: "mismatch",
          reason: "Transaction message hash does not match.",
        };
    }
    return { status: "verified", slot };
  } catch (cause) {
    return { status: "unavailable", reason: rpcReason(cause) };
  }
}

/** Verify the final state of a Solana MPP payment channel account. */
export async function verifyChannelSettlement(
  rpc: SettlementRpc,
  expected: ChannelSettlementExpected,
): Promise<SettlementVerification> {
  try {
    if (!(await rpcServesSolanaCluster(rpc, expected.cluster)))
      return {
        status: "mismatch",
        reason: "RPC serves another Solana cluster.",
      };
    const response = await rpc.request<{
      context?: { slot?: number };
      value?: unknown;
    }>("getAccountInfo", [
      expected.channelId,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!response?.value)
      return {
        status: "unavailable",
        reason: "Channel account was reclaimed or is unavailable.",
      };
    const account = response.value as { owner?: unknown; data?: unknown };
    if (account.owner !== expected.channelProgram)
      return {
        status: "mismatch",
        reason: "Channel account owner does not match.",
      };
    const encoded = Array.isArray(account.data) ? account.data[0] : null;
    if (typeof encoded !== "string")
      return {
        status: "mismatch",
        reason: "Channel account data is malformed.",
      };
    const data = base64.decode(encoded);
    if (data.length < 52)
      return {
        status: "mismatch",
        reason: "Channel account data is too short.",
      };
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const status = data[3];
    const settled = view.getBigUint64(20, true);
    const expectedSettled = BigInt(expected.expectedSettled);
    if (!expected.afterForcedClose) {
      if (status !== 3) return { status: "pending" };
      if (settled !== expectedSettled)
        return {
          status: "mismatch",
          reason: "Channel settled amount does not match the last voucher.",
        };
    } else {
      if (status === 2) return { status: "pending" };
      if (status === 0)
        return {
          status: "mismatch",
          reason: "Forced-close channel is still open.",
        };
      if (status !== 1 && status !== 3)
        return { status: "mismatch", reason: "Channel status is malformed." };
      if (view.getBigInt64(44, true) === 0n) return { status: "pending" };
      if (settled > expectedSettled)
        return {
          status: "mismatch",
          reason: "Channel settled more than the last signed voucher.",
        };
    }
    const slot = response.context?.slot;
    return {
      status: "verified",
      ...(typeof slot === "number" && Number.isSafeInteger(slot)
        ? { slot: BigInt(slot) }
        : {}),
    };
  } catch (cause) {
    return { status: "unavailable", reason: rpcReason(cause) };
  }
}

function rpcReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : "RPC request failed.";
}
