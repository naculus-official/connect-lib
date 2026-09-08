---
"@naculus/wallet-engine": minor
"@naculus/connector-embedded": minor
"@naculus/connect-core": minor
---

Sign and send Solana transactions, and export a key another wallet can read.

**Solana transactions.** The application builds and serializes the transaction
as it would for Phantom; what it cannot delegate is where the signature goes. A
transaction carries a fixed-length signature array positionally matched to the
accounts that must sign, so signing the right bytes and filling the wrong slot
produces something the cluster rejects with nothing in the error saying why.

`signSolanaTransaction` parses the wire format — compact-u16 count, signature
array, legacy or versioned message, account keys — finds this wallet's slot,
and fills it without disturbing a co-signer's. It refuses a transaction this
key is not a required signer of rather than signing anyway and returning
something that looks signed. Every fixture in the tests came out of
`@solana/web3.js` v2; an earlier draft transcribed them by hand and was wrong
by 32 bytes.

`sendSolanaTransaction` submits over `solanaRpcUrl`, and refuses a transaction
still missing a co-signature instead of spending a round trip on an opaque
rejection. The embedded connector routes `signTransaction` and
`sendTransaction` on the active namespace.

**Three defects this exposed, all silent:**

`connect()` always emitted one `eip155` namespace containing
`wallet.address`. Once a wallet could hold a Solana account, activating it
published a base58 Solana address as an EIP-155 account — a CAIP-10 string
asserting an address exists on a chain it has never existed on. Namespaces are
now built from the accounts actually held.

`signMessage` never checked the account a caller named. An application asking
for a signature "as 0x9858…" while Solana was active received an ed25519
signature: well-formed, attributed to an EVM address, verifying against
nothing. It now refuses, naming the account that would have signed.

`setActiveNamespace` and `backfillAccounts` told nobody. The connector now
implements `onAccountsChanged`, so a switch reaches the session rather than
leaving an interface showing the account from connect time while a different
key signs.

**`exportPrivateKey(namespace)`.** The stored form is hex for both namespaces,
which MetaMask reads and Phantom does not. Getting a usable Solana key
previously meant reading the account, knowing the encoding, hex-decoding it and
finding the base58 helper — an export a user has to convert by hand is the same
as no export. `eip155` returns `0x` hex; `solana` returns the 64-byte base58
Phantom takes. `exportSolanaKeypairJson()` returns the array `solana-keygen`
writes.

**`PassphraseGate` moved to `@naculus/connect-core`** so the Vue layer can use
the same object as React. It is re-exported from
`@naculus/connect-appkit-react`, so a React consumer sees no change.
