/**
 * Transaction Monitoring Types
 *
 * Lifecycle states:
 *   unknown → pending → mined → confirmed  (happy path)
 *   pending → failed  (revert / drop / timeout)
 *   mined/confirmed → pending  (reorg)
 */

export type TxStatus = "pending" | "mined" | "confirmed" | "failed" | "unknown";

export interface TxStatusEntry {
  hash: string;
  chainId: number;
  from: string;
  to: string;
  value: string; // wei hex string
  data?: string;
  nonce?: number;
  status: TxStatus;
  blockNumber?: number;
  blockHash?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  createdAt: number; // unix ms
  confirmedAt?: number; // unix ms
  updatedAt: number; // unix ms
  error?: string;

  // reorg tracking
  replacedBy?: string; // if replaced, record new hash
  replacementCount: number; // times replaced

  // metadata
  label?: string;
  memo?: string;
}

export type ProviderLike = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export interface WatchTxOptions {
  requiredConfirmations?: number;
  pollInterval?: number;
  label?: string;
  memo?: string;
  /** Initial data if known before watching */
  initialEntry?: Partial<TxStatusEntry>;
}

export interface TxHistoryQuery {
  address?: string;
  chainId?: number;
  status?: TxStatus;
  limit?: number;
  offset?: number;
  fromDate?: number;
  toDate?: number;
}

export interface BackoffConfig {
  initialDelay: number; // 2000ms
  maxDelay: number; // 30000ms
  multiplier: number; // 2
}

/** Internal watch entry for in-memory tracking */
export interface WatchEntry {
  hash: string;
  chainId: number;
  options: Required<WatchTxOptions>;
  pollTimer?: ReturnType<typeof setInterval>;
  backoffCount: number;
  lastPollAt: number;
  consecutiveStable: number; // consecutive same block hash (for reorg stability)
}
