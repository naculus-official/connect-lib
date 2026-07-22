/**
 * @naculus/wallet-engine — Transaction Monitor
 *
 * EVM transaction lifecycle monitoring, history, and React hooks.
 */

export { TxPoller } from "./poller";
export type { HistoryStorage } from "./TxHistoryStore";
export { MemoryHistoryStorage, TxHistoryStore } from "./TxHistoryStore";
export { TxMonitor, type TxMonitorOptions } from "./TxMonitor";

export type {
  BackoffConfig,
  ProviderLike,
  TxHistoryQuery,
  TxStatus,
  TxStatusEntry,
  WatchEntry,
  WatchTxOptions,
} from "./types";
