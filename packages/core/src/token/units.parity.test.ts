/**
 * wallet-engine cannot import connect-core (it sits below it), so the amount
 * and ERC-20 encoding helpers exist twice. This runs both copies on the same
 * inputs: a copy that drifts — accepts what the other refuses, or encodes a
 * different amount — fails here instead of in someone's transfer.
 */
import { describe, expect, it } from "vitest";
import * as engine from "../../../wallet-engine/src/erc20-utils";
import { abiEncodeAddress, abiEncodeUint256 } from "./ERC20TokenHelper";
import { parseUnits } from "./units";

type Outcome = { ok: true; value: string } | { ok: false };

function outcome(run: () => unknown): Outcome {
  try {
    return { ok: true, value: String(run()) };
  } catch {
    return { ok: false };
  }
}

const AMOUNTS = [
  "0",
  "1",
  "1.5",
  "0.000001",
  "0.0000001",
  ".5",
  "1.",
  "01",
  " 1",
  "1 ",
  "",
  "-1",
  "+1",
  "1e3",
  "0x10",
  "1,5",
  "1.123456789",
  "1.0",
  "1.000000",
  "115792089237316195423570985008687907853269984665640564039457584007913129639935",
  "115792089237316195423570985008687907853269984665640564039457584007913129639936",
];
const DECIMALS = [0, 6, 18];

describe("parseUnits: connect-core and wallet-engine agree", () => {
  for (const decimals of DECIMALS) {
    it.each(AMOUNTS)(`%j with ${decimals} decimals`, (amount) => {
      expect(outcome(() => engine.parseUnits(amount, decimals))).toEqual(
        outcome(() => parseUnits(amount, decimals)),
      );
    });
  }
});

describe("ABI encoding: connect-core and wallet-engine agree", () => {
  const strip = (hex: string) => hex.replace(/^0x/, "");

  it.each([0n, 1n, 10n ** 18n, 2n ** 255n, 2n ** 256n - 1n, 2n ** 256n, -1n])(
    "uint256 %s",
    (value) => {
      const core = outcome(() => strip(abiEncodeUint256(value)));
      const wallet = outcome(() => strip(engine.abiEncodeUint256(value)));
      expect(wallet).toEqual(core);
    },
  );

  it.each([
    "0x0000000000000000000000000000000000000000",
    "0xAbCdEf0123456789aBcDeF0123456789abCDef01",
    "0x123",
    "0xZZcdef0123456789abcdef0123456789abcdef01",
    "abcdef0123456789abcdef0123456789abcdef0123",
  ])("address %s", (address) => {
    const core = outcome(() =>
      strip(abiEncodeAddress(address as `0x${string}`)),
    );
    const wallet = outcome(() =>
      strip(engine.abiEncodeAddress(address as `0x${string}`)),
    );
    expect(wallet).toEqual(core);
  });
});
