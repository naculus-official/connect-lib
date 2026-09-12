---
"@naculus/wallet-engine": major
---

The embedded wallet holds one account per namespace.

`WalletData` replaces its single `privateKey` / `address` pair with an `accounts` array and an `activeNamespace`. One seed derives a separate, independent key per BIP-44 coin type, so a wallet created from a phrase now holds both an EVM account at `m/44'/60'/0'/0/0` and a Solana account at `m/44'/501'/0'/0'` — the paths MetaMask and Phantom default to, so the same phrase opens the same accounts in either.

`address` and `privateKey` remain readable on `WalletData` as views over the active account, so most call sites are unaffected. They are not persisted: storing a snapshot of a view creates a second copy that can disagree with the list it came from.

**Import behaviour differs by what was imported, deliberately.** A mnemonic enables both namespaces, because the accounts already exist — the same phrase in Phantom shows the Solana balance, so hiding it here would mean funds visible everywhere except in this wallet. A raw private key enables only the namespace it belongs to: a key is on exactly one curve, and showing the other would show an address the key cannot control and the user cannot recover, with nothing to explain why it stays empty.

New: `account(namespace)`, `accounts()`, `setActiveNamespace()`, `backfillAccounts()`, and the exported `migrateWalletData`.

### Migration

A version 1 record is migrated in memory on `load()` and is **not** written back there. A read that writes is a read that can fail, and the one thing `load()` must never do is leave someone without a wallet; the migrated shape is persisted on the next explicit save. The migration derives no Solana account, because that needs async work and this has to stay pure and total — a migration that can fail partway is a migration that can lose a wallet. Call `backfillAccounts()` to add it, which leaves the active namespace alone: a user who had an Ethereum wallet yesterday should not find themselves on Solana today.

The existing integrity check survives: a stored address that does not match its private key is still rejected, because signing with a mismatched pair produces transactions from an account the user does not control.

### Fixed while making this change

`{ ...this.data }` is a shallow copy, so the persisted record shared its `accounts` array with the live one. A secure wipe overwrites each key in place, which reached through the shared reference and replaced the stored key too — measured: after `destroySession()` the persisted key had become the wipe pattern and the next `load()` could not open the wallet. Storage now receives a record copied a level deeper.

`wipe()` and `destroySession()` also only overwrote one key. They now cover every account, since leaving the others in memory is the opposite of a secure wipe.
