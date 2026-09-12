---
"@naculus/wallet-engine": patch
---

Lock the self-custody exit guarantee with interoperability tests.

If this project disappears, a user's funds have to remain reachable from any other wallet. That holds only while the mnemonic is standard BIP-39, the derivation is the BIP-44 path other wallets default to (`m/44'/60'/0'/0/0`), and the phrase can be read back from storage rather than shown once.

All three are now asserted. Two published BIP-39 vectors pin the addresses MetaMask, Rabby and Ledger Live derive; the rest are cross-checked against a derivation built directly on `@scure/bip39`, `@scure/bip32` and `@noble/curves`, so agreement is independent rather than the implementation confirming itself. A refactor that changes the derivation now fails a test instead of silently stranding funds.
