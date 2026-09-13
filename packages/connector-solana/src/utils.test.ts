import { describe, expect, it } from "vitest";
import { GENESIS_HASHES, HASH_TO_CHAIN } from "./utils";

/**
 * CAIP-2's solana namespace defines the reference as truncate(genesisHash, 32).
 * That makes the table self-checkable, which matters because it was not:
 * mainnet stored the truncated reference in the `hash` field (23 bytes once
 * base58-decoded, so not a hash at all) and testnet stored a value that
 * matched nothing on chain — so HASH_TO_CHAIN could never resolve a real
 * testnet genesis hash. Verified against getGenesisHash on 2026-09-02.
 */
describe("Solana CAIP-2 genesis hash table", () => {
  it.each(Object.entries(GENESIS_HASHES))(
    "%s derives its CAIP-2 reference from its genesis hash",
    (chainId, info) => {
      const reference = chainId.slice("solana:".length);
      expect(info.hash.slice(0, 32)).toBe(reference);
    },
  );

  it.each(Object.entries(GENESIS_HASHES))(
    "%s stores a full 32-byte genesis hash, not the truncated reference",
    (_chainId, info) => {
      // base58 of 32 bytes is 43-44 characters; the 32-char reference is not one.
      expect(info.hash.length).toBeGreaterThanOrEqual(43);
    },
  );

  it("resolves every stored genesis hash back to its chain id", () => {
    for (const [chainId, info] of Object.entries(GENESIS_HASHES)) {
      expect(HASH_TO_CHAIN[info.hash.slice(0, 32)]).toBe(chainId);
    }
  });
});
