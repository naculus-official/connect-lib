import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  deriveEd25519,
  ed25519DeriveChild,
  ed25519MasterNode,
  parseHardenedPath,
} from "./slip10";

/**
 * SLIP-0010 test vector 1 for ed25519, taken from the specification itself.
 *
 * These are the numbers the spec publishes, not numbers recorded from this
 * implementation. Derivation decides which address a user's funds sit at, so
 * an implementation that only agrees with itself proves nothing — if a
 * refactor changes the result, these fail, which is the point.
 *
 * https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 */
const SEED = hexToBytes("000102030405060708090a0b0c0d0e0f");

const VECTORS: ReadonlyArray<{
  path: string;
  key: string;
  chainCode?: string;
}> = [
  {
    path: "m",
    key: "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
    chainCode:
      "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb",
  },
  {
    path: "m/0'",
    key: "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
  },
  {
    path: "m/0'/1'",
    key: "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
  },
  {
    path: "m/0'/1'/2'",
    key: "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9",
  },
  {
    path: "m/0'/1'/2'/2'",
    key: "30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662",
  },
  {
    path: "m/0'/1'/2'/2'/1000000000'",
    key: "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793",
  },
];

describe("SLIP-0010 ed25519 — specification vectors", () => {
  it("derives the master node the spec publishes", () => {
    const node = ed25519MasterNode(SEED);
    expect(bytesToHex(node.key)).toBe(VECTORS[0].key);
    expect(bytesToHex(node.chainCode)).toBe(VECTORS[0].chainCode);
  });

  it.each(VECTORS.slice(1))("derives $path", ({ path, key }) => {
    expect(bytesToHex(deriveEd25519(SEED, path))).toBe(key);
  });

  // No separate per-step chain-code assertion. The key vectors already pin
  // them: a chain code feeds the next level's HMAC, so deriving the correct
  // private key at m/0'/1'/2'/2'/1000000000' requires every intermediate chain
  // code along the way to have been right. Asserting them again would only
  // restate that, and the values would have to come from somewhere — pasting
  // this implementation's output would turn a specification test into a
  // recording of current behavior.
});

describe("SLIP-0010 ed25519 — refusals", () => {
  it("refuses a non-hardened segment rather than hardening it silently", () => {
    // Deriving a different key than the caller asked for would put funds at an
    // address they never see.
    expect(() => deriveEd25519(SEED, "m/44'/501'/0'/0")).toThrow(/hardened/i);
  });

  it("refuses a non-hardened index at the child level", () => {
    const master = ed25519MasterNode(SEED);
    expect(() => ed25519DeriveChild(master, 0)).toThrow(/hardened/i);
  });

  it.each(["", "44'/501'", "m/", "m/44''", "m/-1'", "m/abc'"])(
    "refuses the malformed path %o",
    (path) => {
      expect(() => deriveEd25519(SEED, path)).toThrow();
    },
  );

  it("refuses a seed outside the permitted length", () => {
    expect(() => ed25519MasterNode(new Uint8Array(15))).toThrow(/16 to 64/);
    expect(() => ed25519MasterNode(new Uint8Array(65))).toThrow(/16 to 64/);
  });

  it("refuses an index above the 32-bit range", () => {
    const master = ed25519MasterNode(SEED);
    expect(() => ed25519DeriveChild(master, 0x1_0000_0000)).toThrow(
      /out of range/,
    );
  });
});

describe("parseHardenedPath", () => {
  it("adds the hardened offset", () => {
    expect(parseHardenedPath("m/44'/501'/0'/0'")).toEqual([
      44 + 0x80000000,
      501 + 0x80000000,
      0x80000000,
      0x80000000,
    ]);
  });

  it("returns nothing for the master path", () => {
    expect(parseHardenedPath("m")).toEqual([]);
  });
});
