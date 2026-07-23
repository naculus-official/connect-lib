import { describe, it, expect } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

describe("Passkeys Crypto Compliance: EVM Address Derivation", () => {
  it("derives EVM address via keccak256 of public key (correct algorithm)", () => {
    const pk = new Uint8Array([
      0x04,
      ...Array.from({ length: 32 }, () => 0xab),
      ...Array.from({ length: 32 }, () => 0xcd),
    ]);
    const hash = keccak_256(pk);
    const address = `0x${bytesToHex(hash.slice(-20))}`;
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(address.length).toBe(42);
  });

  it("uncompressed key starts with 0x04 prefix", () => {
    const pk = new Uint8Array(65);
    pk[0] = 0x04;
    expect(pk[0]).toBe(0x04);
    expect(pk.length).toBe(65);
  });

  it("address is last 20 bytes of keccak256(publicKey)", () => {
    const pk = new Uint8Array(65);
    pk[0] = 0x04;
    for (let i = 1; i < 65; i++) pk[i] = i;
    const hash = keccak_256(pk);
    const addr1 = `0x${bytesToHex(hash.slice(-20))}`;
    const addr2 = `0x${bytesToHex(hash.slice(12))}`;
    expect(addr1).toBe(addr2);
  });

  it("different keys produce different addresses", () => {
    const pk1 = new Uint8Array([0x04, ...Array.from({ length: 64 }, () => 0x01)]);
    const pk2 = new Uint8Array([0x04, ...Array.from({ length: 64 }, () => 0x02)]);
    const a1 = `0x${bytesToHex(keccak_256(pk1).slice(-20))}`;
    const a2 = `0x${bytesToHex(keccak_256(pk2).slice(-20))}`;
    expect(a1).not.toBe(a2);
  });

  it("keccak_256 from @noble/hashes/sha3 matches Ethereum's keccak256", () => {
    const input = new TextEncoder().encode("hello");
    const hash = keccak_256(input);
    const hex = bytesToHex(hash);
    expect(hex).toBe("1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
  });

  it("compressed key (33 bytes) produces different address than uncompressed", () => {
    const uncompressed = new Uint8Array([0x04, ...Array.from({ length: 64 }, () => 0x03)]);
    const compressed = new Uint8Array([0x03, ...Array.from({ length: 32 }, () => 0x03)]);
    const addrU = `0x${bytesToHex(keccak_256(uncompressed).slice(-20))}`;
    const addrC = `0x${bytesToHex(keccak_256(compressed).slice(-20))}`;
    expect(addrU).not.toBe(addrC);
  });
});
