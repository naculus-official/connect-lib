---
"@naculus/wallet-engine": minor
"@naculus/connector-embedded": minor
"@naculus/connector-passkeys": minor
---

Unlock encrypted wallet storage with a passkey (WebAuthn PRF).

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
