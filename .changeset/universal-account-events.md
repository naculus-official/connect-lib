---
"@naculus/connect-core": minor
"@naculus/connector-solana": minor
"@naculus/connector-evm-injected": minor
"@naculus/connector-walletconnect": minor
---

`UniversalConnector` gains `onAccountsChanged` and `onChainChanged`.

Every namespace has a way for a wallet to report that the user switched accounts or chains — EIP-1193 `accountsChanged`, Solana's `accountChanged`, a WalletConnect `session_event` or `session_update` — and consumers had to know which. Only the injected EVM path was wired up anywhere, so a Solana or WalletConnect switch was silently ignored.

Both methods return an unsubscribe function, and the contract is that the connector has already updated `session.namespaces` before subscribers run, so a consumer can read the session directly. An empty accounts array signals that the wallet is no longer authorizing the dApp.

`connector-walletconnect` now handles `session_event` and `session_update` at all; it previously listened only for `session_delete` and `session_expire`, so an in-wallet account or chain switch never reached the session.
