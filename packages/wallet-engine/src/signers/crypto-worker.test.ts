import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Drives the real crypto worker over its own message protocol.
 *
 * The existing IsolatedSigner tests substitute a MockWorker that returns a
 * canned signature, so the worker's own RLP encoding had no coverage at all.
 * That is how a quantity encoder that rejected roughly 18% of the signatures
 * it was handed reached the release gate unnoticed: secp256k1 r/s are fixed
 * 32-byte values, so a leading zero nibble is common, and the gate's worker
 * probe fails at asset load long before it reaches a signature.
 */

type Reply = {
  id?: string;
  type: string;
  signature?: string;
  authorization?: unknown;
  error?: string;
};

let onmessage: (e: { data: unknown }) => Promise<void>;
let replies: Reply[];

const TEST_KEY = `0x${"ab".repeat(32)}`;
const TO = "0x1111111111111111111111111111111111111111";

async function send(type: string, payload: unknown): Promise<Reply> {
  const id = `req-${replies.length}`;
  await onmessage({ data: { type, payload, id } });
  const reply = replies.find((r) => r.id === id);
  if (!reply) throw new Error(`worker sent no reply for ${type}`);
  return reply;
}

beforeAll(async () => {
  replies = [];
  vi.stubGlobal("self", {
    onmessage: null,
    postMessage: (msg: Reply) => replies.push(msg),
  });
  await import("./crypto-worker");
  onmessage = (
    globalThis as unknown as { self: { onmessage: typeof onmessage } }
  ).self.onmessage;
  expect(onmessage).toBeTypeOf("function");

  const ready = await send("initWithKey", { privateKey: TEST_KEY });
  expect(ready.type).toBe("ready");
});

describe("crypto worker signing", () => {
  it("signs every legacy transaction regardless of r/s leading zeros", async () => {
    const failures: string[] = [];
    for (let i = 1; i <= 300; i++) {
      const reply = await send("signTransaction", {
        to: TO,
        nonce: `0x${i.toString(16)}`,
        gasPrice: "0x3b9aca00",
        gas: "0x5208",
        value: "0x0",
        chainId: 1,
        type: "legacy",
      });
      if (reply.type !== "signed") failures.push(`nonce ${i}: ${reply.error}`);
    }
    expect(failures).toEqual([]);
  });

  it("signs every EIP-1559 transaction regardless of r/s leading zeros", async () => {
    const failures: string[] = [];
    for (let i = 1; i <= 300; i++) {
      const reply = await send("signTransaction", {
        to: TO,
        nonce: `0x${i.toString(16)}`,
        maxFeePerGas: "0x3b9aca00",
        maxPriorityFeePerGas: "0x3b9aca00",
        gas: "0x5208",
        value: "0x0",
        chainId: 1,
        type: "eip1559",
      });
      if (reply.type !== "signed") failures.push(`nonce ${i}: ${reply.error}`);
    }
    expect(failures).toEqual([]);
  });

  it("still rejects non-canonical caller-supplied quantities", async () => {
    const reply = await send("signTransaction", {
      to: TO,
      nonce: "0x01",
      gasPrice: "0x3b9aca00",
      gas: "0x5208",
      chainId: 1,
      type: "legacy",
    });
    expect(reply.type).toBe("error");
    expect(reply.error).toMatch(/canonical/);
  });

  // Vectors from viem 2.56.5 for the same key; see evm-tx.test.ts. The worker
  // must produce the same bytes as EVMSigner because both use evm-tx.ts.
  const DELEGATE = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
  const SIGNED_AUTH = {
    chainId: 1,
    address: DELEGATE,
    nonce: "0x7",
    yParity: 1,
    r: "0x8590d30e098d3e27cd8e83b30b6965999605a2129f77b170dec7af1762a9e1c5",
    s: "0x41f93e1aa5100e4ff37f1cf8c61d39d289b93cb994cbd27bc62db429919c149b",
  };

  it("signs an EIP-7702 authorization without exposing the key", async () => {
    const reply = await send("signAuthorization", {
      authorization: { chainId: 1, address: DELEGATE, nonce: "0x7" },
    });
    expect(reply.type).toBe("signedAuthorization");
    expect(reply.authorization).toEqual(SIGNED_AUTH);
  });

  it("refuses an any-chain authorization unless explicitly allowed", async () => {
    const auth = { chainId: 0, address: DELEGATE, nonce: "0x1" };
    const refused = await send("signAuthorization", { authorization: auth });
    expect(refused.type).toBe("error");
    expect(refused.error).toMatch(/chainId 0/);

    const allowed = await send("signAuthorization", {
      authorization: auth,
      options: { unsafeAllowAnyChainAuthorization: true },
    });
    expect(allowed.type).toBe("signedAuthorization");
  });

  it("signs a type-4 transaction byte-for-byte as EVMSigner does", async () => {
    const reply = await send("signTransaction", {
      type: "eip7702",
      chainId: 1,
      nonce: "0x6",
      maxPriorityFeePerGas: "0x3b9aca00",
      maxFeePerGas: "0x6fc23ac00",
      gas: "0x186a0",
      to: "0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6",
      value: "0x0",
      data: "0xdeadbeef",
      authorizationList: [SIGNED_AUTH],
    });
    expect(reply.signature).toBe(
      "0x04f8ce0106843b9aca008506fc23ac00830186a094e239cdc5fbe977a8a141b72194d3cf8c41bc5bc68084deadbeefc0f85cf85a019463c0c19a282a1b52b07dd5a65b58948a07dae32b0701a08590d30e098d3e27cd8e83b30b6965999605a2129f77b170dec7af1762a9e1c5a041f93e1aa5100e4ff37f1cf8c61d39d289b93cb994cbd27bc62db429919c149b80a04915ac8dfea93ef28483d163fb90c66d4cef0c17a91569fa1165e9aecda8e6f1a02b47f7d85a2e092d052ade0d14b1a355d1e8c93ead82378abd23c074eb97a177",
    );
  });

  it("refuses a type-4 transaction with an empty authorizationList", async () => {
    const reply = await send("signTransaction", {
      type: "eip7702",
      chainId: 1,
      maxFeePerGas: "0x1",
      to: TO,
      authorizationList: [],
    });
    expect(reply.type).toBe("error");
    expect(reply.error).toMatch(/non-empty authorizationList/);
  });

  it("signs EIP-712 typed data with the shared encoder (viem vector)", async () => {
    // Same key and data as the negative-intN vector in evm.test.ts, from
    // viem 2.56.5 signTypedData.
    const typedData = JSON.stringify({
      domain: {
        name: "Ints",
        version: "1",
        chainId: 1,
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        M: [
          { name: "a", type: "int8" },
          { name: "b", type: "int64" },
          { name: "c", type: "int256" },
          { name: "d", type: "int64" },
        ],
      },
      primaryType: "M",
      message: { a: "-1", b: "-42", c: "-7", d: "5" },
    });
    const reply = await send("signTypedData", { typedData });
    expect(reply.type).toBe("signed");
    expect(reply.signature).toBe(
      "0x5db99addec464352531f1314a4450b963a5c2ab5afd0c1607bf6ebca1ca650d239de6549b2fd294ba4381a8169bf0f1887e8130118afcc277887c5303e629bb31c",
    );
    const refused = await send("signTypedData", { typedData: 42 });
    expect(refused.type).toBe("error");
  });
});
