---
"@naculus/connector-evm-injected": minor
"@naculus/connector-walletconnect": minor
"@naculus/connector-coinbase": minor
"@naculus/connect-core": minor
---

Complete EIP-5792 with `wallet_showCallsStatus`.

`UniversalConnector` gains an optional `showCallsStatus`, implemented by the three connectors that already support `sendCalls`. It asks the wallet to display a bundle to the user, so there is nothing to return; a wallet that refuses or has no such screen leaves the bundle exactly as it was, and the error says so rather than reading like the calls failed.

All four methods of the spec are now present: `wallet_getCapabilities`, `wallet_sendCalls`, `wallet_getCallsStatus`, `wallet_showCallsStatus`.
