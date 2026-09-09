import { describe, expect, it } from "vitest";
import { readDelegation, UNKNOWN_DELEGATION } from "../delegation";

const DELEGATE = "0x1234567890abcdef1234567890abcdef12345678";
const DELEGATED_CODE = `0xef0100${DELEGATE.slice(2)}`;

describe("readDelegation", () => {
  it("reads the delegate out of a delegation designator", () => {
    expect(readDelegation(DELEGATED_CODE)).toEqual({
      delegated: true,
      delegate: DELEGATE,
    });
  });

  it("is case-insensitive about the prefix", () => {
    expect(readDelegation(DELEGATED_CODE.toUpperCase().replace("0X", "0x")).delegated).toBe(
      true,
    );
  });

  it("reports an empty account as not delegated", () => {
    expect(readDelegation("0x")).toEqual({ delegated: false, delegate: null });
  });

  it("reports ordinary contract code as not delegated", () => {
    expect(readDelegation(`0x60806040${"ab".repeat(64)}`).delegated).toBe(false);
  });

  // 23 bytes of ordinary code is not a delegation. Contracts that short are
  // vanishingly rare but nothing rules them out.
  it("does not match 23 bytes that lack the prefix", () => {
    expect(readDelegation(`0xdeadbe${"11".repeat(20)}`).delegated).toBe(false);
  });

  // The spec allows delegating to the zero address to clear a delegation.
  it("treats a cleared delegation as not delegated", () => {
    expect(readDelegation(`0xef0100${"0".repeat(40)}`)).toEqual({
      delegated: false,
      delegate: null,
    });
  });

  // Treating a failed read as "no delegation" is how an account that can
  // batch gets sent down the path for one that cannot.
  it("answers unknown for anything that was not read as code", () => {
    for (const bad of [undefined, null, "", "not-hex", "0xzz", 42, {}]) {
      expect(readDelegation(bad)).toEqual(UNKNOWN_DELEGATION);
    }
  });

  it("answers unknown for an odd-length hex string", () => {
    expect(readDelegation("0xabc").delegated).toBeNull();
  });
});
