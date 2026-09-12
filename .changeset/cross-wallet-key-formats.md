---
"@naculus/wallet-engine": minor
---

Export and import private keys in the forms other wallets actually read.

No EIP or SLIP specifies how a private key is written down. The derivation standards decide which key belongs to which account — that is what makes a recovery phrase open the same accounts everywhere — and the text encoding of a raw key is convention. Convention is enough to interoperate, but only if followed exactly.

`toSolanaSecretKeyBytes` returned 64 raw bytes. Phantom, Solflare and `solana-keygen` read base58 or a JSON array, so a user exporting a Solana key was handed something they would have had to encode themselves before any other wallet would take it. For someone trying to move their funds elsewhere, an export that needs a base58 encoder first is the same as no export.

- `toEvmPrivateKeyHex` emits `0x` and 64 hex characters, and refuses a value above the secp256k1 order rather than emitting a key no wallet can use.
- `toSolanaPrivateKeyBase58` and `toSolanaKeypairJson` emit the two forms Solana tooling reads. The public half is derived rather than trusted from the caller, so an exported key cannot disagree with its own address.
- `detectPrivateKey` reads all three back and reports which chain the key belongs to. The 64-byte Solana form carries its own proof — the trailing 32 bytes must be the ed25519 public key of the leading 32 — so that case is verified, not inferred.

A bare 32-byte value is refused rather than guessed at. No mainstream tool emits one, and a Solana *address* has exactly that shape, so accepting it would mostly mean accepting a pasted address as a key — producing an account the user cannot control, with nothing to explain why it is empty.

Both directions are tested: what this wallet exports parses the way those wallets parse it, and what they export imports here and yields the same address.
