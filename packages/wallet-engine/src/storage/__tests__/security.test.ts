import { describe, expect, it } from "vitest";
import { assessStorageSecurity } from "../security";
import type { StorageSecurityInput } from "../security";

function ids(input: StorageSecurityInput): string[] {
  return assessStorageSecurity(input).findings.map((f) => f.id);
}

const bestCase: StorageSecurityInput = {
  level: 1,
  backend: "indexedDb",
  encrypted: true,
  unlock: { prf: "available", sealedWith: ["prf", "passphrase"] },
};

describe("assessStorageSecurity", () => {
  it("names the passphrase wrap as the reason the best case is not 100", () => {
    const report = assessStorageSecurity(bestCase);
    expect(report.score).toBe(95);
    expect(ids(bestCase)).toContain("passphrase-recovery-retained");
    const finding = report.findings.find(
      (f) => f.id === "passphrase-recovery-retained",
    );
    expect(finding?.deduction).toBe(5);
    expect(finding?.severity).toBe("info");
  });

  it("always explains the hot-wallet exposure without scoring it", () => {
    const report = assessStorageSecurity(bestCase);
    const hot = report.findings.find(
      (f) => f.id === "hot-wallet-signing-exposure",
    );
    expect(hot).toBeDefined();
    expect(hot?.deduction).toBe(0);
  });

  // The distinction the whole unlock layer rests on: not having asked the
  // authenticator is not the same answer as the authenticator saying no.
  it("distinguishes not-yet-checked from cannot", () => {
    const unknown = ids({
      ...bestCase,
      unlock: { prf: "unknown", sealedWith: null },
    });
    const unavailable = ids({
      ...bestCase,
      unlock: { prf: "unavailable", sealedWith: ["passphrase"] },
    });
    expect(unknown).toContain("prf-not-yet-checked");
    expect(unknown).not.toContain("prf-unavailable");
    expect(unavailable).toContain("prf-unavailable");
    expect(unavailable).not.toContain("prf-not-yet-checked");
  });

  it("flags a record that could be sealed with a passkey but is not", () => {
    const report = assessStorageSecurity({
      ...bestCase,
      unlock: { prf: "available", sealedWith: ["passphrase"] },
    });
    expect(report.findings.map((f) => f.id)).toContain("prf-reseal-pending");
    expect(report.score).toBe(90);
  });

  it("scores an unencrypted localStorage wallet as the worst case", () => {
    const report = assessStorageSecurity({
      level: 4,
      backend: "localStorage",
      encrypted: false,
      unlock: { prf: "none", sealedWith: null },
    });
    expect(report.score).toBe(30);
    expect(report.findings.map((f) => f.id)).toEqual([
      "backend-localstorage",
      "no-encryption-at-rest",
      "hot-wallet-signing-exposure",
    ]);
  });

  // With nothing encrypted, the unlock source is not what is holding the
  // score down, and listing it would bury the finding that matters.
  it("does not fault the unlock source when nothing is encrypted", () => {
    const report = assessStorageSecurity({
      level: 2,
      backend: "indexedDb",
      encrypted: false,
      unlock: { prf: "none", sealedWith: null },
    });
    expect(report.findings.map((f) => f.id)).not.toContain(
      "prf-not-configured",
    );
    expect(report.score).toBe(70);
  });

  it("never reports a score outside 0-100", () => {
    const report = assessStorageSecurity({
      level: 4,
      backend: "localStorage",
      encrypted: true,
      unlock: { prf: "none", sealedWith: ["passphrase"] },
    });
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.score).toBe(40);
  });

  it("carries the tier through unchanged", () => {
    expect(assessStorageSecurity(bestCase).level).toBe(1);
    expect(
      assessStorageSecurity({ ...bestCase, level: 3 }).level,
    ).toBe(3);
  });
});
