---
"@naculus/wallet-engine": minor
---

`SimulationResult` now says what the provider actually examined.

An empty `balanceChanges` meant two incompatible things — the provider looked and the transaction moves no tokens, or the provider cannot look at all — and a UI has no way to tell them apart. It renders the second as the first: "no balance changes" beside a Sign button reads as reassurance when nothing was inspected.

The optional `coverage` field reports whether token movement, approval grants and risk were examined. The built-in `eth_call` provider reports false for all three, because executing a call tells you whether it reverts, not what moved; filling them needs state-diff tracing or a third-party service. Absent coverage should be read as unknown and treated as conservatively as false.

`balanceChanges` and `approvalChanges` are documented accordingly: empty is not a finding unless coverage says so.
