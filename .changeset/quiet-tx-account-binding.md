---
"@naculus/wallet-engine": patch
---

`sendTransaction` now binds the signing account when it starts. If the active account, namespace or signer key changes while the transaction is being prepared (for example `importPrivateKey` during the nonce or fee lookup), it throws `WalletError("tx_failed")` and broadcasts nothing, instead of signing and sending from the new account.
