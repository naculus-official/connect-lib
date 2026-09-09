import { describe, expect, it } from "vitest";
import { planExecution, type AccountCapabilities } from "../capabilities";

const caps = (over: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
  atomicBatch: false,
  sponsoredTransactions: false,
  discovered: true,
  ...over,
});

describe("planExecution", () => {
  it("treats a single call as atomic without batching", () => {
    const plan = planExecution(caps(), 1, "required");
    expect(plan.strategy).toBe("sequential");
    expect(plan.atomic).toBe(true);
  });

  it("batches when the wallet says it can", () => {
    const plan = planExecution(caps({ atomicBatch: true }), 3, "required");
    expect(plan.strategy).toBe("atomic-batch");
    expect(plan.atomic).toBe(true);
  });

  // The case the whole thing exists for: an approve batched with the swap it
  // pays for, sent one by one, leaves an approval standing to a contract the
  // user never transacted with.
  it("refuses rather than downgrading when atomicity is required", () => {
    const plan = planExecution(caps(), 2, "required");
    expect(plan.strategy).toBe("refuse");
    expect(plan.atomic).toBe(false);
    expect(plan.reason).toMatch(/has said it cannot/);
  });

  it("falls back to sequential when atomicity is only preferred", () => {
    const plan = planExecution(caps(), 2, "preferred");
    expect(plan.strategy).toBe("sequential");
    expect(plan.atomic).toBe(false);
  });

  // "The wallet said no" and "the wallet has no way to say" are different
  // facts. An older wallet may batch atomically without advertising it, and
  // the wallet rejects a flagged batch cleanly if it cannot.
  it("still attempts an atomic batch when the wallet never answered", () => {
    const plan = planExecution(caps({ discovered: false }), 2, "required");
    expect(plan.strategy).toBe("atomic-batch");
    expect(plan.reason).toMatch(/did not answer/);
  });

  it("is conservative about an unanswered wallet when atomicity is optional", () => {
    const plan = planExecution(caps({ discovered: false }), 2, "preferred");
    expect(plan.strategy).toBe("sequential");
    expect(plan.atomic).toBe(false);
  });

  // Splitting into several batches loses the guarantee that was the reason to
  // batch in the first place.
  it("refuses a batch larger than the wallet accepts", () => {
    const plan = planExecution(
      caps({ atomicBatch: true, maxBatchSize: 3 }),
      5,
      "required",
    );
    expect(plan.strategy).toBe("refuse");
    expect(plan.reason).toContain("at most 3");
  });

  it("sends the oversized batch sequentially when that is acceptable", () => {
    const plan = planExecution(
      caps({ atomicBatch: true, maxBatchSize: 3 }),
      5,
      "any",
    );
    expect(plan.strategy).toBe("sequential");
    expect(plan.atomic).toBe(false);
  });

  it("stays within an advertised limit", () => {
    const plan = planExecution(
      caps({ atomicBatch: true, maxBatchSize: 5 }),
      5,
      "required",
    );
    expect(plan.strategy).toBe("atomic-batch");
  });

  // Every plan carries a reason, because an application refusing to send has
  // to tell the user something better than "failed".
  it("always explains itself", () => {
    for (const requirement of ["required", "preferred", "any"] as const) {
      for (const c of [caps(), caps({ atomicBatch: true }), caps({ discovered: false })]) {
        expect(planExecution(c, 2, requirement).reason.length).toBeGreaterThan(20);
      }
    }
  });
});

describe("planExecution — sponsorship", () => {
  // Who pays is a separate question from whether the calls land together. A
  // route that executes perfectly but charges a user who was promised
  // sponsored gas is still the wrong route, and signing is too late to find
  // out.
  it("refuses when sponsorship is required and the wallet said no", () => {
    const plan = planExecution(caps({ atomicBatch: true }), 2, {
      atomicity: "required",
      sponsorship: "required",
    });
    expect(plan.strategy).toBe("refuse");
    expect(plan.reason).toMatch(/no paymaster/);
  });

  it("proceeds when a paymaster is available", () => {
    const plan = planExecution(
      caps({ atomicBatch: true, sponsoredTransactions: true }),
      2,
      { atomicity: "required", sponsorship: "required" },
    );
    expect(plan.strategy).toBe("atomic-batch");
    expect(plan.sponsored).toBe(true);
  });

  // Same reasoning as atomicity: a wallet with no way to answer has not said
  // no, and it is the authority on its own paymaster.
  it("does not refuse on behalf of a wallet that never answered", () => {
    const plan = planExecution(caps({ discovered: false }), 2, {
      sponsorship: "required",
    });
    expect(plan.strategy).not.toBe("refuse");
  });

  it("reports sponsorship on every plan, whether asked for or not", () => {
    expect(planExecution(caps({ sponsoredTransactions: true }), 1).sponsored).toBe(
      true,
    );
    expect(planExecution(caps(), 2, "preferred").sponsored).toBe(false);
  });

  it("still accepts a bare atomicity string", () => {
    expect(planExecution(caps({ atomicBatch: true }), 2, "required").strategy).toBe(
      "atomic-batch",
    );
  });
});
