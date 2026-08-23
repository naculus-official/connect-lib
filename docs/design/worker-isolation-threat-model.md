# Worker isolation threat model, and what encrypted-init would take

Status: **design note, nothing implemented.** Describes `@naculus/wallet-engine`
as it stands at `fix/release-gate-batch-1`, so that `isolation: "worker"` is not
mistaken for a stronger guarantee than it provides.

## What happens today

`PocketConfig.isolation: "worker"` swaps `EVMSigner` for `IsolatedSigner`
(`src/wallet.ts:282`). Loading an encrypted wallet then runs:

```
PocketWallet.load()                              src/wallet.ts:517
  └─ this._storage.load()                        EncryptedStorageAdapter
       ├─ deriveKey(passphrase, salt)            src/storage/encrypted.ts:43   [main thread]
       ├─ crypto.subtle.decrypt(...)             src/storage/encrypted.ts:105  [main thread]
       └─ JSON.parse(...) -> WalletData          plaintext mnemonic + privateKey
                                                 now live in main-thread memory
  └─ initSignerWithKey(data.privateKey)          src/wallet.ts:520
       └─ IsolatedSigner.initWithKey(privateKey) src/signers/isolated-signer.ts:71
            └─ postMessage({ payload: { privateKey } })
                 └─ worker: privKey = hexToBytes(...)   src/signers/crypto-worker.ts:225
```

**Decryption happens on the main thread. The plaintext private key is then
copied across the `postMessage` boundary into the worker.**

`IsolatedSigner.init(encrypted, passphrase)` — the one entry point that would
decrypt *inside* the worker — has no callers. `grep -rn "\.init(" src/`,
excluding `initWithKey`, returns nothing. `crypto-worker.ts`'s `decryptWallet()`,
`deriveKey()` and the `EncryptedPayload` interface are unreachable from the
public API, and `IsolatedSigner` itself is not exported from `src/index.ts`
(only `EVMSigner` is), so a consumer cannot reach them either.

## What it does protect

- Signing arithmetic runs off the main thread, so intermediate state during a
  signature is not in main-thread scope.
- `terminate()` drops the worker realm, releasing its copy of the key.
- Main-thread synchronous code cannot read worker variables directly.

## What it does not protect

- **The plaintext private key is in main-thread memory regardless.**
  `WalletData.privateKey` is an ordinary JS string: it lives in the string pool
  until GC and cannot be zeroed.
- **It crosses `postMessage`.** Structured clone produces a second copy in
  transit.
- **It adds nothing against XSS.** Anything that can run JS on the page can call
  `wallet.getWalletData()` or intercept the message before it is posted.
- **It adds nothing against memory capture** — heap snapshots, crash dumps.

## Why this is not key-material isolation

Isolation, to mean anything, requires that plaintext key material never exist
outside the isolated boundary. Here it exists on both sides. The worker boundary
narrows exposure *during signing*; it does not narrow exposure *of the key*.

`PocketConfig.isolation` is currently documented as "Memory isolation mode for
sensitive data" (`src/wallet.ts:181-186`). That claims more than the
implementation delivers.

## What real worker-side decryption would take

### 1. Encrypted payload flow

```
PocketWallet.load()
  ├─ storage.loadRaw()                        ciphertext only, no decryption
  ├─ IsolatedSigner.init(encrypted, passphrase)
  │    └─ postMessage({ encrypted, passphrase, iterations })
  │         └─ worker: deriveKey -> decrypt -> parse
  │              plaintext key exists only in the worker realm
  └─ main thread receives { address }, never the key
```

Requires a new capability on `StorageAdapter`: fetch raw ciphertext without
decrypting. `load()` today always decrypts.

### 2. Passphrase handling

The passphrase still has to cross `postMessage` — a worker cannot prompt. This
exposure is unavoidable and should be documented rather than glossed over. It is
narrower than the key's: a passphrase can be released by the caller right after
the transfer, whereas the key is retained for the session.

### 3. KDF metadata and payload versioning

Today's payload is `{ salt, iv, ciphertext }` with no iteration count, written
at a hard-coded 600,000 (`src/storage/encrypted.ts:19`) and read back at the
same constant. Self-consistent, but only because both sides are fixed.

The moment iterations vary, the payload must record them:

```jsonc
{ "v": 1, "kdf": "PBKDF2-SHA256", "iterations": 600000,
  "salt": "…", "iv": "…", "ciphertext": "…" }
```

The worker decrypts with the payload's recorded value, *and* checks it against
the current floor. Below the floor it should still decrypt — refusing would
brick existing wallets — but warn, and re-encrypt at the new floor on next save.

### 4. Backward compatibility

Existing payloads have no `v` and no `iterations`. Read path: no `v` means v0,
which means 600,000 — the value they were actually written with. Every existing
wallet keeps opening.

### 5. Migration

Lazy. After a successful v0 decrypt, if the floor has since risen, rewrite in v1
form at the new value on the next `save()`. No migration script, no user action.

### 6. Browser regression probe

Gate 2 gains `wallet-engine:worker-encrypted-init`: drive `init()` with a fixed
fixture payload containing key material explicitly marked as test-only, and
assert the worker decrypted it. The probe reports a boolean and an error code —
never the payload, the passphrase, or any derived material.

This probe cannot be written before `init()` is wired up: there is no public
entry point to reach it from today.

## Semver

| change | class |
|---|---|
| payload gains `v` / `iterations`, read stays backward compatible | minor |
| `isolation: "worker"` decrypts inside the worker | minor — behaviour changes, and `load()`'s failure modes move into the worker |
| `StorageAdapter` gains raw-ciphertext access as an optional method | minor |
| …as a required interface method | **major** |

## Documentation

The `PocketConfig.isolation` doc comment should say what is actually
guaranteed. Suggested wording, to be applied when someone owns that change —
**this note does not modify it**:

> `"worker"` — runs signing in a Web Worker. The private key is decrypted on the
> main thread and transferred to the worker, so plaintext key material exists in
> main-thread memory. This narrows exposure during signing; it is not full
> key-material isolation.

Renaming (`isolation` → `signingContext`, say) would be a breaking change, and
once worker-side decryption lands the current name is accurate anyway. Making
the documentation match the implementation is the part worth doing first.

## Related, not covered here

`crypto-worker.ts:184` reads `process.env.PBKDF2_ITER` with no floor check, so a
build environment can silently weaken the KDF. It is unreachable today for the
same reason the rest of the decrypt path is, but it shares a root cause with
this note and should be fixed alongside it.
