import { describe, expect, it } from "vitest";
import { EVMSigner } from "./evm";

const testPk = `0x${"ab".repeat(32)}` as `0x${string}`;
const signer = new EVMSigner();

function decodeLegacyList(hex: string): string[] {
  const bytes = hexToBytes(hex.slice(2));
  const listPrefix = bytes[0];
  const listLength =
    listPrefix <= 0xf7
      ? listPrefix - 0xc0
      : Number(
          BigInt(`0x${bytesToHex(bytes.slice(1, 1 + listPrefix - 0xf7))}`),
        );
  let offset = listPrefix <= 0xf7 ? 1 : 1 + listPrefix - 0xf7;
  const end = offset + listLength;
  const items: string[] = [];
  while (offset < end) {
    const prefix = bytes[offset];
    let length: number;
    let header = 1;
    if (prefix <= 0x7f) {
      length = 1;
      header = 0;
    } else if (prefix <= 0xb7) length = prefix - 0x80;
    else {
      header += prefix - 0xb7;
      length = Number(
        BigInt(`0x${bytesToHex(bytes.slice(offset + 1, offset + header))}`),
      );
    }
    const start = offset + header;
    items.push(bytesToHex(bytes.slice(start, start + length)));
    offset = start + length;
  }
  return items;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("EVMSigner", () => {
  it("chainType is eip155", () => {
    expect(signer.chainType).toBe("eip155");
  });

  it("rejects malformed or out-of-range private keys", async () => {
    await expect(
      signer.signMessage({ message: "test" }, "0x1234" as `0x${string}`),
    ).rejects.toMatchObject({ code: "invalid_key" });
    await expect(
      signer.signTransaction(
        {
          to: "0x" + "12".repeat(20),
          chainId: 1,
        },
        ("0x" + "00".repeat(32)) as `0x${string}`,
      ),
    ).rejects.toMatchObject({ code: "invalid_key" });
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
    const fields = decodeLegacyList(result.signature);
    expect(Number.parseInt(fields[6], 16)).toBeGreaterThanOrEqual(37);
    expect(Number.parseInt(fields[6], 16)).toBeLessThanOrEqual(38);
    expect(result.signature).toBe(
      "0xf864808504a817c800825208941212121212121212121212121212121212121212808025a064c229102df316c18ad7b3d9afbe2c99207288fda8a209138bc31d899e058ea2a05caab86e2e9c75811e3d6907b612777d104c73b8c4d1cd0d83475b4115eae8ad",
    );
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
    expect(result.signature).toBe(
      "0x02f86b01808459682f008504a817c8008252089412121212121212121212121212121212121212128080c080a0ee40da1d04243c7bda2d9c4f0fbf19d744ee139af665b8e3c81870190d477eada07674cdadcd58345aa353e5d52ec2d5eb70bdf58a875e93a684fcb40fc84eb59a",
    );
  });

  it("rejects conflicting or ignored transaction fee type fields", async () => {
    const base = {
      to: "0x" + "12".repeat(20),
      chainId: 1,
    } as const;
    await expect(
      signer.signTransaction(
        {
          ...base,
          type: "legacy",
          maxFeePerGas: "0x2",
        },
        testPk,
      ),
    ).rejects.toThrow("Legacy transactions cannot include EIP-1559 fee fields");
    await expect(
      signer.signTransaction(
        { ...base, type: "eip1559", gasPrice: "0x1" },
        testPk,
      ),
    ).rejects.toThrow(
      "EIP-1559 transactions require maxFeePerGas or maxPriorityFeePerGas",
    );
    await expect(
      signer.signTransaction(
        { ...base, maxFeePerGas: "0x2", gasPrice: "0x1" },
        testPk,
      ),
    ).rejects.toThrow("EIP-1559 transactions cannot include gasPrice");
    await expect(
      signer.signTransaction({ ...base, maxPriorityFeePerGas: "0x2" }, testPk),
    ).rejects.toThrow("maxPriorityFeePerGas cannot exceed maxFeePerGas");
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

  it("matches the canonical EIP-712 digest for a known vector", async () => {
    const typedData = {
      domain: {
        name: "Test Token",
        version: "1",
        chainId: 1,
        verifyingContract:
          "0x0000000000000000000000000000000000000000" as const,
      },
      types: {
        Message: [
          { name: "content", type: "string" },
          { name: "value", type: "uint256" },
        ],
      },
      primaryType: "Message" as const,
      message: { content: "Hello", value: 42n },
    } as const;
    const result = await signer.signTypedData(
      JSON.stringify({
        ...typedData,
        message: { content: "Hello", value: 42 },
      }),
      testPk,
    );
    expect(result.signature).toBe(
      "0x94ecf6be02dc7590079aa7980219c45772e5f63ae5b87ba6bccf8de8a9e0dfee6c7906bba660aeb549fd492d6ce1d577547643a65e29ea0424c84a67eb2cfd481c",
    );
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

  it("sign-extends negative intN to 256 bits, as ABI encoding does", async () => {
    // Vector: viem 2.56.5 signTypedData for the same key and data. The
    // encoder used 2^N for a negative intN < int256, so these signatures
    // matched no verifier.
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
    await expect(
      signer.signTypedData(typedData, testPk),
    ).resolves.toMatchObject({
      signature:
        "0x5db99addec464352531f1314a4450b963a5c2ab5afd0c1607bf6ebca1ca650d239de6549b2fd294ba4381a8169bf0f1887e8130118afcc277887c5303e629bb31c",
    });
  });

  it("rejects unsafe JavaScript numbers in EIP-712 integers", async () => {
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [],
        Message: [{ name: "value", type: "uint256" }],
      },
      primaryType: "Message",
      message: { value: Number.MAX_SAFE_INTEGER + 2 },
    });
    await expect(signer.signTypedData(typedData, testPk)).rejects.toThrow(
      "safe integers",
    );
  });

  it("rejects missing or non-string EIP-712 fields", async () => {
    const base = {
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Message: [{ name: "text", type: "string" }],
      },
      primaryType: "Message",
      domain: { name: "Test" },
    };

    await expect(
      signer.signTypedData(JSON.stringify({ ...base, message: {} }), testPk),
    ).rejects.toThrow("Missing EIP-712 field: Message.text");
    await expect(
      signer.signTypedData(
        JSON.stringify({ ...base, message: { text: 123 } }),
        testPk,
      ),
    ).rejects.toThrow("Invalid EIP-712 string");
  });
});
