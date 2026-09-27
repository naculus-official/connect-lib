import { describe, expect, it } from "vitest";
import { aesGcmOpen, aesGcmSeal } from "./aead";

const key = new Uint8Array(32).fill(1);
const text = new TextEncoder().encode("wallet data");

describe("aesGcmSeal / aesGcmOpen", () => {
  it("round-trips, with a fresh IV each time", () => {
    const a = aesGcmSeal(key, text);
    const b = aesGcmSeal(key, text);
    expect(a).not.toEqual(b);
    expect(aesGcmOpen(key, a)).toEqual(text);
  });

  it("refuses a wrong key, wrong aad or altered bytes", () => {
    const aad = new TextEncoder().encode("record-1");
    const sealed = aesGcmSeal(key, text, aad);
    expect(() => aesGcmOpen(new Uint8Array(32).fill(2), sealed, aad)).toThrow(
      /does not open/,
    );
    expect(() =>
      aesGcmOpen(key, sealed, new TextEncoder().encode("record-2")),
    ).toThrow(/does not open/);
    const altered = sealed.slice();
    altered[20] = (altered[20] as number) ^ 1;
    expect(() => aesGcmOpen(key, altered, aad)).toThrow(/does not open/);
  });

  it("needs a 32-byte key", () => {
    expect(() => aesGcmSeal(new Uint8Array(16), text)).toThrow(/32-byte/);
  });
});
