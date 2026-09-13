import { describe, expect, it } from "vitest";
import {
  caip2ToHexChain,
  hexChainToCaip2,
  normalizeEip5792Capabilities,
  readAtomicSupport,
} from "./eip5792";

/**
 * These lock the two ways the inline decoders were wrong before this module
 * existed: reading `{ supported: false }` as truthy (a fabricated yes), and
 * accepting only `status: "supported"` while EIP-5792 2.0.0 also defines
 * "ready" as support.
 */

describe("hexChainToCaip2", () => {
  it.each([
    ["0x1", "eip155:1"],
    ["0x89", "eip155:137"],
    ["0xa4b1", "eip155:42161"],
    ["0xA4B1", "eip155:42161"],
  ])("%s -> %s", (hex, caip2) => {
    expect(hexChainToCaip2(hex)).toBe(caip2);
  });

  it.each(["0x0", "0x", "1", "eip155:1", "", "0xzz", "0x-1"])(
    "rejects %o rather than coercing it",
    (bad) => {
      expect(hexChainToCaip2(bad)).toBeUndefined();
    },
  );

  it("round-trips with caip2ToHexChain", () => {
    for (const chain of ["eip155:1", "eip155:137", "eip155:42161"]) {
      expect(hexChainToCaip2(caip2ToHexChain(chain) as string)).toBe(chain);
    }
  });
});

describe("caip2ToHexChain", () => {
  it("rejects a non-EVM namespace", () => {
    expect(caip2ToHexChain("solana:abc")).toBeUndefined();
    expect(caip2ToHexChain("xrpl:0")).toBeUndefined();
  });

  it("rejects a leading-zero reference, which CAIP-2 does not permit", () => {
    expect(caip2ToHexChain("eip155:01")).toBeUndefined();
  });
});

describe("readAtomicSupport", () => {
  it.each([
    ["supported", true],
    ["ready", true],
    ["unsupported", false],
  ])("2.0.0 status %s -> %s", (status, expected) => {
    expect(readAtomicSupport({ atomic: { status } }).supported).toBe(expected);
  });

  it("does not read an explicit draft-shape no as a yes", () => {
    // Boolean({ supported: false }) is true. That inversion told wallets which
    // had said they cannot batch that they can.
    expect(readAtomicSupport({ atomicBatch: { supported: false } }).supported).toBe(
      false,
    );
  });

  it("reads a draft-shape yes", () => {
    expect(readAtomicSupport({ atomicBatch: { supported: true } })).toEqual({
      supported: true,
      maxBatchSize: undefined,
    });
  });

  it("carries an advertised batch limit", () => {
    expect(
      readAtomicSupport({ atomicBatch: { supported: true, maxBatchSize: 8 } }),
    ).toMatchObject({ supported: true, maxBatchSize: 8 });
  });

  it("ignores a nonsensical batch limit", () => {
    expect(
      readAtomicSupport({ atomicBatch: { supported: true, maxBatchSize: 0 } })
        .maxBatchSize,
    ).toBeUndefined();
  });

  it("prefers the 2.0.0 shape when a wallet sends both", () => {
    expect(
      readAtomicSupport({
        atomic: { status: "unsupported" },
        atomicBatch: { supported: true },
      }).supported,
    ).toBe(false);
  });

  it("reports no support for an entry that mentions neither", () => {
    expect(readAtomicSupport({}).supported).toBe(false);
    expect(readAtomicSupport({ paymasterService: { supported: true } }).supported)
      .toBe(false);
  });

  it("survives wallets sending the wrong types", () => {
    expect(readAtomicSupport({ atomic: "supported" }).supported).toBe(false);
    expect(readAtomicSupport({ atomic: { status: 1 } }).supported).toBe(false);
    expect(readAtomicSupport({ atomicBatch: "yes" }).supported).toBe(false);
  });
});

describe("normalizeEip5792Capabilities", () => {
  it("rekeys by CAIP-2", () => {
    const caps = normalizeEip5792Capabilities({
      "0x1": { atomic: { status: "supported" } },
      "0x89": { atomic: { status: "unsupported" } },
    });
    expect(caps["eip155:1"].atomicBatch.supported).toBe(true);
    expect(caps["eip155:137"].atomicBatch.supported).toBe(false);
    expect(caps["0x1"]).toBeUndefined();
  });

  it("omits chains the wallet did not mention instead of denying them", () => {
    const caps = normalizeEip5792Capabilities({ "0x1": {} });
    expect(Object.keys(caps)).toEqual(["eip155:1"]);
    expect(caps["eip155:137"]).toBeUndefined();
  });

  it("drops keys it cannot interpret", () => {
    const caps = normalizeEip5792Capabilities({
      "0x1": { atomic: { status: "supported" } },
      "0x0": { atomic: { status: "supported" } },
      mainnet: { atomic: { status: "supported" } },
    });
    expect(Object.keys(caps)).toEqual(["eip155:1"]);
  });

  it("reports paymaster support only on an explicit true", () => {
    expect(
      normalizeEip5792Capabilities({
        "0x1": { paymasterService: { supported: true } },
      })["eip155:1"].paymasterService,
    ).toEqual({ supported: true });
    expect(
      normalizeEip5792Capabilities({
        "0x1": { paymasterService: { supported: false } },
      })["eip155:1"].paymasterService,
    ).toBeUndefined();
    expect(
      normalizeEip5792Capabilities({ "0x1": { paymasterService: {} } })[
        "eip155:1"
      ].paymasterService,
    ).toBeUndefined();
  });

  it.each([null, undefined, "nope", 42, []])(
    "returns an empty record for %o rather than throwing",
    (bad) => {
      expect(normalizeEip5792Capabilities(bad)).toEqual({});
    },
  );

  it("skips a chain entry that is not an object", () => {
    expect(normalizeEip5792Capabilities({ "0x1": null, "0x89": "yes" })).toEqual(
      {},
    );
  });
});
