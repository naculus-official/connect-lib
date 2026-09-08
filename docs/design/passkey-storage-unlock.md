# Unlocking stored wallet data with a passkey

**Status: implemented.** `EncryptedStorageAdapter` accepts a `PrfUnlockProvider`;
`@naculus/connector-passkeys` supplies one via `createPasskeyUnlockProvider()`.

Stored wallet material is encrypted with AES-256-GCM under a key derived by
PBKDF2 from a passphrase, and the derived key is non-extractable. What decides
whether an attacker can read it is therefore not the cipher — it is what
supplies the passphrase. Today that is a callback:

```ts
constructor(inner: StorageAdapter, getPassphrase: () => Promise<string>)
```

Whatever the application puts behind that callback is the real security
boundary. If it returns a constant, the threshold is "any script on this
origin". WebAuthn PRF raises it to "this user, on this authenticator".

## The seam already exists

`getPassphrase` is called on every `save` and `load`, and its result is used
only as PBKDF2 input. Nothing else depends on it being a human passphrase, so a
32-byte PRF output can take its place without touching the encryption path.

That matters for the shape of this change: it is a new source for one value,
not a new storage format.

## Key hierarchy as built

```
                       data key   32 random bytes per write
                          │  AES-256-GCM
                          ▼
                     ciphertext   the wallet JSON

  the data key is then wrapped twice, independently:

passkey (platform authenticator)          passphrase
   │  WebAuthn PRF over the stored salt      │  PBKDF2, 600k, per-write salt
   ▼                                         ▼
prfOutput  32 bytes, never persisted       KEK
   │  HKDF-SHA256, info = "naculus/wallet-storage/v1"
   ▼                                         │
  KEK ──────────► wraps.prf     wraps.passphrase ◄──────────┘
```

HKDF is not ceremony. PRF output is a raw shared secret keyed to a credential;
domain-separating it means a future second use of PRF — a session token, say —
cannot produce the same bytes as the storage key.

## The two salts, which are different things

| Salt | Where it lives | Why |
|---|---|---|
| **PRF salt** | Alongside the credential record, stable forever | The same salt must yield the same key, or the wallet stops opening |
| **PBKDF2 salt** | Inside each encrypted payload, random per write | Already there; unchanged |

The PRF salt is **not secret** — it is an input to a function only the
authenticator can compute. Storing it in plain view is correct, and treating it
as a secret would be a false sense of protection that leads to worse decisions
elsewhere.

It must never be regenerated. Rotating it silently is equivalent to deleting
the wallet, since the old ciphertext can no longer be opened.

## Fallback, which is the part that decides whether this is safe to ship

PRF is not available everywhere:

- Firefox does not implement it
- Credentials created before the extension was requested cannot have it added
- Some platforms cannot report extension results at all

`derivePrfKey` already returns null for each of those rather than throwing, so
the composition is:

```
unlock():
  prf = await derivePrfKey(storedSalt)
  if (prf) return hkdf(prf)
  return await passphraseFallback()      // whatever the app already used
```

**A record must carry a wrap per method.** A single envelope sealed under PRF
cannot be opened by the passphrase at all — the fallback would decrypt nothing,
fail, and report "invalid passphrase" for a wallet whose passphrase was never
wrong. `wraps` names what is actually openable, so the error message is
accurate and, more importantly, so the fallback works.

## Recovery, and what this does not protect

PRF is bound to the authenticator. A new device produces a different output for
the same salt, so:

- **The recovery phrase remains the only backup that survives losing the
  device.** PRF protects the local copy, not the wallet.
- Losing the passkey without the phrase means losing that copy. This must be
  said in the UI at the moment the user turns PRF on, not in a document they
  will not read.
- A synced passkey (iCloud Keychain, Google Password Manager) may carry PRF
  across the user's own devices, but that is a platform behavior to observe
  rather than a guarantee to design around.

## Migration

Existing records have no `v` field and a single passphrase envelope. Absent
means `"passphrase"`, which is both true and requires no rewrite: they are read
in place, and the next save rewrites them as v2 with both wraps.

There is no separate migration step and nothing to roll back, because the
passphrase wrap is never removed. The dangerous version of this change — read
under the old key, write under a new one, hope — does not arise: a v2 write is
a single `save` that either lands whole or leaves the previous record
untouched.

## What this does not change

WebCrypto supports neither secp256k1 nor mature Ed25519, so the signing key
itself still cannot be a non-extractable `CryptoKey`. It is decrypted into
memory to sign, and that is a property of hot wallets on the web, not something
this design falls short of. PRF hardens the material at rest; the exposure
during signing is what hardware wallets exist to remove.

## Decisions

**1. Automatic, not opt-in.** Supplying `prfUnlock` is the enable step. A
protection that has to be switched on protects only the people who already
knew to look for it. Where PRF is unavailable the write is silently
passphrase-only — nothing fails, and nothing nags. The reason it is not at
full strength is reported by `getStorageSecurityReport()` for a security
panel to render, rather than as an interruption.

**2. The passphrase wrap is always written.** This is what forced the envelope
described above. Sealing the record directly under PRF would leave the
passphrase as an API that exists and a recovery path that does not: the key
was never derived from it, so it cannot open the record no matter what the
caller passes. Wrapping one data key twice is the only shape in which "keep
the passphrase in case PRF breaks" is a true statement.

The cost is stated rather than hidden: a record openable two ways is only as
hard to open as the easier way. `assessStorageSecurity()` deducts for it by
name (`passphrase-recovery-retained`) so the panel can explain the missing
points instead of showing an unexplained 95.

**3. Per-wallet salt.** The salt lives inside that wallet's own storage record,
which is keyed by `storageKey` — so it is per-wallet by construction. One
credential can protect several wallets independently, and the key that opens
one does not open another. A per-origin salt would have made every wallet on
the origin share one wrapping key.

## What changed from the sketch above

The PRF path derives its wrapping key with HKDF alone, not HKDF followed by
PBKDF2. PBKDF2's iteration count exists to make a low-entropy human passphrase
expensive to guess. PRF output is 32 uniformly random bytes bound to an
authenticator, so 600k iterations over it buy nothing and cost that much on
every unlock.

Each wrap records its own `iterations`. Without it, changing `KEY_ITERATIONS`
later would leave every existing record impossible to derive a key for, and
the same passphrase producing a different key reads to a user as "invalid
passphrase" for a passphrase that was never wrong.
