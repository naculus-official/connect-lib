---
"@naculus/wallet-engine": minor
---

The embedded wallet can derive Solana accounts.

Previously it derived EVM keys only — `m/44'/60'/0'/0/0` was the sole path — so a user could connect a Solana wallet through the SDK but not hold one in it.

`deriveSolanaKeypair` derives from a BIP-39 seed at `m/44'/501'/0'/0'`, the path Phantom, Solflare and Backpack default to. Matching it is the point: the same recovery phrase must produce the same account in any of them, or the wallet is a place funds go in and cannot come out of. `toSolanaSecretKeyBytes` returns the 64-byte secret ‖ public form the Solana CLI and `@solana/web3.js` expect, which is the export route.

BIP-32 cannot do this — it is defined over secp256k1 and its child derivation adds scalars, which ed25519's clamped keys do not permit — so the underlying `slip10` module implements SLIP-0010, verified against the specification's own ed25519 test vectors. It supports hardened derivation only and refuses a non-hardened segment rather than hardening it silently, because deriving a different key than the caller asked for would put funds at an address they never see.

Adds `@scure/base` for base58. Encoding an address is a path where a mistake sends funds somewhere unrecoverable, and the workspace already relies on `@scure`/`@noble` for this class of work; a hand-written base58 would have been a third copy in this repo.
