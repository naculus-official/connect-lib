---
"@naculus/connect-core": minor
---

ERC-20 `buildTransferTx`, `buildApproveTx` and `buildTransferFromTx` now include the token's `chainId` in the returned request, so a wallet configured for another chain rejects it with `chain_mismatch` instead of signing it for its own chain.

The returned `chainId` is a number (EIP-155 chain id), matching wallet-engine's `TransactionRequest`. Migration: if you pass builder output to an injected or Coinbase connector's `sendTransaction`, or to a raw EIP-1193 provider, convert it first (`chainId: "0x" + chainId.toString(16)`) or remove the field; the connectors compare chain ids as hex strings.
