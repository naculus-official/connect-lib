---
"@naculus/connector-passkeys": minor
---

Make passkey assertions verifiable, and request the PRF extension.

`authenticate()` returned only the signature and `authenticatorData`. A WebAuthn signature covers `authenticatorData ‖ SHA-256(clientDataJSON)`, so without `clientDataJSON` nobody could rebuild the signed bytes, check that the challenge they issued was the one signed, or check the origin — the whole of WebAuthn's replay and phishing protection. The stored public key had never been used for anything either. Producing signatures nobody can check is not authentication; it only looks like it, which is worse than none, because a caller reasonably assumes a returned signature meant something.

`authenticate()` now returns `clientDataJSON`, the credential ID and `userHandle` alongside the signature, and `verifyPasskeyAssertion` checks all of it: challenge, origin, RP ID hash, user-verified flag, assertion type, and the signature itself against the registered key. Tested with real P-256 keys rather than mocked crypto — a forged signature, a phishing origin, a replayed challenge, a credential for another relying party and a registration response reused as an assertion are each rejected by a named check.

Credentials are now created with the PRF extension, which an authenticator can only enable at creation. `derivePrfKey` returns a 32-byte wrapping key derived from the authenticator, raising the bar on stored wallet material from "any script on this origin" to "this user's fingerprint or face".

Every unsupported path returns null rather than throwing, so a caller falls back instead of locking a user out of their own wallet: Firefox lacks PRF, older credentials were created without it, and some platforms cannot report extension results at all. That last case is recorded as unknown rather than false — one is worth retrying on a newer browser, the other is settled.

PRF is device-bound. It protects the local copy, not the wallet; the recovery phrase remains the only backup that survives losing the device.

Also fixes `loadCredential` dropping `prfSupported` when rebuilding the stored record, which made every reload forget that a credential had no PRF and prompt the user for a derivation that could not succeed.
