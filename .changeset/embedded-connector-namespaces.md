---
"@naculus/connector-embedded": minor
"@naculus/wallet-engine": patch
---

`PocketConnector` passes the wallet's namespace surface through: `accounts()`, `account(namespace)`, `setActiveNamespace()`, `backfillAccounts()` and `save()`.

`backfillAccounts()` persists what it adds. A derived account that is not written is gone on the next load, so a user would be asked to backfill again every session and would reasonably conclude the feature does not work.

`importFromPrivateKey` widens to `string` so the base58 and JSON forms reach the engine, which detects the chain rather than asking.

`wallet-engine` now exports `WalletAccount`, `WalletNamespace`, `WalletDataV1` and `migrateWalletData`, which consumers need to work with the version 2 shape.
