import { encodeAbiParameters, erc6492SignatureValidatorByteCode } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPersonalMessage } from "../contract-signature";
import { createSiwxMessage } from "../message";
import {
  issueNonce,
  isNonceConsumed,
  resetNonceStorage,
} from "../nonce-consumption";
import {
  createEVMVerifier,
  createXRPLVerifier,
  verifySiwxMessage,
} from "../verify";

vi.mock("viem", () => ({
  encodeAbiParameters: vi.fn(() => "0xfeed"),
  erc6492SignatureValidatorByteCode: "0x6000",
  recoverMessageAddress: vi.fn(() => {
    throw new Error("not an EOA signature");
  }),
}));

/**
 * End-to-end security properties of verifySiwxMessage.
 *
 * nonce-consumption.test.ts covers the storage primitives; verify.ts sat at
 * 50% function coverage, so whether the verifier actually *uses* them — and in
 * what order — was untested. Order is the part that matters: consuming the
 * nonce before the signature is proven would let anyone burn a live nonce with
 * garbage, and consuming it never would leave every signed message replayable.
 */

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER = "0xfedcba0987654321fedcba0987654321fedcba09";

function message(over: Record<string, unknown> = {}) {
  return createSiwxMessage({
    domain: "localhost",
    address: ADDR,
    uri: "https://localhost",
    chainId: "eip155:1",
    nonce: "testnonce123",
    issuedAt: "2026-08-26T00:00:00.000Z",
    ...over,
  });
}

/** Stands in for a real signature check: returns whoever we say signed it. */
const recoverAs = (address: string) => vi.fn(async () => address);

beforeEach(() => {
  resetNonceStorage();
});

describe("replay protection", () => {
  it("accepts a correctly signed message once", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message(),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR),
    });
    expect(r.isValid).toBe(true);
  });

  it("rejects the same message a second time", async () => {
    await issueNonce("testnonce123");
    const params = {
      raw: message(),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR),
    };
    expect((await verifySiwxMessage(params)).isValid).toBe(true);
    const second = await verifySiwxMessage(params);
    expect(second.isValid).toBe(false);
    expect(second.error).toMatch(/replay/);
  });

  it("rejects a nonce this system never issued", async () => {
    const r = await verifySiwxMessage({
      raw: message({ nonce: "neverissued1" }),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR),
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/unissued nonce/);
  });

  it("does not burn the nonce when the signature is wrong", async () => {
    // Otherwise anyone who can see a nonce could invalidate it with garbage.
    await issueNonce("testnonce123");
    const bad = await verifySiwxMessage({
      raw: message(),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(OTHER),
    });
    expect(bad.isValid).toBe(false);
    expect(await isNonceConsumed("testnonce123")).toBe(false);

    const good = await verifySiwxMessage({
      raw: message(),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR),
    });
    expect(good.isValid).toBe(true);
  });

  it("does not burn the nonce when a constraint fails", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message(),
      signature: "0xsig",
      recoverAddress: recoverAs(ADDR),
      domain: "evil.example",
    });
    expect(r.isValid).toBe(false);
    expect(await isNonceConsumed("testnonce123")).toBe(false);
  });
});

describe("binding checks", () => {
  it("rejects a message signed for another domain", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message(),
      signature: "0xsig",
      recoverAddress: recoverAs(ADDR),
      domain: "evil.example",
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/Domain mismatch/);
  });

  it("refuses to verify at all when the caller omits `domain`", async () => {
    // Domain binding used to be opt-in, so a verifier that simply forgot it
    // accepted signatures harvested on any other site. It is now required.
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message({ domain: "some-other-site.example" }),
      signature: "0xsig",
      recoverAddress: recoverAs(ADDR),
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/domain binding/);
  });

  it("can opt out explicitly for non-login inspection", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage(
      {
        raw: message(),
        signature: "0xsig",
        domain: "localhost",
        recoverAddress: recoverAs(ADDR),
      },
      { allowUnboundDomain: true },
    );
    expect(r.isValid).toBe(true);
  });

  it("rejects a signature recovered to a different address", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message(),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(OTHER),
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/Signature does not match/);
  });

  it("rejects when the message address is not the expected one", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message(),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR),
      expectedAddress: OTHER,
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/does not match expected address/);
  });

  it("treats EVM addresses case-insensitively", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message(),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR.toUpperCase().replace("0X", "0x")),
    });
    expect(r.isValid).toBe(true);
  });
});

describe("time window", () => {
  it("rejects an expired message", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message({ expirationTime: "2026-08-26T00:05:00.000Z" }),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR),
      timestamp: "2026-08-26T01:00:00.000Z",
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/expired/);
  });

  it("accepts a message inside its window", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message({ expirationTime: "2026-08-26T01:00:00.000Z" }),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR),
      timestamp: "2026-08-26T00:30:00.000Z",
    });
    expect(r.isValid).toBe(true);
  });

  it("rejects a message that is not yet valid", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message({ notBefore: "2026-08-26T02:00:00.000Z" }),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR),
      timestamp: "2026-08-26T01:00:00.000Z",
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/not yet valid/);
  });

  it("can require an expiration time to be present", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: message(),
      signature: "0xsig",
      domain: "localhost",
      recoverAddress: recoverAs(ADDR),
    }, { requireExpirationTime: true });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/Expiration time is required/);
  });
});

describe("boolean verifiers (Solana / XRPL)", () => {
  /**
   * EVM recovers an address from the signature; ed25519 and XRPL instead
   * verify against a key you supply, so those verifiers answer true/false.
   * The security argument rests on which key they are handed: it must be the
   * one the message claims, otherwise "true" would prove nothing about the
   * address being authenticated.
   */
  const solanaMessage = () =>
    createSiwxMessage({
      domain: "localhost",
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      uri: "https://localhost",
      chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      nonce: "testnonce123",
      issuedAt: "2026-08-26T00:00:00.000Z",
      blockchain: "Solana",
    });

  it("accepts when the verifier confirms the signature", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: solanaMessage(),
      signature: "sig",
      domain: "localhost",
      recoverAddress: vi.fn(async () => true),
    });
    expect(r.isValid).toBe(true);
    expect(r.address).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  });

  it("rejects when the verifier denies the signature", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: solanaMessage(),
      signature: "sig",
      domain: "localhost",
      recoverAddress: vi.fn(async () => false),
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/Signature verification failed/);
  });

  it("hands the verifier the address the message claims", async () => {
    // If it were given some other key, a "true" answer would say nothing
    // about whether the claimed account signed.
    await issueNonce("testnonce123");
    const verifier = vi.fn(async () => true);
    await verifySiwxMessage({
      raw: solanaMessage(),
      signature: "sig",
      domain: "localhost",
      recoverAddress: verifier,
    });
    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      }),
    );
  });

  it("does not consume the nonce when the verifier denies", async () => {
    await issueNonce("testnonce123");
    await verifySiwxMessage({
      raw: solanaMessage(),
      signature: "sig",
      domain: "localhost",
      recoverAddress: vi.fn(async () => false),
    });
    expect(await isNonceConsumed("testnonce123")).toBe(false);
  });

  it("rejects a true result when the verified public key is not the claimed account", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: solanaMessage(),
      signature: "sig",
      domain: "localhost",
      publicKey: "11111111111111111111111111111111",
      recoverAddress: vi.fn(async () => true),
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/not the claimed account address/);
    expect(await isNonceConsumed("testnonce123")).toBe(false);
  });
});

describe("XRPL signer identity binding", () => {
  it("does not authenticate an address unrelated to the verified public key", async () => {
    const keypairs = await import("ripple-keypairs");
    const attacker = keypairs.deriveKeypair(keypairs.generateSeed());
    const victim = keypairs.deriveKeypair(keypairs.generateSeed());
    const victimAddress = keypairs.deriveAddress(victim.publicKey);
    const nonce = "identity1234";
    const raw = createSiwxMessage({
      domain: "localhost",
      address: victimAddress,
      uri: "https://localhost",
      chainId: "xrpl:0",
      nonce,
      issuedAt: "2026-08-26T00:00:00.000Z",
      blockchain: "XRPL",
    });
    const signature = keypairs.sign(
      Buffer.from(raw, "utf8").toString("hex"),
      attacker.privateKey,
    );
    await issueNonce(nonce);

    const result = await verifySiwxMessage({
      raw,
      signature,
      domain: "localhost",
      expectedAddress: victimAddress,
      publicKey: attacker.publicKey,
      recoverAddress: createXRPLVerifier(),
    });

    expect(keypairs.deriveAddress(attacker.publicKey)).not.toBe(victimAddress);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/does not match expected address/);
    expect(await isNonceConsumed(nonce)).toBe(false);
  });
});

describe("contract-account sign-in (ERC-1271 / ERC-6492)", () => {
  /**
   * A smart account signs through its own logic, so ecrecover returns an
   * unrelated address and the sign-in was rejected with nothing to indicate
   * the account type was the reason. With chain access the verifier asks the
   * account itself.
   */
  const ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678";
  const MAGIC = "0x1626ba7e";
  // Generated once with viem toCoinbaseSmartAccount v1.1. Keeping the real
  // envelope here exercises the factory calldata and nested signature shape
  // without pulling account-abstraction code or a network into the test run.
  const COUNTERFACTUAL_ACCOUNT = "0x889942B56A61010D8b8F1a6FfcC3856CA0Ecca73";
  const COUNTERFACTUAL_MESSAGE = "naculus erc6492 counterfactual fixture";
  const COUNTERFACTUAL_SIGNATURE =
    "0x000000000000000000000000ba5ed110efdba3d005bfc882d75358acbbb858420000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000c43ffba36f0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002000000000000000000000000030daB87B1fCcF37A981B49eaf005217C29AFB7810000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000004195ddbe94245b69015215fa8bcda0e0d545e5290aaef749984687fab482f215717dc3fa3bb45ac7b4b72e20153d3b1dde23d44657f5378e91796a77a0740a5c771c000000000000000000000000000000000000000000000000000000000000006492649264926492649264926492649264926492649264926492649264926492";

  const contractMessage = () =>
    createSiwxMessage({
      domain: "localhost",
      address: ACCOUNT,
      uri: "https://localhost",
      chainId: "eip155:1",
      nonce: "testnonce123",
      issuedAt: "2026-08-26T00:00:00.000Z",
    });

  it("accepts a signature the account itself validates", async () => {
    await issueNonce("testnonce123");
    const call = vi.fn(async () => `${MAGIC}${"0".repeat(56)}`);
    const r = await verifySiwxMessage({
      raw: contractMessage(),
      signature: `0x${"ab".repeat(65)}`,
      domain: "localhost",
      publicKey: ACCOUNT,
      recoverAddress: createEVMVerifier({ call }),
    });
    expect(r.isValid).toBe(true);
    expect(call).toHaveBeenCalled();
  });

  it("rejects a signature the account refuses", async () => {
    await issueNonce("testnonce123");
    const call = vi.fn(async () => `0x${"00".repeat(32)}`);
    const r = await verifySiwxMessage({
      raw: contractMessage(),
      signature: `0x${"ab".repeat(65)}`,
      domain: "localhost",
      publicKey: ACCOUNT,
      recoverAddress: createEVMVerifier({ call }),
    });
    expect(r.isValid).toBe(false);
  });

  it("verifies a counterfactual ERC-6492 signature with a creation call", async () => {
    const call = vi.fn(
      async (_params: { to?: string; data: string }) => "0x01",
    );
    const verifier = createEVMVerifier({ call });

    await expect(
      verifier({
        message: COUNTERFACTUAL_MESSAGE,
        signature: COUNTERFACTUAL_SIGNATURE,
        publicKey: COUNTERFACTUAL_ACCOUNT,
      }),
    ).resolves.toBe(true);

    const expectedArgs = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "bytes" }],
      [
        COUNTERFACTUAL_ACCOUNT,
        hashPersonalMessage(COUNTERFACTUAL_MESSAGE) as `0x${string}`,
        COUNTERFACTUAL_SIGNATURE,
      ],
    );
    expect(encodeAbiParameters).toHaveBeenCalledWith(
      [{ type: "address" }, { type: "bytes32" }, { type: "bytes" }],
      [
        COUNTERFACTUAL_ACCOUNT,
        hashPersonalMessage(COUNTERFACTUAL_MESSAGE),
        COUNTERFACTUAL_SIGNATURE,
      ],
    );
    expect(call).toHaveBeenCalledWith({
      data: `${erc6492SignatureValidatorByteCode}${expectedArgs.slice(2)}`,
    });
    expect(call.mock.calls[0]?.[0]).not.toHaveProperty("to");
  });

  it("rejects a counterfactual ERC-6492 signature the validator refuses", async () => {
    const verifier = createEVMVerifier({
      call: vi.fn(async () => "0x00"),
      getCode: vi.fn(async () => "0x"),
    });
    await expect(
      verifier({
        message: COUNTERFACTUAL_MESSAGE,
        signature: COUNTERFACTUAL_SIGNATURE,
        publicKey: COUNTERFACTUAL_ACCOUNT,
      }),
    ).resolves.toBe(false);
  });

  it("accepts the validator's 32-byte true word", async () => {
    const verifier = createEVMVerifier({
      call: vi.fn(async () => `0x${"0".repeat(63)}1`),
    });
    await expect(
      verifier({
        message: COUNTERFACTUAL_MESSAGE,
        signature: COUNTERFACTUAL_SIGNATURE,
        publicKey: COUNTERFACTUAL_ACCOUNT,
      }),
    ).resolves.toBe(true);
  });

  it("fails closed when the address-free ERC-6492 call throws", async () => {
    const verifier = createEVMVerifier({
      call: vi.fn(async () => {
        throw new Error("execution reverted");
      }),
      getCode: vi.fn(async () => "0x"),
    });
    await expect(
      verifier({
        message: COUNTERFACTUAL_MESSAGE,
        signature: COUNTERFACTUAL_SIGNATURE,
        publicKey: COUNTERFACTUAL_ACCOUNT,
      }),
    ).resolves.toBe(false);
  });

  it("fails closed when ERC-6492 calldata encoding throws", async () => {
    vi.mocked(encodeAbiParameters).mockImplementationOnce(() => {
      throw new Error("invalid address");
    });
    const verifier = createEVMVerifier({ call: vi.fn(async () => "0x01") });
    await expect(
      verifier({
        message: COUNTERFACTUAL_MESSAGE,
        signature: COUNTERFACTUAL_SIGNATURE,
        publicKey: COUNTERFACTUAL_ACCOUNT,
      }),
    ).resolves.toBe(false);
  });

  it("verifies an ERC-6492 signature once the account is deployed", async () => {
    await issueNonce("testnonce123");
    const inner = "ab".repeat(65);
    const body =
      "22".repeat(20).padStart(64, "0") +
      (96).toString(16).padStart(64, "0") +
      (128).toString(16).padStart(64, "0") +
      (2).toString(16).padStart(64, "0") +
      "cafe".padEnd(64, "0") +
      (65).toString(16).padStart(64, "0") +
      inner.padEnd(192, "0");
    const call = vi.fn(async () => `${MAGIC}${"0".repeat(56)}`);
    const r = await verifySiwxMessage({
      raw: contractMessage(),
      signature: `0x${body}${"6492".repeat(16)}`,
      domain: "localhost",
      publicKey: ACCOUNT,
      recoverAddress: createEVMVerifier({
        call,
        getCode: vi.fn(async () => "0x6080604052"),
      }),
    });
    expect(r.isValid).toBe(true);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ACCOUNT,
        data: expect.stringContaining(inner),
      }),
    );
  });

  it("refuses an ERC-6492 signature with no chain access at all", async () => {
    await issueNonce("testnonce123");
    const r = await verifySiwxMessage({
      raw: contractMessage(),
      signature: `0x${"00".repeat(96)}${"6492".repeat(16)}`,
      domain: "localhost",
      publicKey: ACCOUNT,
      recoverAddress: createEVMVerifier(),
    });
    expect(r.isValid).toBe(false);
  });
});
