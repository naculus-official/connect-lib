import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../../storage";
import { SessionKeyManager } from "../SessionKeyManager";
import {
  type SessionKeyTypedDataRequest,
  sessionKeyAddress,
  typedDataAsTransaction,
  typedDataDigest,
} from "../typed-data";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;
const PAYEE = "0x2222222222222222222222222222222222222222" as const;
const OTHER = "0x3333333333333333333333333333333333333333" as const;
const SIGNER = "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18" as const;

function manager() {
  return new SessionKeyManager(
    { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true, encryptionKey: "k" },
    new MemoryStorageAdapter(),
  );
}
async function authorizedKey(
  m: SessionKeyManager,
  scope: Parameters<SessionKeyManager["createSessionKey"]>[0],
) {
  const info = await m.createSessionKey(scope, SIGNER);
  await m.setAuthorization(info.id, {
    signerAddress: SIGNER,
    type: "offchain",
    rawSignature: `0x${"12".repeat(65)}`,
    message: "test",
  });
  return info;
}
function request(
  from: `0x${string}`,
  overrides: Partial<SessionKeyTypedDataRequest["message"]> = {},
  chainId = 1,
): SessionKeyTypedDataRequest {
  const now = Math.floor(Date.now() / 1000);
  return {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId,
      verifyingContract: USDC,
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: PAYEE,
      value: "1500000",
      validAfter: "0",
      validBefore: String(now + 600),
      nonce: `0x${"ab".repeat(32)}`,
      ...overrides,
    },
  };
}

describe("typed-data helpers", () => {
  it("derives the session key's address from its compressed public key", () => {
    const priv = new Uint8Array(32).fill(7);
    const pub = `0x${bytesToHex(secp256k1.getPublicKey(priv))}` as const;
    const uncompressed = secp256k1.Point.fromHex(
      bytesToHex(secp256k1.getPublicKey(priv, false)),
    ).toBytes(false);
    const expected = `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
    expect(sessionKeyAddress(pub)).toBe(expected);
  });

  it("matches viem's hashTypedData byte for byte", () => {
    // Independent vectors: viem 2.56.5 hashTypedData in a throwaway script,
    // same domain and message, EIP-3009 TransferWithAuthorization types.
    const base: SessionKeyTypedDataRequest = {
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 1,
        verifyingContract: USDC,
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: SIGNER,
        to: PAYEE,
        value: "1500000",
        validAfter: "0",
        validBefore: "1790000000",
        nonce: `0x${"ab".repeat(32)}`,
      },
    };
    expect(typedDataDigest(base)).toBe(
      "0x87536b953850e2da56d3d030a2573c36bc5d23912ad4b6d19fa5abb2e7f41e91",
    );
    expect(
      typedDataDigest({
        ...base,
        domain: {
          ...base.domain,
          chainId: 8453,
          verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
        message: {
          ...base.message,
          value: ((1n << 256n) - 1n).toString(),
          validAfter: "1",
          nonce: `0x00${"01".repeat(31)}`,
        },
      }),
    ).toBe(
      "0x7edae92b253fff2bfe505c829c03821c544ac9b39cfe0ccd5f63e1ab566f0e75",
    );
  });

  it("computes the EIP-712 digest that a signature must recover against", () => {
    const req = request(PAYEE);
    const digest = typedDataDigest(req);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    // Independent construction: changing any signed field changes the digest.
    expect(typedDataDigest(request(PAYEE, { value: "1500001" }))).not.toBe(
      digest,
    );
    expect(typedDataDigest(request(PAYEE, {}, 8453))).not.toBe(digest);
    // And a known relation: 0x1901 ‖ domainSeparator ‖ structHash.
    const bytes = hexToBytes(digest.slice(2));
    expect(bytes).toHaveLength(32);
  });

  it("maps to the equivalent transfer(to, value) on the token for scope checks", () => {
    const tx = typedDataAsTransaction(request(PAYEE));
    expect(tx).toEqual({
      to: USDC,
      chainId: 1,
      value: "0",
      data: `0xa9059cbb${"0".repeat(24)}${PAYEE.slice(2)}${1_500_000n.toString(16).padStart(64, "0")}`,
    });
  });
});

describe("SessionKeyManager typed data + recipient allowlist", () => {
  it("signs a TransferWithAuthorization inside scope and charges the token allowance", async () => {
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [USDC],
      allowedChainIds: [1],
      tokenAllowances: { [USDC]: 2_000_000n },
      allowedRecipients: [PAYEE],
    });
    const self = sessionKeyAddress(info.publicKey);
    const sig = await m.signTypedDataWithSessionKey(info.id, request(self));
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    // Second payment would exceed the 2.0 USDC allowance (1.5 + 1.5).
    await expect(
      m.signTypedDataWithSessionKey(
        info.id,
        request(self, { nonce: `0x${"cd".repeat(32)}` }),
      ),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
  });

  it("refuses: wrong from, foreign payee, other primary type, window outliving the key, unknown chain", async () => {
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [USDC],
      allowedChainIds: [1],
      tokenAllowances: { [USDC]: 10_000_000n },
      allowedRecipients: [PAYEE],
    });
    const self = sessionKeyAddress(info.publicKey);
    const far = String(Math.floor(Date.now() / 1000) + 40 * 24 * 3600);
    const cases: [SessionKeyTypedDataRequest, RegExp][] = [
      [request(OTHER), /own address/],
      [request(self, { to: OTHER }), /not in allowed list/],
      [{ ...request(self), primaryType: "Permit" as never }, /not permitted/],
      [request(self, { validBefore: far }), /outlives/],
      [request(self, {}, 10), /Chain 10 not in allowed list/],
    ];
    for (const [req, reason] of cases) {
      const failure = await m.signTypedDataWithSessionKey(info.id, req).then(
        () => null,
        (e: unknown) => e as { code: string; details?: unknown },
      );
      expect(failure?.code).toBe("session_key_scope_exceeded");
      expect(String(failure?.details)).toMatch(reason);
    }
  });

  it("allowedRecipients also governs native transfers and refuses unrecognizable calldata", async () => {
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [PAYEE, OTHER],
      allowedRecipients: [PAYEE],
    });
    expect(
      await m.checkSessionScope(info.id, { to: PAYEE, value: "1" }),
    ).toMatchObject({ valid: true });
    expect(
      await m.checkSessionScope(info.id, { to: OTHER, value: "1" }),
    ).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/not in allowed list/),
    });
    expect(
      await m.checkSessionScope(info.id, { to: PAYEE, data: "0x12345678" }),
    ).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/no recognizable recipient/),
    });
  });

  it("refuses raw-digest signing while recipients are limited", async () => {
    // The digest of a transfer to anyone, sent with a harmless tx describing a
    // zero transfer to the payee (independent review, 2026-09-23).
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [USDC],
      allowedChainIds: [1],
      tokenAllowances: { [USDC]: 2_000_000n },
      allowedRecipients: [PAYEE],
    });
    const self = sessionKeyAddress(info.publicKey);
    const theft = typedDataDigest(
      request(self, { to: OTHER, value: "999999999999" }),
    );
    const harmless = {
      to: USDC,
      chainId: 1,
      data: `0xa9059cbb${"0".repeat(24)}${PAYEE.slice(2)}${"0".repeat(64)}`,
    };
    await expect(
      m.signWithSessionKey(info.id, theft, harmless),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    await expect(
      m.signWithVerifiedOffchainAuthorization(
        info.id,
        () => "test",
        () => true,
        theft,
        harmless,
      ),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
  });

  it("still signs raw digests when recipients are not limited", async () => {
    const m = manager();
    const info = await authorizedKey(m, { allowedContracts: [PAYEE] });
    await expect(
      m.signWithSessionKey(info.id, `0x${"ab".repeat(32)}`, {
        to: PAYEE,
        value: "1",
      }),
    ).resolves.toMatch(/^0x/);
  });

  it("signs the digest it checked, recoverable to the session key", async () => {
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [USDC],
      allowedChainIds: [1],
      tokenAllowances: { [USDC]: 2_000_000n },
    });
    const self = sessionKeyAddress(info.publicKey);
    const req = request(self);
    const sig = await m.signTypedDataWithSessionKey(info.id, req);
    const bytes = hexToBytes(sig.slice(2));
    const v = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64];
    const recovered = secp256k1.Signature.fromBytes(
      bytes.slice(0, 64),
      "compact",
    )
      .addRecoveryBit(v)
      .recoverPublicKey(hexToBytes(typedDataDigest(req).slice(2)));
    expect(sessionKeyAddress(`0x${recovered.toHex(true)}`)).toBe(self);
  });

  it("checks and signs one read of each field", async () => {
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [USDC],
      allowedChainIds: [1],
      tokenAllowances: { [USDC]: 2_000_000n },
      allowedRecipients: [PAYEE],
    });
    const self = sessionKeyAddress(info.publicKey);
    const honest = request(self);
    let reads = 0;
    const shifty = {
      ...honest,
      message: {
        ...honest.message,
        get to() {
          reads += 1;
          return reads === 1 ? PAYEE : OTHER;
        },
      },
    } as SessionKeyTypedDataRequest;
    const sig = await m.signTypedDataWithSessionKey(info.id, shifty);
    expect(reads).toBe(1);
    // The signature is over the payee transfer that was checked.
    const bytes = hexToBytes(sig.slice(2));
    const v = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64];
    const recovered = secp256k1.Signature.fromBytes(
      bytes.slice(0, 64),
      "compact",
    )
      .addRecoveryBit(v)
      .recoverPublicKey(hexToBytes(typedDataDigest(honest).slice(2)));
    expect(sessionKeyAddress(`0x${recovered.toHex(true)}`)).toBe(self);
  });

  it("refuses typed data for a token with no allowance entry", async () => {
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [USDC],
      allowedChainIds: [1],
    });
    const self = sessionKeyAddress(info.publicKey);
    const failure = await m
      .signTypedDataWithSessionKey(
        info.id,
        request(self, { value: ((1n << 256n) - 1n).toString() }),
      )
      .then(
        () => null,
        (e: unknown) => e as { code: string; details?: unknown },
      );
    expect(failure?.code).toBe("session_key_scope_exceeded");
    expect(String(failure?.details)).toMatch(/tokenAllowances entry/);
  });

  it("refuses malformed or expired authorizations", async () => {
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [USDC],
      allowedChainIds: [1],
      tokenAllowances: { [USDC]: 10_000_000n },
    });
    const self = sessionKeyAddress(info.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const cases: [SessionKeyTypedDataRequest, RegExp][] = [
      [request(self, { validBefore: String(now - 1) }), /in the past/],
      [
        request(self, {
          validAfter: String(now + 60),
          validBefore: String(now + 60),
        }),
        /window is empty/,
      ],
      [request(self, { value: "01" }), /decimal uint256/],
      [request(self, { value: (1n << 256n).toString() }), /decimal uint256/],
      [request(self, { value: 5 as never }), /decimal uint256/],
      [request(self, { nonce: `0x${"ab".repeat(31)}` }), /32 bytes/],
    ];
    for (const [req, reason] of cases) {
      const failure = await m.signTypedDataWithSessionKey(info.id, req).then(
        () => null,
        (e: unknown) => e as { code: string; details?: unknown },
      );
      expect(failure?.code).toBe("session_key_scope_exceeded");
      expect(String(failure?.details)).toMatch(reason);
    }
  });

  it("refuses non-string addresses that would encode twice", async () => {
    // An object passing the address regex through its toString, whose slice
    // answers differently on each call (independent review, 2026-09-24).
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [USDC],
      allowedChainIds: [1],
      tokenAllowances: { [USDC]: 2_000_000n },
      allowedRecipients: [PAYEE],
    });
    const self = sessionKeyAddress(info.publicKey);
    let slices = 0;
    const shifty = {
      toString: () => PAYEE,
      slice: (start: number) => {
        slices += 1;
        return (slices === 1 ? PAYEE : OTHER).slice(start);
      },
    };
    const honest = request(self);
    for (const req of [
      { ...honest, message: { ...honest.message, to: shifty } },
      { ...honest, message: { ...honest.message, from: shifty } },
      { ...honest, domain: { ...honest.domain, verifyingContract: shifty } },
      {
        ...honest,
        message: {
          ...honest.message,
          nonce: { toString: () => honest.message.nonce },
        },
      },
    ]) {
      await expect(
        m.signTypedDataWithSessionKey(info.id, req as never),
      ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    }
  });

  it("does not hand out the raw key while recipients are limited", async () => {
    const m = manager();
    const info = await authorizedKey(m, {
      allowedContracts: [USDC],
      tokenAllowances: { [USDC]: 2_000_000n },
      allowedRecipients: [PAYEE],
    });
    await expect(m.getSessionBundle(info.id)).rejects.toMatchObject({
      code: "session_key_scope_exceeded",
    });
  });
});
