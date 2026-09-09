---
"@naculus/connect-core": minor
---

Framework-neutral Solana RPC reads.

`getSolanaBalance`, `getSignatureStatus`, `getLatestBlockhash`, and exact
lamport arithmetic in `formatSol` / `parseSol`. No framework import, so a React
hook and a Vue composable over this are each about ten lines and share every
decision that took thought.

Two of those decisions are worth naming. Amounts are `bigint` throughout: 0.1
is not representable in binary floating point, and a balance wrong in its last
digits is one a user stops trusting. `parseSol` refuses precision finer than a
lamport rather than rounding an amount without saying so.

`getSolanaBalance` reports whether the account exists as well as its balance. A
never-funded address answers zero, which reads identically to an account that
was emptied — they are not the same thing, and only one of them can receive a
transfer without rent. `getSignatureStatus` likewise treats `"unknown"` as its
own answer: a node with no record of a signature may never have seen it, or may
have aged it out, and calling that a failure tells a user their transfer did not
happen when it may well have.
