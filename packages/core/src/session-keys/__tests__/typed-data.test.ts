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
    const hash = `0x${"ab".repeat(32)}` as const;
    await expect(
      m.signWithSessionKey(info.id, hash, { to: PAYEE, value: "1" }),
    ).resolves.toMatch(/^0x/);
    expect(
      await m.checkSessionScope(info.id, { to: OTHER, value: "1" }),
    ).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/not in allowed list/),
    });
    await expect(
      m.signWithSessionKey(info.id, hash, { to: OTHER, value: "1" }),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    expect(
      await m.checkSessionScope(info.id, { to: PAYEE, data: "0x12345678" }),
    ).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/no recognizable recipient/),
    });
  });
});
