/**
 * A bridge between a storage adapter that asks for a passphrase and a UI that
 * has to ask a human for it.
 *
 * `PocketWallet` takes `encryptionPassphrase: () => Promise<string>`, and it
 * calls that on every load and every save — before React has rendered
 * anything, from inside code that knows nothing about components. A dialog
 * cannot be that callback directly.
 *
 * This is: the callback resolves a promise that a dialog fulfils. Nothing here
 * is React-specific, so a Vue or Web Component wrapper can drive the same
 * object.
 */

export type PassphraseIntent = "create" | "unlock";

export interface PassphraseRequest {
  /**
   * Which question to ask. Getting this wrong is not cosmetic: showing "choose
   * a passphrase" during an unlock invites the user to invent a new one, watch
   * it fail, and conclude the wallet is broken. Defaults to `"unlock"` for
   * that reason — the opposite mistake is merely confusing.
   */
  intent: PassphraseIntent;
  /**
   * Why the last passphrase was discarded, when one was. Null on a first ask.
   * A dialog that reappears with no explanation reads as a bug.
   */
  previousError: string | null;
}

export class PassphraseCancelledError extends Error {
  readonly code = "passphrase_cancelled";
  constructor(message = "Passphrase entry was cancelled") {
    super(message);
    this.name = "PassphraseCancelledError";
  }
}

export class PassphraseGate {
  private cached: string | null = null;
  private pending: {
    promise: Promise<string>;
    resolve: (value: string) => void;
    reject: (reason: unknown) => void;
  } | null = null;
  private intent: PassphraseIntent = "unlock";
  private previousError: string | null = null;
  private listeners = new Set<() => void>();
  /** Held so `useSyncExternalStore` sees a stable reference between changes. */
  private snapshot: PassphraseRequest | null = null;

  /**
   * Pass this as `encryptionPassphrase`.
   *
   * Bound as a field so it survives being detached from the
   * instance, which is exactly what handing it to a config object does.
   */
  readonly request = (): Promise<string> => {
    // Held for the session after the first success. Without it every wallet
    // mutation raises a prompt, and a wallet that asks for a passphrase on
    // each save is one the user turns encryption off for. It is no more
    // exposed than the decrypted wallet already sitting in memory beside it.
    if (this.cached !== null) return Promise.resolve(this.cached);

    // Concurrent loads and saves both land here. They must share one prompt,
    // not stack two dialogs asking the same question.
    if (this.pending) return this.pending.promise;

    let resolve!: (value: string) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pending = { promise, resolve, reject };
    this.publish({ intent: this.intent, previousError: this.previousError });
    return promise;
  };

  /**
   * Declare what the next prompt is for.
   *
   * Called before the operation that triggers it — `expect("create")` then
   * `generateWallet()`. A request already on screen is left alone rather than
   * swapped underneath the user mid-typing.
   */
  expect(intent: PassphraseIntent): void {
    this.intent = intent;
  }

  /** Answer the open request. Ignored when nothing is pending, so a
   *  double-submit does not resolve a later, unrelated prompt. */
  submit(passphrase: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.cached = passphrase;
    this.previousError = null;
    this.pending = null;
    this.publish(null);
    pending.resolve(passphrase);
  }

  /**
   * Abandon the open request.
   *
   * The rejection travels back through the storage adapter, so the load or
   * save that asked fails. That is the correct outcome: there is no wallet to
   * show without it, and a silent success would mean writing something that
   * cannot be read back.
   */
  cancel(reason?: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.publish(null);
    pending.reject(new PassphraseCancelledError(reason));
  }

  /**
   * Drop the cached passphrase.
   *
   * Two uses, and both matter. After a failed decrypt, because otherwise every
   * retry re-submits the same wrong value and the user is told their
   * passphrase is wrong while never being asked for a different one. And to
   * lock the wallet, which is the only thing that makes "lock" mean anything
   * while the tab stays open.
   */
  forget(reason?: string): void {
    this.cached = null;
    this.previousError = reason ?? null;
  }

  /** Whether a passphrase is held for this session. */
  get isUnlocked(): boolean {
    return this.cached !== null;
  }

  // ── External store ──────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The open request, or null when nothing is being asked. */
  getSnapshot = (): PassphraseRequest | null => this.snapshot;

  private publish(next: PassphraseRequest | null): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
