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

  /**
   * Build a worker with every failure channel wired up.
   *
   * Centralised because the two entry points had drifted: `init` registered
   * `onerror` and `initWithKey` did not, so a worker that failed to load left
   * `initWithKey` waiting out the full 30s timeout with nothing to diagnose.
   */
  private spawnWorker(): Worker {
    const worker = createWorkerBlob();
    this.worker = worker;

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.onMessage(e);

    worker.onerror = (e) => {
      this.failAll(
        new WalletError(
          "worker_error",
          `Crypto worker failed to load (${e.message || "no detail"}). ` +
            `Expected asset at ${new URL("./crypto-worker.js", import.meta.url).href}`,
        ),
      );
    };

    worker.onmessageerror = () => {
      this.failAll(
        new WalletError(
          "worker_error",
          "Crypto worker sent a message that could not be deserialised",
        ),
      );
    };

    return worker;
  }

  async init(encrypted: any, passphrase: string): Promise<void> {
    this.terminate();
    this.spawnWorker();
    return this.send("init", { encrypted, passphrase });
  }

  async initWithKey(privateKey: string): Promise<void> {
    this.terminate();
    this.spawnWorker();
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

    if (id === undefined) {
      // A reply with no id cannot be matched to a caller. Reporting it beats
      // dropping it: an ignored reply is indistinguishable from no reply, so
      // every pending call would sit until the 30s timeout with nothing to
      // point at.
      this.failAll(
        new WalletError(
          "crypto_worker_error",
          `Crypto worker reply omitted the request id (missing request id on reply type "${String(msg.type)}")`,
        ),
      );
      return;
    }

    const entry = this.pending.get(id);
    if (entry) {
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

  /** Reject every in-flight call with an already-diagnosed error. */
  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
