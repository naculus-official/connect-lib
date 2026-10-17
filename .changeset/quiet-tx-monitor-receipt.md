---
"@naculus/wallet-engine": patch
---

The transaction monitor now accepts a receipt only when its `transactionHash` is a string equal to the watched hash (hex compared case-insensitively). A receipt whose `transactionHash` is missing, null, not a string, or names a different transaction is ignored. Such a response no longer confirms or fails the watched transaction, does not attach the other transaction's block or gas fields, and does not mark it as dropped. The monitor reports it as `pending` and keeps polling until the existing pending timeout.
