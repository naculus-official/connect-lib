---
"@naculus/connect-core": minor
---

One place that reads CAIP-2 and CAIP-10.

`parseCaip10`, `namespaceOf`, `eip155Reference` and `isEvmAddress`, plus
`parseChainId` and `validateChainId` now exported from the package root
instead of only existing inside the session manager.

This is the fourth hand-rolled CAIP parser in the workspace and the first one
that is meant to be the last. The one it replaces in appkit was
`chainId.startsWith("eip155:")` followed by
`parseInt(chainId.split(":")[1], 10)`, which answers `5` for
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — base58 starts with a digit often
enough. It happened to be guarded everywhere it was used, so it was incapable
rather than wrong, but the next caller would not have been so lucky.

`eip155Reference` returns null rather than `NaN` or a partial parse: a caller
comparing chain numbers needs a wrong answer to be impossible, not unlikely.
`parseCaip10` returns null rather than throwing, because a session's account
list is data from a wallet and one malformed entry should not take down the
list around it.
