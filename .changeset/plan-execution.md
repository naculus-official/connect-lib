---
"@naculus/connect-core": minor
---

`planExecution` — decide how to execute, and be able to say no.

`chooseExecutionStrategy` answers the same question for the default case and
has no way to express a refusal, so a caller that needed several calls to land
together was silently downgraded to sending them one after another. For an
approve batched with the swap it pays for, that leaves an approval standing to
a contract the user never transacted with.

`planExecution` takes an `AtomicityRequirement` and returns a strategy that can
be `"refuse"`, together with whether the chosen route is genuinely
all-or-nothing and a reason an application can show.

The `discovered` flag on `AccountCapabilities` decides the interesting case. A
wallet that answered "no" made a decision; a wallet with no way to answer did
not. When atomicity is required and the wallet never told us, the batch is
still attempted with the atomic flag set — the wallet is the authority and
rejects cleanly if it cannot, which beats refusing on behalf of an older wallet
that may well batch.

A single call is reported as atomic on its own, and a batch larger than an
advertised `maxBatchSize` is a refusal rather than a split, because splitting
loses the guarantee that was the reason to batch.
