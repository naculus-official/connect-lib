# @naculus/connector-solana

## 0.2.2

> These entries were written as changesets during 0.2.0 and 0.2.1 but never
> consumed at those releases, so they accumulated. They describe work shipped
> across 0.2.0, 0.2.1 and 0.2.2 rather than 0.2.2 alone, and are collected here
> because deleting them would have thrown away the only written record of what
> those releases contained.

### Minor Changes

- 4974c91: Solana in-wallet account switches are now tracked.
  
  `accountChanged` had no branch that recorded a new account: `namespaces.solana.accounts` was written once during `connect()` and never again, and the handler could only null the session. Signing goes through the provider, so after a switch the wallet signed with the new key while the session still advertised the old address — a SIWx message built from that session asserted an address the returned signature did not belong to.
  
  The handler now rewrites the session's CAIP-10 accounts, reads the payload defensively (public key object, base58 string, or accounts array), and treats anything that does not validate as a Solana address as a disconnect rather than writing it into the session.
- 4974c91: Complete the Solana Wallet Standard discovery handshake.
  
  Feature negotiation was already real — `standard:connect`, `solana:signMessage` and `solana:signTransaction` required, the rest probed — but only half of discovery was wired. The connector listened for `wallet-standard:register-wallet`, which catches wallets registering *after* `startDiscovery()`. Extensions inject at document_start, so most have already registered and are waiting for the app to announce itself. Without the `wallet-standard:app-ready` dispatch those wallets were never seen through the standard path at all, which is why the legacy `window.solana` scan was still doing the real work.
  
  The connector now dispatches `app-ready` with a `register` callback (returning the unregister function the standard expects), runs Wallet Standard discovery before the legacy scan, and skips a legacy provider when the same wallet was already found through the standard — the two paths use different ID namespaces, so a wallet supporting both previously appeared twice.
  
  `connector-coinbase` also implements `onAccountsChanged` and `onChainChanged`. Like the injected EVM connector it already re-keyed the session on both provider events but had no way to report them.
  
  `connector-xrpl` deliberately does not implement either: it talks to Xaman over a deep link plus a one-shot `postMessage` handshake that is torn down after connect, so there is no channel an account switch could arrive on. A subscription that can never fire is worse than none.
- 4974c91: `UniversalConnector` gains `onAccountsChanged` and `onChainChanged`.
  
  Every namespace has a way for a wallet to report that the user switched accounts or chains — EIP-1193 `accountsChanged`, Solana's `accountChanged`, a WalletConnect `session_event` or `session_update` — and consumers had to know which. Only the injected EVM path was wired up anywhere, so a Solana or WalletConnect switch was silently ignored.
  
  Both methods return an unsubscribe function, and the contract is that the connector has already updated `session.namespaces` before subscribers run, so a consumer can read the session directly. An empty accounts array signals that the wallet is no longer authorizing the dApp.
  
  `connector-walletconnect` now handles `session_event` and `session_update` at all; it previously listened only for `session_delete` and `session_expire`, so an in-wallet account or chain switch never reached the session.

### Patch Changes

- 4974c91: Stop stacking wallet event listeners across reconnects.
  
  Both connectors attached provider listeners inside `connect()` with no removal path, so a second connect left two live handlers and every wallet event was reported once per connect that had ever happened — duplicate notifications, and in appkit a session write per duplicate.
  
  - `connector-solana` never called the `removeListener` its own `SolanaProvider` type had declared from the start. It now detaches before re-attaching, on `disconnect()`, and on `clear()`. The Wallet Standard adapter also discarded the unsubscribe function `standard:events` returns, leaving that path with no way to detach at all; it now keeps it and implements `off`.
  - `connector-coinbase` rebuilt its provider adapter on every `getProvider()` call, discarding the adapter's record of what was attached while leaving the handlers on the provider. The old adapter is now cleaned up before being replaced, and `setupEventListeners` detaches before re-attaching — its dedupe was by handler identity, and the handlers are fresh closures each call, so nothing was ever deduped.
- a1c823f: Log a failed provider disconnect instead of discarding it.
  
  The local teardown has to happen either way — a user who asks to disconnect
  must end up disconnected here even when the wallet refuses to hear it — so the
  error is still not rethrown. It is no longer invisible.
- Updated dependencies [6f156fe]
- Updated dependencies [5830df7]
- Updated dependencies [4974c91]
- Updated dependencies [36c5e0d]
- Updated dependencies [648fe91]
- Updated dependencies [4974c91]
- Updated dependencies [abf192a]
- Updated dependencies [90bb105]
- Updated dependencies [4974c91]
  - @naculus/connect-core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - @naculus/connect-core@0.1.1
