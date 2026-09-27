/**
 * Where used challenge ids and payment proofs are recorded. A server with
 * more than one process needs a shared store whose `consume` is atomic (a
 * Redis `SET … NX` with an expiry, a unique-key insert): two requests
 * carrying the same credential must not both get past it.
 */
export interface MppReplayStore {
  /**
   * Record `key` as used until `expiresAt` (epoch ms), atomically. Resolves
   * true when this call recorded it, false when it was already recorded.
   */
  consume(key: string, expiresAt: number): Promise<boolean> | boolean;
  /** Whether `key` is recorded. Optional: an early refusal, not the guard. */
  has?(key: string): Promise<boolean> | boolean;
}

/** An in-process store, for tests and single-process servers. */
export function memoryReplayStore(
  clock: () => number = Date.now,
): MppReplayStore & { size(): number } {
  const used = new Map<string, number>();
  const purge = () => {
    const now = clock();
    for (const [key, until] of used) if (until <= now) used.delete(key);
  };
  return {
    consume(key, expiresAt) {
      purge();
      if (used.has(key)) return false;
      used.set(key, expiresAt);
      return true;
    },
    has(key) {
      purge();
      return used.has(key);
    },
    size() {
      purge();
      return used.size;
    },
  };
}
