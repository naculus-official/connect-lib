---
"@naculus/wallet-engine": minor
---

`isolation: "secure"` now throws. It was documented as encrypting in-memory
secrets and zero-filling them, but was never implemented: the wallet silently
used the default in-page signer. A wallet configured with it now fails at
construction with a `WalletError` (`invalid_input`) instead of claiming
protection it does not give. Use `isolation: "worker"` to sign in a Web Worker.
The `"secure"` value stays in the type, marked deprecated.
