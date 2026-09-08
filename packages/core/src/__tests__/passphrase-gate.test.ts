/// <reference types="vitest" />
import { describe, expect, it, vi } from "vitest";
import { PassphraseCancelledError, PassphraseGate } from "../passphrase-gate";

describe("PassphraseGate", () => {
  it("resolves the storage callback with what the dialog submits", async () => {
    const gate = new PassphraseGate();
    const asked = gate.request();
    gate.submit("open sesame");
    await expect(asked).resolves.toBe("open sesame");
  });

  it("raises exactly one prompt for concurrent asks", async () => {
    const gate = new PassphraseGate();
    const seen: unknown[] = [];
    gate.subscribe(() => seen.push(gate.getSnapshot()));

    const a = gate.request();
    const b = gate.request();
    expect(seen.filter(Boolean)).toHaveLength(1);

    gate.submit("one");
    await expect(a).resolves.toBe("one");
    await expect(b).resolves.toBe("one");
  });

  // Prompting on every save is how a user ends up turning encryption off.
  it("answers later asks from the session without prompting again", async () => {
    const gate = new PassphraseGate();
    const first = gate.request();
    gate.submit("held");
    await first;

    const listener = vi.fn();
    gate.subscribe(listener);
    await expect(gate.request()).resolves.toBe("held");
    expect(listener).not.toHaveBeenCalled();
    expect(gate.getSnapshot()).toBeNull();
  });

  it("asks again after the passphrase is forgotten", async () => {
    const gate = new PassphraseGate();
    gate.submit("ignored"); // nothing pending
    const first = gate.request();
    gate.submit("held");
    await first;

    gate.forget();
    expect(gate.isUnlocked).toBe(false);
    const second = gate.request();
    expect(gate.getSnapshot()).not.toBeNull();
    gate.submit("again");
    await expect(second).resolves.toBe("again");
  });

  // A dialog that reappears with no explanation reads as a bug, and the user
  // retypes the same value.
  it("carries the reason the previous passphrase was discarded", async () => {
    const gate = new PassphraseGate();
    const first = gate.request();
    gate.submit("wrong");
    await first;

    gate.forget("That passphrase did not open the wallet.");
    gate.request();
    expect(gate.getSnapshot()?.previousError).toBe(
      "That passphrase did not open the wallet.",
    );
  });

  it("clears the previous error once an attempt succeeds", async () => {
    const gate = new PassphraseGate();
    gate.forget("nope");
    const first = gate.request();
    expect(gate.getSnapshot()?.previousError).toBe("nope");
    gate.submit("right");
    await first;
    gate.forget();
    gate.request();
    expect(gate.getSnapshot()?.previousError).toBeNull();
  });

  // Defaulting the other way would invite a user to invent a new passphrase
  // during an unlock and then be told it is wrong.
  it("defaults to asking for an existing passphrase", () => {
    const gate = new PassphraseGate();
    gate.request();
    expect(gate.getSnapshot()?.intent).toBe("unlock");
  });

  it("asks for a new passphrase when told to expect one", () => {
    const gate = new PassphraseGate();
    gate.expect("create");
    gate.request();
    expect(gate.getSnapshot()?.intent).toBe("create");
  });

  it("does not swap the question under an open prompt", () => {
    const gate = new PassphraseGate();
    gate.request();
    gate.expect("create");
    expect(gate.getSnapshot()?.intent).toBe("unlock");
  });

  // The load or save that asked has to fail: there is nothing to show without
  // a passphrase, and a silent success would write something unreadable.
  it("rejects the pending operation when cancelled", async () => {
    const gate = new PassphraseGate();
    const asked = gate.request();
    gate.cancel();
    await expect(asked).rejects.toBeInstanceOf(PassphraseCancelledError);
    expect(gate.getSnapshot()).toBeNull();
  });

  it("ignores a cancel when nothing is pending", () => {
    const gate = new PassphraseGate();
    expect(() => gate.cancel()).not.toThrow();
  });

  it("survives being detached from the instance", async () => {
    const gate = new PassphraseGate();
    const { request } = gate;
    const asked = request();
    gate.submit("detached");
    await expect(asked).resolves.toBe("detached");
  });

  it("holds a stable snapshot reference between changes", () => {
    const gate = new PassphraseGate();
    gate.request();
    expect(gate.getSnapshot()).toBe(gate.getSnapshot());
  });

  it("stops notifying after unsubscribe", () => {
    const gate = new PassphraseGate();
    const listener = vi.fn();
    const off = gate.subscribe(listener);
    off();
    gate.request();
    expect(listener).not.toHaveBeenCalled();
  });
});
