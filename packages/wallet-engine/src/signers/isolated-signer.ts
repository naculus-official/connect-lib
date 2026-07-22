import { WalletError } from "../errors";
import type {
  Signer,
  SignRequest,
  SignResult,
  TransactionRequest,
} from "./types";

type WorkerMessage = {
  type: "ready" | "signed" | "cleared" | "error";
  signature?: string;
  recovery?: number;
  error?: string;
};

function createWorkerBlob(): Worker {
  const url = new URL("./crypto-worker.js", import.meta.url);
  return new Worker(url, { type: "module", name: "naculus-crypto-worker" });
}

export class IsolatedSigner implements Signer {
  readonly chainType = "eip155";
  private worker: Worker | null = null;
  private pending: Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }
  > = new Map();
  private seq = 0;

  async init(encrypted: any, passphrase: string): Promise<void> {
    this.terminate();
    const worker = createWorkerBlob();
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.onMessage(e);
    worker.onerror = (e) => {
      this.rejectAll(e);
    };
    return this.send("init", { encrypted, passphrase });
  }

  async initWithKey(privateKey: string): Promise<void> {
    this.terminate();
    const worker = createWorkerBlob();
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.onMessage(e);
    return this.send("initWithKey", { privateKey });
  }

  async signMessage(
    req: SignRequest,
    _privateKey?: `0x${string}`,
  ): Promise<SignResult> {
    if (!this.worker)
      throw new WalletError("not_initialized", "Signer not initialized");
    return this.send("signMessage", {
      message: req.message,
      chainId: req.chainId ?? "eip155:1",
    });
  }

  async signTransaction(
    tx: TransactionRequest,
    _privateKey?: `0x${string}`,
  ): Promise<SignResult> {
    if (!this.worker)
      throw new WalletError("not_initialized", "Signer not initialized");
    return this.send("signTransaction", tx);
  }

  async clear(): Promise<void> {
    if (this.worker) {
      await this.send("clear", {});
      this.terminate();
    }
  }

  private terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new WalletError("terminated", "Worker terminated"));
    }
    this.pending.clear();
  }

  private send(type: string, payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new WalletError("not_initialized", "Worker not available"));
        return;
      }
      const id = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WalletError("timeout", "Crypto worker timed out"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type, payload, id });
    });
  }

  private onMessage(e: MessageEvent<WorkerMessage & { id?: string }>): void {
    const { id, ...msg } = e.data;
    const entry = id ? this.pending.get(id) : undefined;
    if (entry && id !== undefined) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }
    if (msg.type === "ready" && entry) entry.resolve(undefined);
    else if (msg.type === "cleared" && entry) entry.resolve(undefined);
    else if (msg.type === "signed" && entry)
      entry.resolve({ signature: msg.signature, recovery: msg.recovery });
    else if (msg.type === "error") {
      const err = new WalletError(
        "crypto_worker_error",
        msg.error ?? "Unknown worker error",
      );
      if (entry) entry.reject(err);
    }
  }

  private rejectAll(e: ErrorEvent): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new WalletError("worker_error", e.message));
    }
    this.pending.clear();
  }
}
