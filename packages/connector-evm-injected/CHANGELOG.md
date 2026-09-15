# @naculus/connector-evm-injected

## 0.2.2

> These entries were written as changesets during 0.2.0 and 0.2.1 but never
> consumed at those releases, so they accumulated. They describe work shipped
> across 0.2.0, 0.2.1 and 0.2.2 rather than 0.2.2 alone, and are collected here
> because deleting them would have thrown away the only written record of what
> those releases contained.

### Minor Changes

- 4974c91: Complete EIP-5792 with `wallet_showCallsStatus`.
  
  `UniversalConnector` gains an optional `showCallsStatus`, implemented by the three connectors that already support `sendCalls`. It asks the wallet to display a bundle to the user, so there is nothing to return; a wallet that refuses or has no such screen leaves the bundle exactly as it was, and the error says so rather than reading like the calls failed.
  
  All four methods of the spec are now present: `wallet_getCapabilities`, `wallet_sendCalls`, `wallet_getCallsStatus`, `wallet_showCallsStatus`.
- 4974c91: `UniversalConnector` gains `onAccountsChanged` and `onChainChanged`.
  
  Every namespace has a way for a wallet to report that the user switched accounts or chains — EIP-1193 `accountsChanged`, Solana's `accountChanged`, a WalletConnect `session_event` or `session_update` — and consumers had to know which. Only the injected EVM path was wired up anywhere, so a Solana or WalletConnect switch was silently ignored.
  
  Both methods return an unsubscribe function, and the contract is that the connector has already updated `session.namespaces` before subscribers run, so a consumer can read the session directly. An empty accounts array signals that the wallet is no longer authorizing the dApp.
  
  `connector-walletconnect` now handles `session_event` and `session_update` at all; it previously listened only for `session_delete` and `session_expire`, so an in-wallet account or chain switch never reached the session.

### Patch Changes

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
