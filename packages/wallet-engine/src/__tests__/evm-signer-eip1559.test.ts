import { describe, it, expect } from "vitest";
import { EVMSigner } from "../signers/evm";
import type { TransactionRequest } from "../signers/types";
import { WalletError } from "../errors";

const signer = new EVMSigner();
const TEST_KEY = "0x" + "ab".repeat(32);
const TEST_TO = "0x" + "cd".repeat(20);

/**
 * Helper: parse a hex string into a Uint8Array
 */
function hexToBytes(h: string): Uint8Array {
  const raw = h.startsWith("0x") ? h.slice(2) : h;
  const b = new Uint8Array(raw.length / 2);
  for (let i = 0; i < raw.length; i += 2) b[i / 2] = parseInt(raw.slice(i, i + 2), 16);
  return b;
}

describe("EVMSigner EIP-1559", () => {
  describe("signTransaction with EIP-1559 fields", () => {
    it("should produce a type 2 (0x02) prefixed signature", async () => {
      const tx: TransactionRequest = {
        to: TEST_TO,
        value: "0x0",
        nonce: "0x0",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x3b9aca00",
        gas: "0x5208",
        chainId: 1,
      };

      const result = await signer.signTransaction(tx, TEST_KEY);
      const sigBytes = result.signature.slice(2); // remove 0x
      expect(sigBytes.slice(0, 2)).toBe("02"); // type prefix
      expect(result.signature).toMatch(/^0x02[0-9a-f]+$/);
    });

    it("should produce a deterministic signature", async () => {
      const tx: TransactionRequest = {
        to: TEST_TO,
        value: "0x0",
        nonce: "0x0",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x3b9aca00",
        gas: "0x5208",
        chainId: 1,
      };

      const r1 = await signer.signTransaction(tx, TEST_KEY);
      const r2 = await signer.signTransaction(tx, TEST_KEY);
      expect(r1.signature).toBe(r2.signature);
    });

    it("should still produce legacy signatures when only gasPrice is provided", async () => {
      const tx: TransactionRequest = {
        to: TEST_TO,
        value: "0x0",
        nonce: "0x0",
        gasPrice: "0x4a817c800",
        gas: "0x5208",
        chainId: 1,
      };

      const result = await signer.signTransaction(tx, TEST_KEY);
      // Legacy signature is raw RLP, no type prefix 0x02
      expect(result.signature).toMatch(/^0x[0-9a-f]+$/);
      // Should NOT start with 02
      expect(result.signature.slice(2, 4)).not.toBe("02");
    });

    it("should handle missing optional fields with defaults", async () => {
      const tx: TransactionRequest = {
        to: TEST_TO,
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x50",
        chainId: 1,
      };

      const result = await signer.signTransaction(tx, TEST_KEY);
      expect(result.signature).toMatch(/^0x02[0-9a-f]+$/);
    });

    it("should throw when missing to address", async () => {
      await expect(
        signer.signTransaction({} as any, TEST_KEY),
      ).rejects.toThrow("Missing 'to' address");
    });

    it("should encode variable-length nonce correctly", async () => {
      const tx: TransactionRequest = {
        to: TEST_TO,
        value: "0x0",
        nonce: "0xff", // 255 — single byte > 0x80, needs length prefix
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x50",
        gas: "0x5208",
        chainId: 1,
      };

      const result = await signer.signTransaction(tx, TEST_KEY);
      expect(result.signature).toMatch(/^0x02[0-9a-f]+$/);
    });
  });
});
