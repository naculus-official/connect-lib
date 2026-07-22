/**
 * Minimal property-based testing fuzzer — no external dependencies.
 *
 * Generates random test vectors for financial boundary testing.
 * Replaces the need for fast-check in this codebase.
 *
 * Usage:
 *   const vectors = fuzzer.uint256.pairs(1000);
 *   for (const { a, b } of vectors) {
 *     expect(parseUnits(formatUnits(a, 18), 18)).toBe(a);
 *   }
 */

const randomBigInt = (min: bigint, max: bigint): bigint => {
  const range = max - min;
  const bits = range.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let result = 0n;
  for (let i = 0; i < bytes; i++) {
    result = (result << 8n) | BigInt(buf[i]);
  }
  return min + (result % (range + 1n));
};

const randomInt = (min: number, max: number): number => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const randomHexChar = (): string => "0123456789abcdef"[randomInt(0, 15)];

const randomAddress = (): `0x${string}` => {
  let addr = "0x";
  for (let i = 0; i < 40; i++) addr += randomHexChar();
  return addr as `0x${string}`;
};

const randomDecimalString = (decimals: number): string => {
  const intPart = randomBigInt(0n, (1n << 64n) - 1n).toString();
  const fracLen = randomInt(0, decimals);
  if (fracLen === 0) return intPart;
  let frac = "";
  for (let i = 0; i < fracLen; i++) frac += randomInt(0, 9).toString();
  frac = frac.replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
};

export const fuzzer = {
  bigint: (min: bigint, max: bigint) => randomBigInt(min, max),
  int: (min: number, max: number) => randomInt(min, max),
  address: randomAddress,
  decimalString: randomDecimalString,

  uint256: {
    /** N random uint256 values */
    values(n: number): bigint[] {
      return Array.from({ length: n }, () =>
        randomBigInt(0n, (1n << 256n) - 1n),
      );
    },
    /** N pairs of random uint256 values */
    pairs(n: number): { a: bigint; b: bigint }[] {
      return Array.from({ length: n }, () => ({
        a: randomBigInt(0n, (1n << 256n) - 1n),
        b: randomBigInt(0n, (1n << 128n) - 1n),
      }));
    },
    /** N non-zero values */
    nonZero(n: number): bigint[] {
      return Array.from({ length: n }, () =>
        randomBigInt(1n, (1n << 256n) - 1n),
      );
    },
  },

  bigIntPair: {
    /** pairs where a + b ranges between min and max */
    additive(n: number, min: bigint, max: bigint): { a: bigint; b: bigint }[] {
      return Array.from({ length: n }, () => {
        const a = randomBigInt(0n, max);
        const b = randomBigInt(0n, max - a > 0n ? max - a : 0n);
        return { a, b };
      });
    },
  },

  decimal: {
    values(
      n: number,
      maxDecimals: number,
    ): { value: string; decimals: number }[] {
      return Array.from({ length: n }, () => ({
        value: randomDecimalString(maxDecimals),
        decimals: randomInt(0, maxDecimals),
      }));
    },
  },

  tokens: {
    amounts(n: number, decimals: number): string[] {
      return Array.from({ length: n }, () => randomDecimalString(decimals));
    },
  },
};
