/**
 * When each stage of a payment actually happened.
 *
 * A chain leg finishing in seconds is a true statement that answers the wrong
 * question. The number a payer cares about runs from the moment money leaves
 * their account to the moment the recipient can spend it, and the slow part of
 * that is usually a leg nobody publishes a number for. Recording a timestamp
 * per stage makes the end-to-end figure something measured rather than claimed,
 * and makes the slow leg visible instead of averaged away.
 *
 * The rules this module exists to enforce:
 *
 *   - A stage that was never observed is absent, not zero and not false. An
 *     absent `settled` means "we do not know that the recipient can spend it",
 *     which is a different fact from "they cannot".
 *   - No duration is ever invented. Every one is either a measurement between
 *     two observations or an explicit `known: false` with the reason.
 *   - Nothing reports a payment complete before `settled`. `included` and
 *     `confirmed` are facts about a chain, not about a recipient.
 *
 * This deliberately knows nothing about how a stage is observed. A UserOperation
 * receipt, a block confirmation count and a bank webhook are all just evidence
 * strings; wiring them up belongs to whoever owns that leg.
 */

/**
 * The stages of a payment, in order.
 *
 * `submitted` through `confirmed` are the chain's account of itself and stop at
 * the chain's edge. `settled` is the only one that speaks for the recipient,
 * and for a payment that ends in fiat it is the one a bank decides.
 */
export type PaymentStage =
  | "authorized"
  | "submitted"
  | "included"
  | "confirmed"
  | "settled";

/** Stage order. Index is rank; nothing else should hard-code these positions. */
export const PAYMENT_STAGES: readonly PaymentStage[] = [
  "authorized",
  "submitted",
  "included",
  "confirmed",
  "settled",
] as const;

export interface StageRecord {
  /** Epoch milliseconds, from the caller's clock. */
  at: number;
  /**
   * What proved this stage. A UserOperation hash, a block number and
   * confirmation count, a ramp's settlement id — whatever a later reader would
   * need to check the claim rather than take it.
   */
  evidence: string;
}

export interface PaymentFailure {
  /** The stage being attempted when it failed. */
  stage: PaymentStage;
  at: number;
  reason: string;
}

export interface PaymentTimeline {
  readonly stages: Readonly<Partial<Record<PaymentStage, StageRecord>>>;
  readonly failure: PaymentFailure | null;
}

/**
 * A measured duration, or the reason there isn't one.
 *
 * The whole point of this module is that "we cannot tell you how long that
 * took" and "that took no time" are different answers, so they cannot share a
 * representation. A bare `number` here would have let a missing stage render
 * as 0ms, which reads as instant.
 */
export type Duration =
  | { known: true; ms: number }
  | { known: false; reason: string };

/** One measured hop between two observed stages. */
export interface TimelineLeg {
  from: PaymentStage;
  to: PaymentStage;
  duration: Duration;
  /** Stages between these two that were never observed. */
  skipped: PaymentStage[];
}

const rank = (stage: PaymentStage) => PAYMENT_STAGES.indexOf(stage);

export function startTimeline(): PaymentTimeline {
  return { stages: {}, failure: null };
}

/**
 * Record a stage, keeping the first observation of it.
 *
 * A caller polling for inclusion sees the same fact repeatedly; the timestamp
 * that means anything is the first one, and later polls must not push it
 * forward. Re-recording is therefore a no-op rather than an error — it is the
 * normal shape of a polling loop, not a mistake.
 */
export function recordStage(
  timeline: PaymentTimeline,
  stage: PaymentStage,
  evidence: string,
  at: number,
): PaymentTimeline {
  if (timeline.stages[stage]) return timeline;
  return {
    stages: { ...timeline.stages, [stage]: { at, evidence } },
    failure: timeline.failure,
  };
}

/**
 * Record that the payment failed while reaching for a stage.
 *
 * Kept separate from the stages rather than added as a sixth one: a failure is
 * not a point on the path, and a timeline that failed at `confirmed` still has
 * a real, measurable `authorized -> submitted` leg worth reading.
 */
export function recordFailure(
  timeline: PaymentTimeline,
  stage: PaymentStage,
  reason: string,
  at: number,
): PaymentTimeline {
  if (timeline.failure) return timeline;
  return { stages: timeline.stages, failure: { stage, at, reason } };
}

/** The furthest stage observed, or null if nothing has been recorded. */
export function latestStage(timeline: PaymentTimeline): PaymentStage | null {
  let latest: PaymentStage | null = null;
  for (const stage of PAYMENT_STAGES) {
    if (timeline.stages[stage]) latest = stage;
  }
  return latest;
}

/**
 * Whether the recipient can spend it.
 *
 * The only predicate in this module a UI may render as done. `confirmed` is
 * not it, which is the entire reason this function is not called `isDone` and
 * does not consult anything but `settled`.
 */
export function isSettled(timeline: PaymentTimeline): boolean {
  return Boolean(timeline.stages.settled);
}

function between(
  timeline: PaymentTimeline,
  from: PaymentStage,
  to: PaymentStage,
): Duration {
  const start = timeline.stages[from];
  const end = timeline.stages[to];
  if (!start) return { known: false, reason: `${from} was never observed` };
  if (!end) return { known: false, reason: `${to} was never observed` };
  // Timestamps can arrive from different clocks — a bundler poll and a bank
  // webhook are not the same machine. Subtracting them blindly produces a
  // negative "duration", which is a number that looks measured and is not.
  if (end.at < start.at) {
    return {
      known: false,
      reason: `${to} is timestamped before ${from}; the two clocks disagree`,
    };
  }
  return { known: true, ms: end.at - start.at };
}

/**
 * The figure that matters: authorized to settled.
 *
 * Unknown until the recipient can actually spend it. A payment sitting between
 * `confirmed` and `settled` has no end-to-end time yet — reporting the chain
 * leg's duration there is exactly the substitution this module exists to stop.
 */
export function endToEnd(timeline: PaymentTimeline): Duration {
  return between(timeline, "authorized", "settled");
}

/**
 * Every measured hop, in order, between the stages that were observed.
 *
 * Stages can legitimately be missed — a ramp may report settlement before a
 * confirmation poll comes back — so legs are built between consecutive
 * *observed* stages and name what was skipped, rather than pretending the
 * unobserved stage never mattered.
 */
export function timelineLegs(timeline: PaymentTimeline): TimelineLeg[] {
  const observed = PAYMENT_STAGES.filter((stage) => timeline.stages[stage]);
  const legs: TimelineLeg[] = [];
  for (let i = 1; i < observed.length; i += 1) {
    const from = observed[i - 1];
    const to = observed[i];
    legs.push({
      from,
      to,
      duration: between(timeline, from, to),
      skipped: PAYMENT_STAGES.slice(rank(from) + 1, rank(to)),
    });
  }
  return legs;
}

/**
 * How long it has been since anything happened.
 *
 * A payment is not slow because it is taking a long time overall; it is slow
 * because one leg is not moving. This is the number that says which.
 */
export function stalledFor(timeline: PaymentTimeline, now: number): Duration {
  const latest = latestStage(timeline);
  if (!latest) return { known: false, reason: "nothing has been observed yet" };
  if (isSettled(timeline)) return { known: false, reason: "already settled" };
  const at = timeline.stages[latest]?.at ?? 0;
  if (now < at) {
    return { known: false, reason: `now is before ${latest} was observed` };
  }
  return { known: true, ms: now - at };
}

/**
 * What a UI is allowed to say.
 *
 * `complete` is reachable only through `settled`. Everything the chain can
 * prove on its own tops out at `in-progress`, because "the transaction
 * succeeded" and "the money arrived" are different claims and only the second
 * one is what a payer asked about.
 */
export type PaymentDisplayState =
  | "not-started"
  | "in-progress"
  | "complete"
  | "failed";

export interface PaymentDisplay {
  state: PaymentDisplayState;
  /** The stage this state was derived from, for a caller building a label. */
  stage: PaymentStage | null;
  /** Why it is not complete, when it is not. */
  detail: string;
}

export function describeTimeline(timeline: PaymentTimeline): PaymentDisplay {
  if (timeline.failure) {
    return {
      state: "failed",
      stage: timeline.failure.stage,
      detail: timeline.failure.reason,
    };
  }
  if (isSettled(timeline)) {
    return {
      state: "complete",
      stage: "settled",
      detail: "the recipient can spend it",
    };
  }
  const latest = latestStage(timeline);
  if (!latest) {
    return {
      state: "not-started",
      stage: null,
      detail: "nothing recorded yet",
    };
  }
  const detail: Record<Exclude<PaymentStage, "settled">, string> = {
    authorized: "authorized, not yet submitted",
    submitted: "accepted for processing; not yet on chain",
    included: "on chain, awaiting confirmations",
    confirmed: "confirmed on chain; the recipient cannot spend it yet",
  };
  return {
    state: "in-progress",
    stage: latest,
    detail: detail[latest as Exclude<PaymentStage, "settled">],
  };
}
