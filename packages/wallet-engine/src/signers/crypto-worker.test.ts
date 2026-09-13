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

type Reply = { id?: string; type: string; signature?: string; error?: string };

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
});
