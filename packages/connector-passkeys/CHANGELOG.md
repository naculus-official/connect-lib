# @naculus/connector-passkeys

## 0.2.2

> These entries were written as changesets during 0.2.0 and 0.2.1 but never
> consumed at those releases, so they accumulated. They describe work shipped
> across 0.2.0, 0.2.1 and 0.2.2 rather than 0.2.2 alone, and are collected here
> because deleting them would have thrown away the only written record of what
> those releases contained.

### Minor Changes

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
- 4974c91: Make passkey assertions verifiable, and request the PRF extension.
  
  `authenticate()` returned only the signature and `authenticatorData`. A WebAuthn signature covers `authenticatorData ‖ SHA-256(clientDataJSON)`, so without `clientDataJSON` nobody could rebuild the signed bytes, check that the challenge they issued was the one signed, or check the origin — the whole of WebAuthn's replay and phishing protection. The stored public key had never been used for anything either. Producing signatures nobody can check is not authentication; it only looks like it, which is worse than none, because a caller reasonably assumes a returned signature meant something.
  
  `authenticate()` now returns `clientDataJSON`, the credential ID and `userHandle` alongside the signature, and `verifyPasskeyAssertion` checks all of it: challenge, origin, RP ID hash, user-verified flag, assertion type, and the signature itself against the registered key. Tested with real P-256 keys rather than mocked crypto — a forged signature, a phishing origin, a replayed challenge, a credential for another relying party and a registration response reused as an assertion are each rejected by a named check.
  
  Credentials are now created with the PRF extension, which an authenticator can only enable at creation. `derivePrfKey` returns a 32-byte wrapping key derived from the authenticator, raising the bar on stored wallet material from "any script on this origin" to "this user's fingerprint or face".
  
  Every unsupported path returns null rather than throwing, so a caller falls back instead of locking a user out of their own wallet: Firefox lacks PRF, older credentials were created without it, and some platforms cannot report extension results at all. That last case is recorded as unknown rather than false — one is worth retrying on a newer browser, the other is settled.
  
  PRF is device-bound. It protects the local copy, not the wallet; the recovery phrase remains the only backup that survives losing the device.
  
  Also fixes `loadCredential` dropping `prfSupported` when rebuilding the stored record, which made every reload forget that a credential had no PRF and prompt the user for a derivation that could not succeed.

### Patch Changes

- Updated dependencies [6f156fe]
- Updated dependencies [5830df7]
- Updated dependencies [4974c91]
- Updated dependencies [36c5e0d]
- Updated dependencies [648fe91]
- Updated dependencies [4974c91]
- Updated dependencies [abf192a]
- Updated dependencies [90bb105]
- Updated dependencies [4974c91]
  - @naculus/connect-core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - @naculus/connect-core@0.1.1
