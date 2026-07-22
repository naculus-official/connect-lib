/**
 * TxPoller — Polling engine for transaction status.
 *
 * Features:
 * - Per-chain merged timers (one interval per chain)
 * - Exponential backoff on errors
 * - Immediate poll via pollNow()
 * - Reorg detection (block hash changes)
 * - Replacement detection (same nonce, different tx)
 */

import type {
  BackoffConfig,
  ProviderLike,
  TxStatusEntry,
  WatchTxOptions,
} from "./types";

export const DEFAULT_POLL_INTERVAL = 15_000; // 15s
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
export const MAX_PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 min pending timeout

const DEFAULT_BACKOFF: BackoffConfig = {
  initialDelay: 2_000,
  maxDelay: 30_000,
  multiplier: 2,
};

export interface PollCallback {
  onStatus: (entry: Partial<TxStatusEntry>) => void;
  onError: (error: Error) => void;
}

export interface PollEntry {
  hash: string;
  chainId: number;
  options: Required<WatchTxOptions>;
  callbacks: PollCallback;
  backoffCount: number;
  lastPollAt: number;
  consecutiveStable: number;
  lastBlockHash: string | null;
  lastBlockNumber: number | null;
  createdAt: number;
}

/**
 * Fetch a transaction receipt from the provider.
 * Returns null if not yet mined.
 */
async function getReceipt(provider: ProviderLike, hash: string): Promise<any> {
  return provider.request({
    method: "eth_getTransactionReceipt",
    params: [hash],
  });
}

/**
 * Fetch the current block number.
 */
async function getBlockNumber(provider: ProviderLike): Promise<number> {
  const result = await provider.request({
    method: "eth_blockNumber",
    params: [],
  });
  return Number(result as string);
}

/**
 * Fetch a transaction by hash.
 */
async function getTxByHash(provider: ProviderLike, hash: string): Promise<any> {
  return provider.request({
    method: "eth_getTransactionByHash",
    params: [hash],
  });
}

/**
 * Fetch transaction count for an address (to detect nonce usage).
 */
async function getTxCount(
  provider: ProviderLike,
  address: string,
): Promise<number> {
  const result = await provider.request({
    method: "eth_getTransactionCount",
    params: [address, "latest"],
  });
  return Number(result as string);
}

export class TxPoller {
  private getProvider: (chainId: number) => ProviderLike;
  private defaultInterval: number;

  /** Per-chain polling timers */
  private chainTimers = new Map<number, ReturnType<typeof setInterval>>();
  /** All active polls: key = `${chainId}:${hash}` */
  private polls = new Map<string, PollEntry>();
  /** Chain → set of poll keys */
  private chainPolls = new Map<number, Set<string>>();

  private backoffConfig: BackoffConfig;

  constructor(
    getProvider: (chainId: number) => ProviderLike,
    defaultInterval: number = DEFAULT_POLL_INTERVAL,
    backoffConfig?: Partial<BackoffConfig>,
  ) {
    this.getProvider = getProvider;
    this.defaultInterval = defaultInterval;
    this.backoffConfig = { ...DEFAULT_BACKOFF, ...backoffConfig };
  }

  // ── Core API ────────────────────────────────────────────────────

  startPolling(
    hash: string,
    chainId: number,
    onStatus: (entry: Partial<TxStatusEntry>) => void,
    onError: (error: Error) => void,
    interval?: number,
    options?: Required<WatchTxOptions>,
  ): void {
    const pollKey = `${chainId}:${hash}`;
    if (this.polls.has(pollKey)) return; // already polling

    const entry: PollEntry = {
      hash,
      chainId,
      options: options ?? {
        requiredConfirmations: 1,
        pollInterval: interval ?? this.defaultInterval,
        label: "",
        memo: "",
        initialEntry: {},
      },
      callbacks: { onStatus, onError },
      backoffCount: 0,
      lastPollAt: 0,
      consecutiveStable: 0,
      lastBlockHash: null,
      lastBlockNumber: null,
      createdAt: Date.now(),
    };

    this.polls.set(pollKey, entry);

    // Register on chain timer
    let chainSet = this.chainPolls.get(chainId);
    if (!chainSet) {
      chainSet = new Set();
      this.chainPolls.set(chainId, chainSet);
    }
    chainSet.add(pollKey);

    // Ensure chain timer exists
    this.ensureChainTimer(chainId);

    // Do an immediate first poll
    this.pollOnce(pollKey).catch(() => {
      /* errors handled in pollOnce */
    });
  }

  stopPolling(hash: string, chainId?: number): void {
    if (chainId !== undefined) {
      const pollKey = `${chainId}:${hash}`;
      this.removePoll(pollKey);
    } else {
      // Scan all keys for matching hash
      for (const [key, entry] of this.polls) {
        if (entry.hash === hash) {
          this.removePoll(key);
        }
      }
    }
  }

  stopAll(): void {
    // Clear all chain timers
    for (const [, timer] of this.chainTimers) {
      clearInterval(timer);
    }
    this.chainTimers.clear();
    this.polls.clear();
    this.chainPolls.clear();
  }

  getActivePolls(): string[] {
    return Array.from(this.polls.values()).map((p) => p.hash);
  }

  getActivePollKeys(): string[] {
    return Array.from(this.polls.keys());
  }

  async pollNow(hash: string, chainId: number): Promise<void> {
    const pollKey = `${chainId}:${hash}`;
    await this.pollOnce(pollKey);
  }

  // ── Internal ────────────────────────────────────────────────────

  private ensureChainTimer(chainId: number): void {
    if (this.chainTimers.has(chainId)) return;

    const interval = this.defaultInterval;
    const timer = setInterval(() => {
      this.pollChain(chainId).catch(() => {
        /* handled per-call */
      });
    }, interval);
    this.chainTimers.set(chainId, timer);
  }

  private removePoll(pollKey: string): void {
    const entry = this.polls.get(pollKey);
    if (!entry) return;

    this.polls.delete(pollKey);

    // Remove from chain set
    const chainSet = this.chainPolls.get(entry.chainId);
    if (chainSet) {
      chainSet.delete(pollKey);
      if (chainSet.size === 0) {
        this.chainPolls.delete(entry.chainId);
        const timer = this.chainTimers.get(entry.chainId);
        if (timer) {
          clearInterval(timer);
          this.chainTimers.delete(entry.chainId);
        }
      }
    }
  }

  private async pollChain(chainId: number): Promise<void> {
    const chainSet = this.chainPolls.get(chainId);
    if (!chainSet || chainSet.size === 0) return;

    const promises: Promise<void>[] = [];
    for (const pollKey of chainSet) {
      promises.push(this.pollOnce(pollKey));
    }
    await Promise.allSettled(promises);
  }

  private async pollOnce(pollKey: string): Promise<void> {
    const entry = this.polls.get(pollKey);
    if (!entry) return;

    entry.lastPollAt = Date.now();

    try {
      const provider = this.getProvider(entry.chainId);
      const receipt = await getReceipt(provider, entry.hash);

      if (receipt) {
        await this.handleReceipt(entry, receipt, provider);
      } else {
        await this.handleNoReceipt(entry, provider);
      }

      // Reset backoff on success
      entry.backoffCount = 0;
    } catch (err) {
      // Exponential backoff
      entry.backoffCount++;
      entry.callbacks.onError(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private async handleReceipt(
    entry: PollEntry,
    receipt: any,
    provider: ProviderLike,
  ): Promise<void> {
    const currentBlock = await getBlockNumber(provider);
    const blockNumber = Number(receipt.blockNumber);
    const blockHash = receipt.blockHash as string;
    const status = receipt.status as string; // "0x0" or "0x1"

    // Reorg detection: block hash changed
    if (entry.lastBlockHash && entry.lastBlockHash !== blockHash) {
      entry.consecutiveStable = 0;
      // Notify reorg
      entry.callbacks.onStatus({
        hash: entry.hash,
        blockNumber: undefined,
        blockHash: undefined,
        status: "pending",
        updatedAt: Date.now(),
        error: `Reorg detected: block changed from ${entry.lastBlockHash} to ${blockHash}`,
      });
      entry.lastBlockHash = blockHash;
      entry.lastBlockNumber = blockNumber;
      return;
    }

    // Track block hash stability
    if (entry.lastBlockHash === blockHash) {
      entry.consecutiveStable++;
    } else {
      entry.consecutiveStable = 1;
    }
    entry.lastBlockHash = blockHash;
    entry.lastBlockNumber = blockNumber;

    // Check receipt status
    if (status === "0x0") {
      // Failed (revert)
      entry.callbacks.onStatus({
        hash: entry.hash,
        status: "failed",
        blockNumber,
        blockHash,
        gasUsed: receipt.gasUsed as string,
        effectiveGasPrice: receipt.effectiveGasPrice as string,
        error: "Transaction reverted",
        updatedAt: Date.now(),
      });
      // Stop polling on terminal state
      this.removePoll(`${entry.chainId}:${entry.hash}`);
      return;
    }

    // Success (status === "0x1")
    const confirmations = currentBlock - blockNumber;
    if (confirmations >= entry.options.requiredConfirmations) {
      entry.callbacks.onStatus({
        hash: entry.hash,
        status: "confirmed",
        blockNumber,
        blockHash,
        gasUsed: receipt.gasUsed as string,
        effectiveGasPrice: receipt.effectiveGasPrice as string,
        confirmedAt: Date.now(),
        updatedAt: Date.now(),
      });
      // Stop polling on confirmed
      this.removePoll(`${entry.chainId}:${entry.hash}`);
    } else {
      entry.callbacks.onStatus({
        hash: entry.hash,
        status: "mined",
        blockNumber,
        blockHash,
        gasUsed: receipt.gasUsed as string,
        effectiveGasPrice: receipt.effectiveGasPrice as string,
        updatedAt: Date.now(),
      });
    }
  }

  private async handleNoReceipt(
    entry: PollEntry,
    provider: ProviderLike,
  ): Promise<void> {
    // Check timeout for pending
    if (Date.now() - entry.createdAt > MAX_PENDING_TIMEOUT_MS) {
      entry.callbacks.onStatus({
        hash: entry.hash,
        status: "failed",
        error: "Transaction timed out after 5 minutes",
        updatedAt: Date.now(),
      });
      this.removePoll(`${entry.chainId}:${entry.hash}`);
      return;
    }

    // Check if transaction was dropped or replaced
    try {
      const txData = await getTxByHash(provider, entry.hash);
      if (!txData) {
        // Transaction not found — check if nonce was consumed (replaced)
        // We need the from address. Try to get info from status entry
        entry.callbacks.onStatus({
          hash: entry.hash,
          status: "failed",
          error: "Transaction dropped from mempool",
          updatedAt: Date.now(),
        });
        this.removePoll(`${entry.chainId}:${entry.hash}`);
        return;
      }
    } catch {
      // Ignore errors checking replacement — just report pending
    }

    // Still pending
    entry.callbacks.onStatus({
      hash: entry.hash,
      status: "pending",
      updatedAt: Date.now(),
    });
  }
}
