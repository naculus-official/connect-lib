import { describe, expect, it } from "vitest";
import { EVMSigner } from "./evm";

const testPk = `0x${"ab".repeat(32)}` as `0x${string}`;
const signer = new EVMSigner();

describe("EVMSigner", () => {
  it("chainType is eip155", () => {
    expect(signer.chainType).toBe("eip155");
  });

  it("signMessage produces valid 65-byte signature", async () => {
    const result = await signer.signMessage({ message: "Hello World" }, testPk);
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(typeof result.recovery).toBe("number");
  });

  it("signTransaction legacy", async () => {
    const result = await signer.signTransaction(
      {
        to: "0x" + "12".repeat(20),
        value: "0x0",
        nonce: "0x0",
        gasPrice: "0x4a817c800",
        gas: "0x5208",
        chainId: 1,
      },
      testPk,
    );
    expect(result.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(result.signature.length).toBeGreaterThan(200);
  });

  it("signTransaction EIP-1559", async () => {
    const result = await signer.signTransaction(
      {
        to: "0x" + "12".repeat(20),
        value: "0x0",
        nonce: "0x0",
        maxFeePerGas: "0x4a817c800",
        maxPriorityFeePerGas: "0x59682f00",
        gas: "0x5208",
        chainId: 1,
      },
      testPk,
    );
    expect(result.signature).toMatch(/^0x02[0-9a-f]+$/); // 0x02 prefix for type 2
  });

  it("signTransaction with long data (triggers toRlpBytes long path)", async () => {
    // data > 55 bytes triggers the long path in toRlpBytes (line 72-73)
    const longData = "0x" + "ab".repeat(100);
    const result = await signer.signTransaction(
      {
        to: "0x" + "12".repeat(20),
        value: "0x0",
        nonce: "0x0",
        gasPrice: "0x4a817c800",
        gas: "0x5208",
        chainId: 1,
        data: longData,
      },
      testPk,
    );
    expect(result.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it("signTransaction with long data EIP-1559 (long path)", async () => {
    const longData = "0x" + "ab".repeat(100);
    const result = await signer.signTransaction(
      {
        to: "0x" + "12".repeat(20),
        value: "0x0",
        nonce: "0x0",
        maxFeePerGas: "0x4a817c800",
        maxPriorityFeePerGas: "0x59682f00",
        gas: "0x5208",
        chainId: 1,
        data: longData,
      },
      testPk,
    );
    expect(result.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("signTransaction with large chainId (chainId > 0x7f)", async () => {
    // chainId > 127 requires multi-byte RLP encoding
    const result = await signer.signTransaction(
      {
        to: "0x" + "12".repeat(20),
        value: "0x0",
        nonce: "0x0",
        gasPrice: "0x4a817c800",
        gas: "0x5208",
        chainId: 137, // Polygon
      },
      testPk,
    );
    expect(result.signature).toMatch(/^0x[0-9a-f]+$/);
  });
});

describe("EVMSigner — signTypedData (EIP-712)", () => {
  it("signs a basic typed data message", async () => {
    const typedData = JSON.stringify({
      domain: {
        name: "Test Token",
        version: "1",
        chainId: 1,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Message: [
          { name: "content", type: "string" },
          { name: "value", type: "uint256" },
        ],
      },
      primaryType: "Message",
      message: {
        content: "Hello",
        value: 42,
      },
    });

    const result = await signer.signTypedData(typedData, testPk);
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(typeof result.recovery).toBe("number");
  });

  it("signs typed data with nested structs", async () => {
    const typedData = JSON.stringify({
      domain: {
        name: "For",
        version: "1",
        chainId: 1,
      },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
        Mail: [
          { name: "from", type: "Person" },
          { name: "to", type: "Person" },
          { name: "contents", type: "string" },
        ],
      },
      primaryType: "Mail",
      message: {
        from: {
          name: "Alice",
          wallet: "0x" + "12".repeat(20),
        },
        to: {
          name: "Bob",
          wallet: "0x" + "34".repeat(20),
        },
        contents: "Hello!",
      },
    });

    const result = await signer.signTypedData(typedData, testPk);
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("signs typed data with bool and bytes32 fields", async () => {
    const typedData = JSON.stringify({
      domain: {
        name: "BoolTest",
        version: "1",
        chainId: 1,
      },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Test: [
          { name: "active", type: "bool" },
          { name: "hash", type: "bytes32" },
          { name: "count", type: "uint256" },
        ],
      },
      primaryType: "Test",
      message: {
        active: true,
        hash: "0x" + "ff".repeat(32),
        count: 999,
      },
    });

    const result = await signer.signTypedData(typedData, testPk);
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("handles unknown primaryType (no matching fields)", async () => {
    const typedData = JSON.stringify({
      domain: { name: "Test", version: "1", chainId: 1 },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        UnknownType: [],
      },
      primaryType: "UnknownType",
      message: {},
    });

    const result = await signer.signTypedData(typedData, testPk);
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});

describe("EVMSigner — signTypedData edge cases", () => {
  it("signs with minimal empty domain", async () => {
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [],
        Message: [{ name: "data", type: "string" }],
      },
      primaryType: "Message",
      message: { data: "test" },
    });

    const result = await signer.signTypedData(typedData, testPk);
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("signs with int256 field", async () => {
    const typedData = JSON.stringify({
      domain: { name: "IntTest", version: "1", chainId: 1 },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Test: [{ name: "value", type: "int256" }],
      },
      primaryType: "Test",
      message: { value: -42 },
    });

    const result = await signer.signTypedData(typedData, testPk);
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
