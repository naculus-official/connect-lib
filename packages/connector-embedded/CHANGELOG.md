# @naculus/connector-embedded

## 0.2.2

> These entries were written as changesets during 0.2.0 and 0.2.1 but never
> consumed at those releases, so they accumulated. They describe work shipped
> across 0.2.0, 0.2.1 and 0.2.2 rather than 0.2.2 alone, and are collected here
> because deleting them would have thrown away the only written record of what
> those releases contained.

### Minor Changes

- 4974c91: `PocketConnector` passes the wallet's namespace surface through: `accounts()`, `account(namespace)`, `setActiveNamespace()`, `backfillAccounts()` and `save()`.
  
  `backfillAccounts()` persists what it adds. A derived account that is not written is gone on the next load, so a user would be asked to backfill again every session and would reasonably conclude the feature does not work.
  
  `importFromPrivateKey` widens to `string` so the base58 and JSON forms reach the engine, which detects the chain rather than asking.
  
  `wallet-engine` now exports `WalletAccount`, `WalletNamespace`, `WalletDataV1` and `migrateWalletData`, which consumers need to work with the version 2 shape.
- 4974c91: An embedded wallet can now own an ERC-4337 smart account.
  
  `Signer` gains an optional `signHash`, implemented for EVM, which signs a 32-byte digest as an EIP-191 message. `signMessage` could not stand in: it encodes the string it is given, so a userOpHash passed as `"0x1234…"` was signed as those 66 characters rather than the 32 bytes they denote. The signature recovers the right key over the wrong digest, and a SimpleAccount — which applies `toEthSignedMessageHash` to the raw userOpHash — rejects it. That is why account abstraction previously refused embedded wallets outright.
  
  Exposed as `Wallet.signHash` and `PocketConnector.signHash`.
  
  Also extracts the private-key validation that was inlined three times in the EVM signer. The RLP helpers in the same directory were duplicated the same way and drifted until one copy rejected 18% of valid signatures.
- 90bb105: Unlock encrypted wallet storage with a passkey (WebAuthn PRF).
  
  `EncryptedStorageAdapter` accepts a `PrfUnlockProvider`, and
  `@naculus/connector-passkeys` supplies one via `createPasskeyUnlockProvider()`.
  Passing it to `PocketWallet` as `prfUnlock` is the whole enable step: where the
  authenticator answers, opening the wallet needs the user's fingerprint or face
  instead of a value any script on the origin can supply.
  
  **The record format changed to an envelope, and that was forced by keeping the
  passphrase.** The wallet JSON is encrypted once under a random data key, and
  that data key is wrapped separately for each way in. Sealing directly under PRF
  would have left the passphrase as an API that exists and a recovery path that
  does not — the bytes were never derived from it, so it could not open the
  record no matter what the caller passed. Wrapping one data key twice is the
  only shape in which "keep the passphrase in case the passkey breaks" is a true
  statement.
  
  The cost is reported rather than hidden: a record openable two ways is only as
  hard to open as the easier way, and `assessStorageSecurity()` deducts for it by
  name.
  
  Records written by earlier versions are read in place and rewritten as
  envelopes on the next save. There is no migration step and nothing to roll
  back, because the passphrase wrap is never removed.
  
  Other properties worth naming:
  
  - Where PRF is unavailable — Firefox, a credential created before the extension
    was requested, a declined prompt — the write is silently passphrase-only and
    nothing fails.
  - The PRF wrapping key is derived with HKDF alone. PBKDF2's iteration count
    exists to make a low-entropy human passphrase expensive to guess; PRF output
    is 32 uniformly random bytes, so 600k iterations over it buy nothing.
  - The salt is stored inside that wallet's own record, so it is per-wallet by
    construction. One credential can protect several wallets independently, and
    it is never regenerated for a record that already has one — rotating it would
    be equivalent to discarding the wallet.
  - Each wrap records its own `iterations`, so a later change to the constant
    cannot leave existing records impossible to derive a key for.
  - The wrapping key is derived once per session, not once per save. A wallet
    that asks for a fingerprint on every mutation is one the user turns off.
  
  New: `PocketWallet.getStorageSecurityReport()` and `assessStorageSecurity()`
  return the existing 1–4 tier plus the individual findings behind it, so a UI
  can explain the score instead of showing a bare number.
- 90bb105: Sign and send Solana transactions, and export a key another wallet can read.
  
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

### Patch Changes

- Updated dependencies [6f156fe]
- Updated dependencies [4974c91]
- Updated dependencies [5830df7]
- Updated dependencies [4974c91]
- Updated dependencies [4974c91]
- Updated dependencies [4974c91]
- Updated dependencies [4974c91]
- Updated dependencies [4974c91]
- Updated dependencies [4974c91]
- Updated dependencies [90bb105]
- Updated dependencies [36c5e0d]
- Updated dependencies [648fe91]
- Updated dependencies [4974c91]
- Updated dependencies [4974c91]
- Updated dependencies [4974c91]
- Updated dependencies [abf192a]
- Updated dependencies [4974c91]
- Updated dependencies [90bb105]
- Updated dependencies [4974c91]
- Updated dependencies [4974c91]
  - @naculus/connect-core@0.3.0
  - @naculus/wallet-engine@1.0.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - @naculus/connect-core@0.1.1
  - @naculus/wallet-engine@0.1.0
