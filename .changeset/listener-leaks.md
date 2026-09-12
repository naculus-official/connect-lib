---
"@naculus/connector-solana": patch
"@naculus/connector-coinbase": patch
---

Stop stacking wallet event listeners across reconnects.

Both connectors attached provider listeners inside `connect()` with no removal path, so a second connect left two live handlers and every wallet event was reported once per connect that had ever happened — duplicate notifications, and in appkit a session write per duplicate.

- `connector-solana` never called the `removeListener` its own `SolanaProvider` type had declared from the start. It now detaches before re-attaching, on `disconnect()`, and on `clear()`. The Wallet Standard adapter also discarded the unsubscribe function `standard:events` returns, leaving that path with no way to detach at all; it now keeps it and implements `off`.
- `connector-coinbase` rebuilt its provider adapter on every `getProvider()` call, discarding the adapter's record of what was attached while leaving the handlers on the provider. The old adapter is now cleaned up before being replaced, and `setupEventListeners` detaches before re-attaching — its dedupe was by handler identity, and the handlers are fresh closures each call, so nothing was ever deduped.
