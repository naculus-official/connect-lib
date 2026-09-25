import { WalletError } from "../errors";
import type {
  Eip7702AuthorizationOptions,
  Eip7702AuthorizationRequest,
  SignedEip7702Authorization,
  Signer,
  SignRequest,
  SignResult,
  TransactionRequest,
} from "./types";

type WorkerMessage = {
  type: "ready" | "signed" | "signedAuthorization" | "cleared" | "error";
  signature?: string;
  recovery?: number;
  authorization?: SignedEip7702Authorization;
  error?: string;
};

function createWorkerBlob(): Worker {
  if (typeof Worker === "undefined") {
    throw new WalletError(
      "worker_error",
      "Web Workers are unavailable in this runtime.",
    );
  }
  try {
    // The literal `new Worker(new URL("./x.js", import.meta.url), { type })`
    // shape must stay inline at the construction site. Vite/Rollup/webpack
    // only rewrite the path and emit the worker asset when they can see this
    // exact form; hoisting the URL into a helper defeats the static analysis,
    // the asset is never emitted, and the worker 404s out of .vite/deps.
    //
    // Deliberately no document.baseURI fallback: this worker receives the
    // wallet password and the decrypted private key, so its source must never
    // be resolved against a location the host page controls. If the URL cannot
    // be derived from the module itself, fail closed.
    return new Worker(new URL("./crypto-worker.js", import.meta.url), {
      type: "module",
      name: "naculus-crypto-worker",
    });
  } catch (err) {
    throw new WalletError(
      "worker_error",
      "Crypto worker could not be constructed. Isolated signing requires the " +
        "ESM entry (`import`) so the bundler emits dist/crypto-worker.js; the " +
        "CJS (`require`) entry cannot resolve it. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function expectedWorkerAsset(): string {
  try {
    return new URL("./crypto-worker.js", import.meta.url).href;
  } catch {
    return "./crypto-worker.js";
  }
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
   * Centralized because the two entry points had drifted: `init` registered
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
            `Expected asset at ${expectedWorkerAsset()}`,
        ),
      );
    };

    worker.onmessageerror = () => {
      this.failAll(
        new WalletError(
          "worker_error",
          "Crypto worker sent a message that could not be deserialized",
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
    // personal_sign hashes the message itself; do not invent a chain context
    // when callers did not provide one (chain IDs belong to transactions and
    // typed-data domains, not to the EIP-191 message digest).
    return this.send("signMessage", { message: req.message });
  }

  async signTransaction(
    tx: TransactionRequest,
    _privateKey?: `0x${string}`,
  ): Promise<SignResult> {
    if (!this.worker)
      throw new WalletError("not_initialized", "Signer not initialized");
    return this.send("signTransaction", tx);
  }

  /**
   * Sign EIP-712 typed data (JSON-stringified) inside the worker. The worker
   * computes the digest with the same encoder EVMSigner uses.
   */
  async signTypedData(
    typedData: string,
    _privateKey?: `0x${string}`,
  ): Promise<SignResult> {
    if (!this.worker)
      throw new WalletError("not_initialized", "Signer not initialized");
    return this.send("signTypedData", { typedData });
  }

  /**
   * Sign an EIP-7702 authorization inside the worker; the key never crosses
   * back. Validation (including the `chainId: 0` refusal) runs in the worker
   * on the same encoder EVMSigner uses.
   */
  async signAuthorization(
    auth: Eip7702AuthorizationRequest,
    _privateKey?: `0x${string}`,
    options?: Eip7702AuthorizationOptions,
  ): Promise<SignedEip7702Authorization> {
    if (!this.worker)
      throw new WalletError("not_initialized", "Signer not initialized");
    return this.send("signAuthorization", { authorization: auth, options });
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
    else if (msg.type === "signedAuthorization" && entry)
      entry.resolve(msg.authorization);
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
