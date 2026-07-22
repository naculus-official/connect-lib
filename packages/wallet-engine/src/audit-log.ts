export type AuditEvent =
  | "wallet_generated"
  | "wallet_imported"
  | "wallet_loaded"
  | "wallet_cleared"
  | "wallet_wiped"
  | "message_signed"
  | "error"
  | "transaction_signed"
  | "transaction_sent"
  | "session_key_created"
  | "session_key_signed";

export interface AuditEntry {
  event: AuditEvent;
  timestamp: number;
  chainId?: string;
  address?: string;
  method?: string;
  txTo?: string;
  txValue?: string;
  error?: string;
}

export type AuditSink = (entry: AuditEntry) => void;

const noop: AuditSink = () => {};

export class AuditLogger {
  private sink: AuditSink;

  constructor(sink?: AuditSink) {
    this.sink = sink ?? noop;
  }

  setSink(sink: AuditSink): void {
    this.sink = sink;
  }

  log(entry: AuditEntry): void {
    this.sink(entry);
  }

  walletGenerated(address: string): void {
    this.log({ event: "wallet_generated", timestamp: Date.now(), address });
  }

  walletImported(address: string): void {
    this.log({ event: "wallet_imported", timestamp: Date.now(), address });
  }

  walletLoaded(address: string): void {
    this.log({ event: "wallet_loaded", timestamp: Date.now(), address });
  }

  walletCleared(): void {
    this.log({ event: "wallet_cleared", timestamp: Date.now() });
  }

  walletWiped(): void {
    this.log({ event: "wallet_wiped", timestamp: Date.now() });
  }

  messageSigned(address: string, chainId?: string): void {
    this.log({
      event: "message_signed",
      timestamp: Date.now(),
      address,
      chainId,
    });
  }

  transactionSigned(
    address: string,
    txTo: string,
    txValue?: string,
    chainId?: string,
  ): void {
    this.log({
      event: "transaction_signed",
      timestamp: Date.now(),
      address,
      txTo,
      txValue,
      chainId,
    });
  }

  transactionSent(
    address: string,
    txTo: string,
    txValue?: string,
    chainId?: string,
  ): void {
    this.log({
      event: "transaction_sent",
      timestamp: Date.now(),
      address,
      txTo,
      txValue,
      chainId,
    });
  }

  error(address: string | undefined, method: string, error: string): void {
    this.log({ event: "error", timestamp: Date.now(), address, method, error });
  }
}
