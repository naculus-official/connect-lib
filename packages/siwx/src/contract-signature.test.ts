import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it, vi } from "vitest";
import {
  ERC1271_MAGIC_VALUE,
  ERC6492_MAGIC_SUFFIX,
  decodeErc6492Signature,
  encodeIsValidSignatureCall,
  hashPersonalMessage,
  isErc1271Accepted,
  isErc6492Signature,
  verifyErc1271,
} from "./contract-signature";

/**
 * SIWx verified EVM signatures by recovering an address, which only answers
 * for an externally owned account. A smart account signs through its own
 * logic, so recovery returned an unrelated address and the sign-in failed
 * with no hint that the account type was the reason. These cover the two
 * standards that make contract accounts verifiable: ERC-1271 for a deployed
 * account, ERC-6492 for one that exists only counterfactually.
 */

const ACCOUNT = `0x${"11".repeat(20)}`;
const FACTORY = `0x${"22".repeat(20)}`;
const HASH = `0x${"ab".repeat(32)}`;

const word = (hex: string) => hex.padStart(64, "0");
const bytesArg = (hex: string) => {
  const raw = hex.replace(/^0x/, "");
  return (
    (raw.length / 2).toString(16).padStart(64, "0") +
    raw.padEnd(Math.ceil(raw.length / 64) * 64, "0")
  );
};

/** Build a well-formed ERC-6492 wrapper. */
function wrap(factoryCalldata: string, signature: string) {
  const head =
    word(FACTORY.slice(2)) + word((3 * 32).toString(16)) + word("0");
  const cd = bytesArg(factoryCalldata);
  const offsetOfSig = 3 * 32 + cd.length / 2;
  const body =
    word(FACTORY.slice(2)) +
    word((3 * 32).toString(16)) +
    word(offsetOfSig.toString(16)) +
    cd +
    bytesArg(signature);
  void head;
  return `0x${body}${ERC6492_MAGIC_SUFFIX}`;
}

describe("ERC-1271 magic value", () => {
  it("is bytes4(keccak256(\"isValidSignature(bytes32,bytes)\"))", () => {
    // Derived, not transcribed, so it cannot drift from its signature.
    const derived = `0x${bytesToHex(
      keccak_256(new TextEncoder().encode("isValidSignature(bytes32,bytes)")),
    ).slice(0, 8)}`;
    expect(ERC1271_MAGIC_VALUE).toBe(derived);
  });

  it.each([
    [`${ERC1271_MAGIC_VALUE}${"0".repeat(56)}`, true],
    ["0xffffffff" + "0".repeat(56), false],
    ["0x", false],
    ["0x16", false],
  ])("reads %p as accepted=%p", (returnData, expected) => {
    expect(isErc1271Accepted(returnData)).toBe(expected);
  });
});

describe("encodeIsValidSignatureCall", () => {
  it("starts with the ERC-1271 selector", () => {
    expect(
      encodeIsValidSignatureCall(HASH, "0xdead").startsWith(
        ERC1271_MAGIC_VALUE,
      ),
    ).toBe(true);
  });

  it("places the hash in the first word", () => {
    const data = encodeIsValidSignatureCall(HASH, "0xdead");
    expect(data.slice(10, 74)).toBe(HASH.slice(2));
  });

  it("declares the signature length", () => {
    const data = encodeIsValidSignatureCall(HASH, `0x${"ab".repeat(65)}`);
    const len = Number.parseInt(data.slice(138, 202), 16);
    expect(len).toBe(65);
  });
});

describe("isErc6492Signature", () => {
  it("recognizes the wrapper", () => {
    expect(isErc6492Signature(wrap("0xcafe", `0x${"ab".repeat(65)}`))).toBe(
      true,
    );
  });

  it.each([`0x${"ab".repeat(65)}`, "0x", ERC6492_MAGIC_SUFFIX])(
    "does not mistake %p for a wrapper",
    (sig) => {
      expect(isErc6492Signature(sig)).toBe(false);
    },
  );
});

describe("decodeErc6492Signature", () => {
  it("recovers the factory, its calldata and the inner signature", () => {
    const inner = `0x${"ab".repeat(65)}`;
    const decoded = decodeErc6492Signature(wrap("0xcafebabe", inner));
    expect(decoded).toBeDefined();
    expect(decoded?.factory.toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(decoded?.factoryCalldata).toBe("0xcafebabe");
    expect(decoded?.signature).toBe(inner);
  });

  it("returns undefined for a plain signature", () => {
    expect(decodeErc6492Signature(`0x${"ab".repeat(65)}`)).toBeUndefined();
  });

  it("returns undefined for a truncated wrapper", () => {
    expect(
      decodeErc6492Signature(`0x${"00".repeat(16)}${ERC6492_MAGIC_SUFFIX}`),
    ).toBeUndefined();
  });

  it("refuses a length that promises more data than the payload carries", () => {
    // A wrapper is attacker-supplied; padding out an overstated length would
    // produce a signature that looks structurally valid.
    const body =
      word(FACTORY.slice(2)) +
      word((3 * 32).toString(16)) +
      word((3 * 32).toString(16)) +
      "f".repeat(64) + // absurd declared length
      "ab".repeat(4);
    expect(
      decodeErc6492Signature(`0x${body}${ERC6492_MAGIC_SUFFIX}`),
    ).toBeUndefined();
  });
});

describe("verifyErc1271", () => {
  it("accepts when the account returns the magic value", async () => {
    const call = vi.fn(async () => `${ERC1271_MAGIC_VALUE}${"0".repeat(56)}`);
    await expect(
      verifyErc1271(ACCOUNT, HASH, "0xdead", call),
    ).resolves.toBe(true);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ to: ACCOUNT }),
    );
  });

  it("rejects when the account returns anything else", async () => {
    const call = vi.fn(async () => `0x${"00".repeat(32)}`);
    await expect(verifyErc1271(ACCOUNT, HASH, "0xdead", call)).resolves.toBe(
      false,
    );
  });

  it("treats a revert as a rejection, not an error to propagate", async () => {
    // An account with no ERC-1271 support has not signed anything; that is an
    // answer, not a failure the caller should have to catch.
    const call = vi.fn(async () => {
      throw new Error("execution reverted");
    });
    await expect(verifyErc1271(ACCOUNT, HASH, "0xdead", call)).resolves.toBe(
      false,
    );
  });
});

describe("hashPersonalMessage", () => {
  /**
   * The EIP-191 digest is computed here rather than pulled from viem: it is a
   * few lines on a dependency this package already has, and going through a
   * dynamic import made it depend on the shape the consumer's bundler gives
   * the namespace object — under one resolver the function was simply absent
   * and contract verification failed complaining about a missing function
   * instead of about the signature.
   */
  it("matches the published EIP-191 vector", () => {
    expect(hashPersonalMessage("hello world")).toBe(
      "0xd9eba16ed0ecae432b71fe008c98cc872bb4cc214d3220a36f365326cf807d68",
    );
  });

  it("hashes the empty message", () => {
    expect(hashPersonalMessage("")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("counts bytes, not characters, in the length prefix", () => {
    // A multi-byte character must not be counted as one.
    expect(hashPersonalMessage("é")).not.toBe(hashPersonalMessage("e"));
  });

  it("distinguishes messages that differ only in length", () => {
    expect(hashPersonalMessage("a")).not.toBe(hashPersonalMessage("aa"));
  });
});
