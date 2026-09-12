---
"@naculus/connector-solana": minor
"@naculus/connector-coinbase": minor
---

Complete the Solana Wallet Standard discovery handshake.

Feature negotiation was already real — `standard:connect`, `solana:signMessage` and `solana:signTransaction` required, the rest probed — but only half of discovery was wired. The connector listened for `wallet-standard:register-wallet`, which catches wallets registering *after* `startDiscovery()`. Extensions inject at document_start, so most have already registered and are waiting for the app to announce itself. Without the `wallet-standard:app-ready` dispatch those wallets were never seen through the standard path at all, which is why the legacy `window.solana` scan was still doing the real work.

The connector now dispatches `app-ready` with a `register` callback (returning the unregister function the standard expects), runs Wallet Standard discovery before the legacy scan, and skips a legacy provider when the same wallet was already found through the standard — the two paths use different ID namespaces, so a wallet supporting both previously appeared twice.

`connector-coinbase` also implements `onAccountsChanged` and `onChainChanged`. Like the injected EVM connector it already re-keyed the session on both provider events but had no way to report them.

`connector-xrpl` deliberately does not implement either: it talks to Xaman over a deep link plus a one-shot `postMessage` handshake that is torn down after connect, so there is no channel an account switch could arrive on. A subscription that can never fire is worse than none.
