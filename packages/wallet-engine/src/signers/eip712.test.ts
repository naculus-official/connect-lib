import { describe, expect, it } from "vitest";
import { EVMSigner } from "./evm";

/**
 * The shared EIP-712 encoder (eip712.ts), pinned through EVMSigner. Each
 * signature was produced by viem 2.56.5 signTypedData for the same key and
 * data, and by this encoder before it moved out of evm.ts.
 */
const PK = `0x${"42".repeat(32)}` as `0x${string}`;
const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const MAIL = {
  domain: {
    name: "Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  types: {
    EIP712Domain: DOMAIN_TYPE,
    Person: [
      { name: "name", type: "string" },
      { name: "wallets", type: "address[]" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person[]" },
      { name: "contents", type: "string" },
      { name: "flag", type: "bool" },
      { name: "delta", type: "int64" },
      { name: "id", type: "bytes32" },
      { name: "blob", type: "bytes" },
    ],
  },
  primaryType: "Mail",
  message: {
    from: {
      name: "Cow",
      wallets: ["0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"],
    },
    to: [
      { name: "Bob", wallets: [] },
      {
        name: "Eve",
        wallets: [
          "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
          "0xB0B0b0b0b0b0B000000000000000000000000000",
        ],
      },
    ],
    contents: "Hello, Bob! é",
    flag: true,
    delta: "-42",
    id: `0x${"ab".repeat(32)}`,
    blob: "0x0102",
  },
};

const TRANSFER = {
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  types: {
    EIP712Domain: DOMAIN_TYPE,
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: "0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025",
    to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    value: "1500000",
    validAfter: "0",
    validBefore: "1790000000",
    nonce: `0x${"cd".repeat(32)}`,
  },
};

describe("EIP-712 encoder", () => {
  it.each([
    [
      "nested structs, struct arrays, bytes, bool, negative int64",
      MAIL,
      "0xedb491966740d68a16fb2d5a3c28f331ad8d50f19b9b066919733be0cfdaee11190bbf6e8f1344c35b2bac3cf0adfbf3e4c9cce3186ff60061df2419149a7e691b",
    ],
    [
      "EIP-3009 TransferWithAuthorization",
      TRANSFER,
      "0xfeaca81348d938097fea6ebb915b31ce01d2a2db26ba99bfbbeb0d2e59d5d7723ead5dc24e916644285f1e127a4ec521f021b32f33764eb7da03b9803bab86241b",
    ],
  ])("matches viem: %s", async (_name, typedData, expected) => {
    await expect(
      new EVMSigner().signTypedData(JSON.stringify(typedData), PK),
    ).resolves.toMatchObject({ signature: expected });
  });

  it("includes struct types referenced through fixed and nested arrays", async () => {
    // viem 2.56.5 vector. `P[2]` and `P[][]` used to drop P from the
    // encoded type string, so the signature matched no verifier.
    const typedData = {
      domain: {
        name: "Arr",
        version: "1",
        chainId: 1,
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      },
      types: {
        EIP712Domain: DOMAIN_TYPE,
        P: [{ name: "n", type: "string" }],
        M: [
          { name: "fixed", type: "P[2]" },
          { name: "nested", type: "P[][]" },
        ],
      },
      primaryType: "M",
      message: { fixed: [{ n: "a" }, { n: "b" }], nested: [[{ n: "c" }], []] },
    };
    await expect(
      new EVMSigner().signTypedData(JSON.stringify(typedData), PK),
    ).resolves.toMatchObject({
      signature:
        "0x3f8d85990056676dc430f9c76e3dbcf0296f57ff55bcbc6e9e621c3011b3560f2a7dac2cfc7249a07daf2a84c1554b04c3aa3dff4fc5e38d84003f000c377c5a1c",
    });
  });
});
