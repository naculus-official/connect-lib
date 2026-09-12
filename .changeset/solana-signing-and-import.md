---
"@naculus/wallet-engine": minor
---

The embedded wallet can now sign for Solana, and import a Solana key.

Signing routes by the active namespace instead of using one signer fixed at construction. The EVM signer applies EIP-191 and produces a recoverable secp256k1 signature; Solana signs raw bytes on ed25519 with nothing to recover. Using one for the other does not fail loudly — it produces a well-formed signature that verifies against nothing, which is the worst shape of wrong for a signing path, because everything looks like it worked. The tests check each signature against its own account's public key rather than merely checking that one came back.

`signTypedData` and `signHash` refuse on Solana and name the signer, rather than substituting something. EIP-712 and the EIP-191 digest form are Ethereum constructions with no Solana equivalent to quietly stand in.

A caller-supplied `config.signer` still wins for every namespace, so an integration that brings its own is not silently overridden.

`importPrivateKey` now accepts what MetaMask, Phantom and `solana-keygen` export — `0x` hex, base58, or a 64-byte JSON array — and works out which chain the key belongs to rather than asking. For the Solana forms that is a proof rather than a guess: the trailing 32 bytes must be the ed25519 public key of the leading 32. Only the detected namespace is enabled.

Three refusals are distinct, because they mean different things to whoever pasted the value: a bare 32-byte hex says nothing about which chain it is for, a 64-byte value whose halves do not pair is not a keypair at all, and anything else is an unrecognised format. Its parameter widens from `` `0x${string}` `` to `string` to accept the base58 and JSON forms.
