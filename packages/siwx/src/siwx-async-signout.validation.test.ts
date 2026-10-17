/**
 * Validation for siwx/session/async-completion-after-invalidation
 * (NEEDS-VALIDATION.md run2, line 415). Run without OS sandbox: in-process,
 * no network, dummy signer returning strings, memory storage only.
 *
 * Each case holds one asynchronous step (signer, storage.get or storage.set)
 * open across a newer lifecycle decision (signOut or a newer signIn), then
 * releases it. Safe behavior: the obsolete operation neither persists nor
 * publishes its identity. Kept as regression tests for the lifecycle
 * generation check in session.ts (these cases failed before that fix). This is local client lifecycle behavior only; any
 * impact on a consuming application's authority decision is not shown here.
 */
import { describe, expect, it } from "vitest";
import {
  createMemorySiwxSessionStorage,
  SiwxSessionManager,
  type SiwxSession,
  type SiwxSessionStorage,
} from "./index";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

function signInParams(address: string, nonce: string) {
  return {
    chainId: "eip155:1",
    address,
    domain: "audit.invalid",
    uri: "https://audit.invalid/login",
    nonce,
    expirySeconds: 0,
  };
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredSignal = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { release, entered, released, enteredSignal };
}

/** A manager whose next signer call (after `arm`) waits for release. */
function fixture(
  storage: SiwxSessionStorage = createMemorySiwxSessionStorage("audit-siwx"),
) {
  let armed: ReturnType<typeof gate> | null = null;
  const manager = new SiwxSessionManager({
    storage,
    defaultExpirySeconds: 0,
    signMessage: async ({ address }) => {
      const held = armed;
      armed = null;
      if (held) {
        held.entered();
        await held.released;
        return `dummy-held-${address}`;
      }
      return `dummy-${address}`;
    },
  });
  const events: (string | null)[] = [];
  manager.onSessionChange((session) => {
    events.push(session ? session.address : null);
  });
  return {
    manager,
    storage,
    events,
    arm() {
      armed = gate();
      return armed;
    },
  };
}

/** Non-null events published after the last null (sign-out) event. */
function afterSignOut(events: (string | null)[]): (string | null)[] {
  return events.slice(events.lastIndexOf(null) + 1);
}

describe("validation: siwx/session/async-completion-after-invalidation", () => {
  // siwx/session/async-completion-after-invalidation: refresh commits after
  // its signer resolves without checking an intervening signOut.
  it("a refresh pending across signOut does not republish or persist A", async () => {
    const f = fixture();
    await f.manager.signIn(signInParams(A, "auditNonceA123"));
    const held = f.arm();
    const refresh = f.manager.refresh({ expirySeconds: 0 });
    await held.enteredSignal;
    await f.manager.signOut();
    expect(f.manager.getSession()).toBeNull();
    expect(await f.storage.get()).toBeNull();
    expect(f.events.at(-1)).toBeNull();

    held.release();
    await Promise.allSettled([refresh]);
    expect(f.manager.getSession()).toBeNull();
    expect(await f.storage.get()).toBeNull();
    expect(afterSignOut(f.events)).toEqual([]);
  });

  // siwx/session/async-completion-after-invalidation: a stale refresh of A
  // overwrites a newer completed signIn for B.
  it("a refresh of A pending across a newer signIn for B does not replace B", async () => {
    const f = fixture();
    await f.manager.signIn(signInParams(A, "auditNonceA123"));
    const held = f.arm();
    const refresh = f.manager.refresh({ expirySeconds: 0 });
    await held.enteredSignal;
    const b = await f.manager.signIn(signInParams(B, "auditNonceB123"));

    held.release();
    await Promise.allSettled([refresh]);
    expect(f.manager.getSession()?.id).toBe(b.id);
    expect(f.manager.getSession()?.address).toBe(B);
    expect((await f.storage.get())?.address).toBe(B);
    expect(f.events.at(-1)).toBe(B);
  });

  // siwx/session/async-completion-after-invalidation: signIn commits after its
  // signer resolves without checking an intervening signOut.
  it("a signIn pending across signOut does not publish or persist", async () => {
    const f = fixture();
    const held = f.arm();
    const signIn = f.manager.signIn(signInParams(A, "auditNonceA123"));
    await held.enteredSignal;
    await f.manager.signOut();

    held.release();
    await Promise.allSettled([signIn]);
    expect(f.manager.getSession()).toBeNull();
    expect(await f.storage.get()).toBeNull();
    expect(afterSignOut(f.events)).toEqual([]);
  });

  // siwx/session/async-completion-after-invalidation: restore applies a
  // captured storage read after an intervening signOut (memory and events
  // only; restore does not call set).
  it("a restore whose read captured A before signOut does not republish A", async () => {
    const backing = createMemorySiwxSessionStorage("audit-siwx");
    let holdGet: ReturnType<typeof gate> | null = null;
    const storage: SiwxSessionStorage = {
      ...backing,
      async get() {
        const captured = await backing.get();
        const held = holdGet;
        holdGet = null;
        if (held) {
          held.entered();
          await held.released;
        }
        return captured;
      },
    };
    const f = fixture(storage);
    await f.manager.signIn(signInParams(A, "auditNonceA123"));
    const held = gate();
    holdGet = held;
    const restore = f.manager.restore();
    await held.enteredSignal;
    await f.manager.signOut();

    held.release();
    await Promise.allSettled([restore]);
    expect(await backing.get()).toBeNull();
    expect(f.manager.getSession()).toBeNull();
    expect(afterSignOut(f.events)).toEqual([]);
  });

  // siwx/session/async-completion-after-invalidation: a refresh write held
  // before the backing set lands after signOut's remove.
  it("a refresh storage write held across signOut does not persist A afterwards", async () => {
    const backing = createMemorySiwxSessionStorage("audit-siwx");
    let holdSet: ReturnType<typeof gate> | null = null;
    const storage: SiwxSessionStorage = {
      ...backing,
      async set(session: SiwxSession) {
        const held = holdSet;
        holdSet = null;
        if (held) {
          held.entered();
          await held.released;
        }
        await backing.set(session);
      },
    };
    const f = fixture(storage);
    await f.manager.signIn(signInParams(A, "auditNonceA123"));
    const held = gate();
    holdSet = held;
    const refresh = f.manager.refresh({ expirySeconds: 0 });
    await held.enteredSignal;
    await f.manager.signOut();
    expect(await backing.get()).toBeNull();

    held.release();
    await Promise.allSettled([refresh]);
    expect(await backing.get()).toBeNull();
    expect(f.manager.getSession()).toBeNull();
    expect(afterSignOut(f.events)).toEqual([]);
  });

  // A restore that finds storage empty (another tab signed out) clears the
  // session; a refresh of A pending on the signer must not write A back.
  it("a refresh pending across a restore that finds storage empty does not republish A", async () => {
    const f = fixture();
    await f.manager.signIn(signInParams(A, "auditNonceA123"));
    const held = f.arm();
    const refresh = f.manager.refresh({ expirySeconds: 0 });
    await held.enteredSignal;
    await f.storage.remove();
    expect(await f.manager.restore()).toBeNull();
    expect(f.events.at(-1)).toBeNull();

    held.release();
    const [result] = await Promise.allSettled([refresh]);
    expect(await f.storage.get()).toBeNull();
    expect(f.manager.getSession()).toBeNull();
    expect(afterSignOut(f.events)).toEqual([]);
    expect(result.status).toBe("rejected");
  });

  // A restore that loads B (another tab signed in as B) supersedes a refresh
  // of A pending on the signer: A must not overwrite B.
  it("a refresh of A pending across a restore that loads B does not replace B", async () => {
    const f = fixture();
    const other = fixture();
    await f.manager.signIn(signInParams(A, "auditNonceA123"));
    const b = await other.manager.signIn(signInParams(B, "auditNonceB123"));
    const held = f.arm();
    const refresh = f.manager.refresh({ expirySeconds: 0 });
    await held.enteredSignal;
    await f.storage.set(b);
    expect((await f.manager.restore())?.id).toBe(b.id);

    held.release();
    const [result] = await Promise.allSettled([refresh]);
    expect(result.status).toBe("rejected");
    expect(f.manager.getSession()?.id).toBe(b.id);
    expect((await f.storage.get())?.id).toBe(b.id);
    expect(f.events.at(-1)).toBe(B);
  });

  it("control: sequential signIn, refresh, signOut leaves nothing behind", async () => {
    const f = fixture();
    await f.manager.signIn(signInParams(A, "auditNonceA123"));
    await f.manager.refresh({ expirySeconds: 0 });
    await f.manager.signOut();
    expect(f.manager.getSession()).toBeNull();
    expect(await f.storage.get()).toBeNull();
    expect(f.events).toEqual([A, A, null]);
  });
});
