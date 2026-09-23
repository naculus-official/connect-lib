import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { EVMSigner } from "./evm";
import {
  authorizationHash,
  serializeSignedTransaction,
  TransactionInputError,
  transactionSigningHash,
} from "./evm-tx";
import type { SignedEip7702Authorization, TransactionRequest } from "./types";

/**
 * Independent vectors: produced by viem 2.56.5 (`hashAuthorization`,
 * `privateKeyToAccount(pk).signAuthorization`, `serializeTransaction`,
 * `signTransaction`) in a throwaway script outside this repo's dependency
 * graph, for the private key 0xabab…ab (address
 * 0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6). RFC 6979 signatures are
 * deterministic, so the signed outputs are exact.
 *
 * The legacy and type-2 vectors are also what this signer produced before the
 * hash/assemble split (checked against the pre-split evm.ts), so they pin that
 * the split changed no bytes.
 */
const PK = `0x${"ab".repeat(32)}` as `0x${string}`;
const SELF = "0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6";
const DELEGATE = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
const ZERO = "0x0000000000000000000000000000000000000000";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

const AUTH = { chainId: 1, address: DELEGATE, nonce: "0x7" };
const AUTH_HASH =
  "0xb5fd1cbf1c9031f8cd523819fd9fa7b455ed84b01c76e0ef022126f46707e6c5";
const SIGNED_AUTH: SignedEip7702Authorization = {
  ...AUTH,
  yParity: 1,
  r: "0x8590d30e098d3e27cd8e83b30b6965999605a2129f77b170dec7af1762a9e1c5",
  s: "0x41f93e1aa5100e4ff37f1cf8c61d39d289b93cb994cbd27bc62db429919c149b",
};

const REVOKE = { chainId: 11155111, address: ZERO, nonce: "0x0" };
const REVOKE_HASH =
  "0xc17d2b3d92ad8ddaa5bab0e83fc3e29b1b07b9152c22caaf570fec322578de32";
const SIGNED_REVOKE: SignedEip7702Authorization = {
  ...REVOKE,
  yParity: 1,
  r: "0xbbcdf9477ab601d7f386dcf1137d46f7ea3dcf4497c2fdf71334c6c418cc851d",
  s: "0x5aec01ee8e5d050265c95d64e9daebe9cedf695e1b801e2bf7beae78f4fbc2a8",
};

const ANY_CHAIN = { chainId: 0, address: DELEGATE, nonce: "0x1" };
const ANY_CHAIN_HASH =
  "0x50020e6a6a7edd8385a09bab46186d6431c3018a0159ea9476617590f9cec154";

const TX4: TransactionRequest = {
  type: "eip7702",
  chainId: 1,
  nonce: "0x6",
  maxPriorityFeePerGas: "0x3b9aca00",
  maxFeePerGas: "0x6fc23ac00",
  gas: "0x186a0",
  to: SELF,
  value: "0x0",
  data: "0xdeadbeef",
  authorizationList: [SIGNED_AUTH],
};
const TX4_HASH =
  "0x31dc516eecc45a83e1ed08bdc4c37c8352b42f2f290f1f88d840ce561e472d6c";
const TX4_SIGNED =
  "0x04f8ce0106843b9aca008506fc23ac00830186a094e239cdc5fbe977a8a141b72194d3cf8c41bc5bc68084deadbeefc0f85cf85a019463c0c19a282a1b52b07dd5a65b58948a07dae32b0701a08590d30e098d3e27cd8e83b30b6965999605a2129f77b170dec7af1762a9e1c5a041f93e1aa5100e4ff37f1cf8c61d39d289b93cb994cbd27bc62db429919c149b80a04915ac8dfea93ef28483d163fb90c66d4cef0c17a91569fa1165e9aecda8e6f1a02b47f7d85a2e092d052ade0d14b1a355d1e8c93ead82378abd23c074eb97a177";

const TX2: TransactionRequest = {
  type: "eip1559",
  chainId: 1,
  nonce: "0x5",
  maxPriorityFeePerGas: "0x3b9aca00",
  maxFeePerGas: "0x6fc23ac00",
  gas: "0x5208",
  to: RECIPIENT,
  value: "0x38d7ea4c68000",
  data: "0x",
};
const TX2_SIGNED =
  "0x02f8720105843b9aca008506fc23ac0082520894111111111111111111111111111111111111111187038d7ea4c6800080c001a0eb7487d03d216f104e57bd800b6c36a6c3f62d7533a60db699c4df96fed26e8aa03e8a78ebd078e93053cbebc00095930ac304deb51a53a0f517eb62ee695d204d";

const TX0: TransactionRequest = {
  type: "legacy",
  chainId: 137,
  nonce: "0x3",
  gasPrice: "0x4a817c800",
  gas: "0x5208",
  to: RECIPIENT,
  value: "0x1",
  data: "0x",
};
const TX0_SIGNED =
  "0xf866038504a817c8008252089411111111111111111111111111111111111111110180820135a091f01947e0c973c2fa3e0554611ade3ed61358ee77d44775be0733f6caf78f17a022aed52818553889d9f5efe51f447e7bc214662e8106d1c17a5cc464b75c50ee";

const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;
const signer = new EVMSigner();

describe("EIP-7702 authorization hash", () => {
  it("matches keccak256(0x05 ‖ rlp([chainId, address, nonce]))", () => {
    expect(hex(authorizationHash(AUTH))).toBe(AUTH_HASH);
  });

  it("accepts address(0), the revoke path", () => {
    expect(hex(authorizationHash(REVOKE))).toBe(REVOKE_HASH);
  });

  it("refuses chainId 0 unless unsafeAllowAnyChainAuthorization is set", () => {
    expect(() => authorizationHash(ANY_CHAIN)).toThrow(TransactionInputError);
    expect(() =>
      authorizationHash(ANY_CHAIN, { unsafeAllowAnyChainAuthorization: false }),
    ).toThrow(/chainId 0/);
    expect(
      hex(
        authorizationHash(ANY_CHAIN, {
          unsafeAllowAnyChainAuthorization: true,
        }),
      ),
    ).toBe(ANY_CHAIN_HASH);
  });

  it.each([
    [{ ...AUTH, chainId: -1 }],
    [{ ...AUTH, chainId: 1.5 }],
    [{ ...AUTH, address: "0x1234" }],
    [{ ...AUTH, nonce: "0x07" }],
    [{ ...AUTH, nonce: "7" }],
    [{ ...AUTH, nonce: "0xffffffffffffffff" }],
  ])("refuses a malformed authorization %#", (auth) => {
    expect(() => authorizationHash(auth)).toThrow(TransactionInputError);
  });

  it("bounds the nonce at 2^64 - 1 exclusive", () => {
    expect(() =>
      authorizationHash({ ...AUTH, nonce: "0xffffffffffffffff" }),
    ).toThrow(/below 2\^64 - 1/);
    expect(
      authorizationHash({ ...AUTH, nonce: "0xfffffffffffffffe" }),
    ).toHaveLength(32);
  });

  it("checks and signs one read of each field", async () => {
    // A getter that passes the chain check and then answers 0 must not
    // produce an any-chain signature (independent review, 2026-09-23).
    let reads = 0;
    const shifty = {
      address: DELEGATE,
      nonce: "0x0",
      get chainId() {
        reads += 1;
        return reads <= 3 ? 1 : 0;
      },
    };
    const signed = await signer.signAuthorization(shifty, PK);
    expect(reads).toBe(1);
    expect(signed.chainId).toBe(1);
    expect(hex(authorizationHash(signed))).toBe(
      hex(authorizationHash({ ...AUTH, nonce: "0x0" })),
    );
  });
});

describe("EVMSigner.signAuthorization", () => {
  it("produces viem's signature for the same authorization", async () => {
    await expect(signer.signAuthorization(AUTH, PK)).resolves.toEqual(
      SIGNED_AUTH,
    );
    await expect(signer.signAuthorization(REVOKE, PK)).resolves.toEqual(
      SIGNED_REVOKE,
    );
  });

  it("refuses chainId 0 as invalid_input before touching the key", async () => {
    await expect(signer.signAuthorization(ANY_CHAIN, PK)).rejects.toMatchObject(
      { code: "invalid_input" },
    );
  });
});

describe("transaction hash and assemble", () => {
  it("hashes a type-4 transaction as keccak256(0x04 ‖ rlp(fields))", () => {
    expect(hex(transactionSigningHash(TX4))).toBe(TX4_HASH);
  });

  it("signs type 4, type 2 and legacy byte-for-byte as viem does", async () => {
    await expect(signer.signTransaction(TX4, PK)).resolves.toEqual({
      signature: TX4_SIGNED,
    });
    await expect(signer.signTransaction(TX2, PK)).resolves.toEqual({
      signature: TX2_SIGNED,
    });
    await expect(signer.signTransaction(TX0, PK)).resolves.toEqual({
      signature: TX0_SIGNED,
    });
  });

  it("assembles from a signature produced elsewhere", () => {
    // The r/s/yParity of TX4_SIGNED, supplied as a separate signer would.
    expect(
      serializeSignedTransaction(TX4, {
        yParity: 0,
        r: "0x4915ac8dfea93ef28483d163fb90c66d4cef0c17a91569fa1165e9aecda8e6f1",
        s: "0x2b47f7d85a2e092d052ade0d14b1a355d1e8c93ead82378abd23c074eb97a177",
      }),
    ).toBe(TX4_SIGNED);
  });

  it("refuses a high-s or out-of-range signature", () => {
    const highS = {
      yParity: 0 as const,
      r: SIGNED_AUTH.r,
      s: "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140" as const,
    };
    expect(() => serializeSignedTransaction(TX2, highS)).toThrow(
      /secp256k1 range/,
    );
    expect(() =>
      serializeSignedTransaction(TX2, {
        ...highS,
        r: `0x${"00".repeat(32)}`,
        s: SIGNED_AUTH.s,
      }),
    ).toThrow(/secp256k1 range/);
  });
});

describe("type-4 transaction rules", () => {
  const cases: Array<[string, TransactionRequest, RegExp]> = [
    [
      "an empty authorizationList",
      { ...TX4, authorizationList: [] },
      /non-empty authorizationList/,
    ],
    [
      "a missing authorizationList",
      { ...TX4, authorizationList: undefined },
      /non-empty authorizationList/,
    ],
    ["a missing to (no contract creation)", { ...TX4, to: "" }, /Missing 'to'/],
    [
      "no fee-market fields",
      {
        ...TX4,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      },
      /EIP-7702 transactions require maxFeePerGas/,
    ],
    [
      "an authorization for another chain",
      { ...TX4, authorizationList: [SIGNED_REVOKE] },
      /does not match transaction chainId/,
    ],
    [
      "an any-chain authorization",
      { ...TX4, authorizationList: [{ ...SIGNED_AUTH, chainId: 0 }] },
      /does not match transaction chainId/,
    ],
    [
      "an authorization with a malformed signature",
      { ...TX4, authorizationList: [{ ...SIGNED_AUTH, r: "0x01" }] },
      /r and s must be 32-byte/,
    ],
    [
      "an authorization with yParity outside 0/1",
      {
        ...TX4,
        authorizationList: [
          { ...SIGNED_AUTH, yParity: 27 as unknown as 0 | 1 },
        ],
      },
      /yParity must be 0 or 1/,
    ],
    [
      "an authorization with a high-s signature",
      {
        ...TX4,
        authorizationList: [
          {
            ...SIGNED_AUTH,
            // n - s with the parity flipped: the same signature's high-s twin.
            s: `0x${(SECP256K1_N - BigInt(SIGNED_AUTH.s)).toString(16).padStart(64, "0")}`,
            yParity: 0,
          },
        ],
      },
      /secp256k1 range/,
    ],
    [
      "an authorizationList on a type-2 transaction",
      { ...TX2, authorizationList: [SIGNED_AUTH] },
      /only valid on an EIP-7702 transaction/,
    ],
    [
      "an authorizationList with no type (never auto-detected)",
      { ...TX2, type: undefined, authorizationList: [SIGNED_AUTH] },
      /only valid on an EIP-7702 transaction/,
    ],
  ];

  it.each(cases)("refuses %s", (_name, tx, message) => {
    expect(() => transactionSigningHash(tx)).toThrow(message);
  });

  it("reports refusals from the signer as invalid_input", async () => {
    await expect(
      signer.signTransaction({ ...TX4, authorizationList: [] }, PK),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
