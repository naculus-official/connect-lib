import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";

/**
 * Base58 length regression.
 *
 * SNS resolution used a hand-written base58 pair. Its decoder added one byte
 * whenever the decoded value was zero: `num.toString(16)` gives "0", which
 * pads to one byte, and that byte was then added on top of the counted leading
 * zeros. The all-zeros Solana System Program ID came back as 33 bytes.
 *
 * Those bytes are hashed into a program-derived address, so a length that is
 * off by one does not fail loudly — it derives a different, valid-looking
 * address, and a `.sol` name resolves to an account that is not the owner's.
 *
 * These cases are the ones the old implementation got wrong.
 */

describe("base58 decoding for SNS", () => {
  it.each([
    ["1", 1],
    ["11", 2],
    ["111", 3],
    // The Solana System Program ID: 32 zero bytes.
    ["11111111111111111111111111111111", 32],
  ])("decodes %o to %i bytes", (input, length) => {
    const bytes = base58.decode(input);
    expect(bytes).toHaveLength(length);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it("decodes a real Solana address to 32 bytes", () => {
    expect(
      base58.decode("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb"),
    ).toHaveLength(32);
  });

  it("decodes the SNS TLD authority to 32 bytes", () => {
    expect(
      base58.decode("58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx"),
    ).toHaveLength(32);
  });

  it("round-trips an address whose leading bytes are zero", () => {
    // The case that distinguishes a correct implementation: leading zeros are
    // carried as "1"s and must survive both directions without gaining a byte.
    const bytes = new Uint8Array(32);
    bytes[31] = 1;
    const encoded = base58.encode(bytes);
    expect(encoded.startsWith("1")).toBe(true);
    expect(base58.decode(encoded)).toEqual(bytes);
  });

  it("round-trips all-zero bytes", () => {
    const bytes = new Uint8Array(32);
    expect(base58.decode(base58.encode(bytes))).toEqual(bytes);
  });

  it("rejects a character outside the alphabet", () => {
    // 0, O, I and l are excluded so an address cannot be misread.
    expect(() => base58.decode("0OIl")).toThrow();
  });
});
