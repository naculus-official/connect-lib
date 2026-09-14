import { describe, expect, it } from "vitest";
import {
  describeTimeline,
  endToEnd,
  isSettled,
  latestStage,
  PAYMENT_STAGES,
  type PaymentStage,
  type PaymentTimeline,
  recordFailure,
  recordStage,
  stalledFor,
  startTimeline,
  timelineLegs,
} from "./payment-timeline";

/** Record the given stages one second apart, starting at t0. */
function walk(stages: PaymentStage[], t0 = 1_000_000): PaymentTimeline {
  return stages.reduce(
    (timeline, stage, i) =>
      recordStage(timeline, stage, `${stage}-evidence`, t0 + i * 1000),
    startTimeline(),
  );
}

describe("payment stages", () => {
  it("records evidence and the first observation of each stage", () => {
    let timeline = recordStage(
      startTimeline(),
      "submitted",
      "UserOperation 0xab",
      100,
    );
    expect(timeline.stages.submitted).toEqual({
      at: 100,
      evidence: "UserOperation 0xab",
    });

    // A polling loop sees the same fact repeatedly. The timestamp that means
    // something is the first one; a later poll must not push it forward.
    timeline = recordStage(
      timeline,
      "submitted",
      "UserOperation 0xab (poll 2)",
      5_000,
    );
    expect(timeline.stages.submitted).toEqual({
      at: 100,
      evidence: "UserOperation 0xab",
    });
  });

  it("reports the furthest stage reached, not the last one recorded", () => {
    // Out-of-order arrival is normal: a ramp webhook can land before a
    // confirmation poll comes back.
    let timeline = recordStage(startTimeline(), "authorized", "signature", 100);
    timeline = recordStage(timeline, "settled", "bank-ref-77", 900);
    timeline = recordStage(timeline, "confirmed", "block 12, 2 confs", 400);
    expect(latestStage(timeline)).toBe("settled");
  });

  it("has no stage before anything is recorded", () => {
    expect(latestStage(startTimeline())).toBeNull();
    expect(isSettled(startTimeline())).toBe(false);
  });
});

describe("endToEnd", () => {
  it("measures authorized to settled", () => {
    const timeline = walk([...PAYMENT_STAGES]);
    expect(endToEnd(timeline)).toEqual({ known: true, ms: 4000 });
  });

  /**
   * The failure this type exists to prevent. A payment that is confirmed on
   * chain but not settled has no end-to-end time, and the chain leg's duration
   * is not a stand-in for it — substituting one for the other is exactly how a
   * four-hour transfer gets reported as taking seconds.
   */
  it("is unknown while confirmed but not settled, rather than the chain leg's duration", () => {
    const timeline = walk(["authorized", "submitted", "included", "confirmed"]);
    const result = endToEnd(timeline);
    expect(result.known).toBe(false);
    expect(result).not.toHaveProperty("ms");
    if (!result.known)
      expect(result.reason).toMatch(/settled was never observed/);
  });

  it("is unknown when the payment was never authorized", () => {
    const timeline = recordStage(
      startTimeline(),
      "settled",
      "bank-ref-77",
      900,
    );
    expect(endToEnd(timeline)).toEqual({
      known: false,
      reason: "authorized was never observed",
    });
  });

  /**
   * A bundler poll and a bank webhook are not the same clock. Subtracting them
   * blindly yields a negative number that still looks measured.
   */
  it("refuses to return a negative duration when the two clocks disagree", () => {
    let timeline = recordStage(
      startTimeline(),
      "authorized",
      "signature",
      5_000,
    );
    timeline = recordStage(timeline, "settled", "bank-ref-77", 1_000);
    const result = endToEnd(timeline);
    expect(result.known).toBe(false);
    if (!result.known) expect(result.reason).toMatch(/clocks disagree/);
  });

  it("still measures across stages that were never observed", () => {
    // Settlement can be reported without a confirmation poll ever completing.
    // That does not make the end-to-end figure unknown; it is the one number
    // still fully determined by two observations.
    const timeline = walk(["authorized", "settled"]);
    expect(endToEnd(timeline)).toEqual({ known: true, ms: 1000 });
  });
});

describe("timelineLegs", () => {
  it("measures each hop between consecutive observed stages", () => {
    const legs = timelineLegs(walk([...PAYMENT_STAGES]));
    expect(legs.map((l) => [l.from, l.to, l.duration])).toEqual([
      ["authorized", "submitted", { known: true, ms: 1000 }],
      ["submitted", "included", { known: true, ms: 1000 }],
      ["included", "confirmed", { known: true, ms: 1000 }],
      ["confirmed", "settled", { known: true, ms: 1000 }],
    ]);
    expect(legs.every((l) => l.skipped.length === 0)).toBe(true);
  });

  it("names the stages a leg jumped over instead of hiding them", () => {
    const legs = timelineLegs(walk(["authorized", "settled"]));
    expect(legs).toHaveLength(1);
    expect(legs[0].skipped).toEqual(["submitted", "included", "confirmed"]);
  });

  it("has no legs to measure from a single observation", () => {
    expect(timelineLegs(walk(["authorized"]))).toEqual([]);
  });
});

describe("stalledFor", () => {
  it("measures from the most recent observation, not from the start", () => {
    const timeline = walk(["authorized", "submitted"], 1_000);
    // authorized at 1000, submitted at 2000, now 9000.
    expect(stalledFor(timeline, 9_000)).toEqual({ known: true, ms: 7000 });
  });

  it("is not a stall once settled", () => {
    const result = stalledFor(walk([...PAYMENT_STAGES]), 9_000_000);
    expect(result.known).toBe(false);
  });

  it("refuses a clock that runs backwards", () => {
    const result = stalledFor(walk(["authorized"], 5_000), 1_000);
    expect(result.known).toBe(false);
    if (!result.known) expect(result.reason).toMatch(/before/);
  });
});

describe("describeTimeline", () => {
  /**
   * The rule the whole module is built around, checked over every prefix of
   * the path rather than at one hand-picked point: nothing short of `settled`
   * may render as complete. A chain can prove a transaction succeeded. It
   * cannot prove the recipient can spend the money.
   */
  it("never reports complete before settled", () => {
    for (let n = 0; n < PAYMENT_STAGES.length; n += 1) {
      const prefix = PAYMENT_STAGES.slice(0, n);
      const display = describeTimeline(walk([...prefix]));
      expect({ prefix, state: display.state }).toEqual({
        prefix,
        state: n === 0 ? "not-started" : "in-progress",
      });
    }
  });

  it("reports complete once settled", () => {
    const display = describeTimeline(walk([...PAYMENT_STAGES]));
    expect(display.state).toBe("complete");
    expect(display.stage).toBe("settled");
  });

  it("says plainly that a confirmed payment is not spendable yet", () => {
    const display = describeTimeline(
      walk(["authorized", "submitted", "included", "confirmed"]),
    );
    expect(display.state).toBe("in-progress");
    expect(display.detail).toBe(
      "confirmed on chain; the recipient cannot spend it yet",
    );
  });

  it("reports a failure with the stage it was reaching for", () => {
    const timeline = recordFailure(
      walk(["authorized", "submitted"]),
      "included",
      "bundler dropped the operation",
      9_000,
    );
    expect(describeTimeline(timeline)).toEqual({
      state: "failed",
      stage: "included",
      detail: "bundler dropped the operation",
    });
  });

  it("keeps the legs that did complete when a later stage failed", () => {
    const timeline = recordFailure(
      walk(["authorized", "submitted"]),
      "included",
      "bundler dropped the operation",
      9_000,
    );
    expect(timelineLegs(timeline)).toEqual([
      {
        from: "authorized",
        to: "submitted",
        duration: { known: true, ms: 1000 },
        skipped: [],
      },
    ]);
  });

  it("keeps the first failure rather than overwriting it with a later one", () => {
    let timeline = recordFailure(startTimeline(), "included", "first", 100);
    timeline = recordFailure(timeline, "settled", "second", 200);
    expect(timeline.failure).toEqual({
      stage: "included",
      at: 100,
      reason: "first",
    });
  });
});
