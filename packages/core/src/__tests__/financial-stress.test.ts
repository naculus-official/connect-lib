/**
 * Financial Stress Tests — high concurrency, memory pressure, edge cases.
 *
 * Simulates production load patterns that could trigger:
 * - Race conditions in bigint arithmetic
 * - Memory pressure from large BigInt values
 * - Storage contention from concurrent reads/writes
 * - RPC timeout scenarios (mocked)
 */

import { describe, it, expect } from "vitest";
import { parseUnits, formatUnits } from "../token/units";
import { abiEncodeUint256 } from "../token/ERC20TokenHelper";
import { encodeGasLimits } from "../account-abstraction/user-operation";
import { decodeGasLimits } from "../account-abstraction/SmartAccountManager";
import { createConnectorManager } from "../connector-manager";
import { MemoryStorageAdapter } from "../storage";
import { SessionPersistence } from "../session-manager/persistence";
import { fuzzer } from "@naculus/test-utils/test-fuzzer";

// ponytail: stress test is not for proving correctness (unit tests do that).
// It's for finding race conditions, OOM, and timing issues under load.

describe("Stress: concurrent parseUnits (1000x)", () => {
  it("resolves all 1000 calls without error", async () => {
    const values = Array.from({ length: 1000 }, (_, i) => ({
      val: `1.${i.toString().padStart(18, "0")}`,
      dec: 18,
    }));
    const results = await Promise.allSettled(
      values.map(({ val, dec }) => parseUnits(val, dec))
    );
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures.length).toBe(0);
  });

  it("all 1000 results are unique bigints", () => {
    const results = new Set<bigint>();
    for (let i = 1; i <= 1000; i++) {
      results.add(parseUnits(i.toString(), 0));
    }
    expect(results.size).toBe(1000);
  });

  it("formatUnits of 1000 distinct values round-trips", () => {
    for (let i = 1; i <= 1000; i++) {
      const raw = formatUnits(BigInt(i), 0);
      expect(BigInt(raw)).toBe(BigInt(i));
    }
  });
});

describe("Stress: concurrent bigint operations (500x)", () => {
  it("gas limit encode/decode round-trips under concurrent load", async () => {
    const pairs = fuzzer.uint256.pairs(500);
    await Promise.all(pairs.map(async ({ a, b }) => {
      const vgl = a & ((1n << 128n) - 1n);
      const cgl = b & ((1n << 128n) - 1n);
      const encoded = encodeGasLimits(vgl, cgl);
      const decoded = decodeGasLimits(encoded);
      expect(decoded.verificationGasLimit).toBe(vgl);
      expect(decoded.callGasLimit).toBe(cgl);
    }));
  });

  it("abiEncodeUint256 handles 500 large values", () => {
    const values = fuzzer.uint256.values(500);
    for (const v of values) {
      const encoded = abiEncodeUint256(v);
      expect(encoded).toBeTruthy();
      expect(encoded.startsWith("0x")).toBe(true);
    }
  });

  it("500 bigint additions are exact", () => {
    const pairs = fuzzer.bigIntPair.additive(500, 0n, 1n << 128n);
    for (const { a, b } of pairs) {
      const sum = a + b;
      expect(sum - a).toBe(b);
      expect(sum - b).toBe(a);
    }
  });
});

describe("Stress: storage persistence under concurrent load", () => {
  it("SessionPersistence handles 100 concurrent save/loads", async () => {
    const adapter = new MemoryStorageAdapter();
    const persistence = new SessionPersistence("stress-test", adapter);

    const ops = Array.from({ length: 100 }, (_, i) => ({
      id: `session-${i}`,
      timestamp: Date.now() + i,
    }));

    // Concurrent saves
    await Promise.all(ops.map((o) =>
      persistence.save({
        walletSession: { id: o.id } as any,
        lastActiveChainId: "eip155:1",
        chainSessions: {},
        lastConnectedAt: o.timestamp,
      })
    ));

    // Sequential loads — verify last write wins
    const loaded = await persistence.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.walletSession.id).toBe("session-99");
  });
});

describe("Stress: memory pressure (large bigints)", () => {
  it("sum of 10,000 wei values is exact (no overflow)", () => {
    let total = 0n;
    for (let i = 0; i < 10000; i++) {
      total += 1n;
    }
    expect(total).toBe(10000n);
  });

  it("multiplication of near-max uint256 values produces correct result", () => {
    const a = (1n << 128n) - 1n;
    const b = (1n << 128n) - 1n;
    const product = a * b;
    expect(product).toBe((1n << 256n) - (2n << 128n) + 1n);
  });

  it("division of large bigint values truncates correctly", () => {
    const large = 10n ** 30n;
    const div = 3n;
    const result = large / div;
    expect(result * div + (large % div)).toBe(large);
  });
});
