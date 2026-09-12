---
"@naculus/wallet-engine": minor
"@naculus/connect-core": patch
---

Add an ed25519 signer, and replace a hand-written base58 that decoded some values one byte too long.

`Ed25519Signer` signs for Solana. Two differences from the EVM signer are deliberate, because copying that behaviour would produce signatures the chain rejects: there is no EIP-191 prefix, since Solana wallets sign the raw bytes, and there is no recovery id, since ed25519 verification takes the public key as an input and has nothing to recover. `signTransaction` refuses rather than pretending — `TransactionRequest` describes gas, nonce and EIP-1559 fees, none of which a Solana transaction has — and `signBytes` signs a message serialized by Solana tooling, which is the division every Solana wallet uses.

`connect-core` had its own base58 encoder and decoder for SNS resolution. The decoder returned one byte too many whenever the decoded value was zero: `toString(16)` yields `"0"`, which pads to a byte, and that byte was added on top of the counted leading zeros — so the all-zeros Solana System Program ID decoded to 33 bytes instead of 32. Verified against `@scure/base` before replacing it.

The failure mode is quiet. Those bytes are hashed into a program-derived address, so a length that is off by one does not error; it derives a different, valid-looking address, and a `.sol` name resolves to an account that is not the owner's. Both functions now come from `@scure/base`, and a regression test covers the lengths the old implementation got wrong.
