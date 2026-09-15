# @naculus/wallet-engine

## 1.0.0

### Major Changes

- 4974c91: The embedded wallet holds one account per namespace.
  
  `WalletData` replaces its single `privateKey` / `address` pair with an `accounts` array and an `activeNamespace`. One seed derives a separate, independent key per BIP-44 coin type, so a wallet created from a phrase now holds both an EVM account at `m/44'/60'/0'/0/0` and a Solana account at `m/44'/501'/0'/0'` — the paths MetaMask and Phantom default to, so the same phrase opens the same accounts in either.
  
  `address` and `privateKey` remain readable on `WalletData` as views over the active account, so most call sites are unaffected. They are not persisted: storing a snapshot of a view creates a second copy that can disagree with the list it came from.
  
  **Import behavior differs by what was imported, deliberately.** A mnemonic enables both namespaces, because the accounts already exist — the same phrase in Phantom shows the Solana balance, so hiding it here would mean funds visible everywhere except in this wallet. A raw private key enables only the namespace it belongs to: a key is on exactly one curve, and showing the other would show an address the key cannot control and the user cannot recover, with nothing to explain why it stays empty.
  
  New: `account(namespace)`, `accounts()`, `setActiveNamespace()`, `backfillAccounts()`, and the exported `migrateWalletData`.
  
  ### Migration
  
  A version 1 record is migrated in memory on `load()` and is **not** written back there. A read that writes is a read that can fail, and the one thing `load()` must never do is leave someone without a wallet; the migrated shape is persisted on the next explicit save. The migration derives no Solana account, because that needs async work and this has to stay pure and total — a migration that can fail partway is a migration that can lose a wallet. Call `backfillAccounts()` to add it, which leaves the active namespace alone: a user who had an Ethereum wallet yesterday should not find themselves on Solana today.
  
  The existing integrity check survives: a stored address that does not match its private key is still rejected, because signing with a mismatched pair produces transactions from an account the user does not control.
  
  ### Fixed while making this change
  
  `{ ...this.data }` is a shallow copy, so the persisted record shared its `accounts` array with the live one. A secure wipe overwrites each key in place, which reached through the shared reference and replaced the stored key too — measured: after `destroySession()` the persisted key had become the wipe pattern and the next `load()` could not open the wallet. Storage now receives a record copied a level deeper.
  
  `wipe()` and `destroySession()` also only overwrote one key. They now cover every account, since leaving the others in memory is the opposite of a secure wipe.

### Minor Changes

- 4974c91: Export and import private keys in the forms other wallets actually read.
  
  No EIP or SLIP specifies how a private key is written down. The derivation standards decide which key belongs to which account — that is what makes a recovery phrase open the same accounts everywhere — and the text encoding of a raw key is convention. Convention is enough to interoperate, but only if followed exactly.
  
  `toSolanaSecretKeyBytes` returned 64 raw bytes. Phantom, Solflare and `solana-keygen` read base58 or a JSON array, so a user exporting a Solana key was handed something they would have had to encode themselves before any other wallet would take it. For someone trying to move their funds elsewhere, an export that needs a base58 encoder first is the same as no export.
  
  - `toEvmPrivateKeyHex` emits `0x` and 64 hex characters, and refuses a value above the secp256k1 order rather than emitting a key no wallet can use.
  - `toSolanaPrivateKeyBase58` and `toSolanaKeypairJson` emit the two forms Solana tooling reads. The public half is derived rather than trusted from the caller, so an exported key cannot disagree with its own address.
  - `detectPrivateKey` reads all three back and reports which chain the key belongs to. The 64-byte Solana form carries its own proof — the trailing 32 bytes must be the ed25519 public key of the leading 32 — so that case is verified, not inferred.
  
  A bare 32-byte value is refused rather than guessed at. No mainstream tool emits one, and a Solana *address* has exactly that shape, so accepting it would mostly mean accepting a pasted address as a key — producing an account the user cannot control, with nothing to explain why it is empty.
  
  Both directions are tested: what this wallet exports parses the way those wallets parse it, and what they export imports here and yields the same address.
- 4974c91: Add an ed25519 signer, and replace a hand-written base58 that decoded some values one byte too long.
  
  `Ed25519Signer` signs for Solana. Two differences from the EVM signer are deliberate, because copying that behavior would produce signatures the chain rejects: there is no EIP-191 prefix, since Solana wallets sign the raw bytes, and there is no recovery id, since ed25519 verification takes the public key as an input and has nothing to recover. `signTransaction` refuses rather than pretending — `TransactionRequest` describes gas, nonce and EIP-1559 fees, none of which a Solana transaction has — and `signBytes` signs a message serialized by Solana tooling, which is the division every Solana wallet uses.
  
  `connect-core` had its own base58 encoder and decoder for SNS resolution. The decoder returned one byte too many whenever the decoded value was zero: `toString(16)` yields `"0"`, which pads to a byte, and that byte was added on top of the counted leading zeros — so the all-zeros Solana System Program ID decoded to 33 bytes instead of 32. Verified against `@scure/base` before replacing it.
  
  The failure mode is quiet. Those bytes are hashed into a program-derived address, so a length that is off by one does not error; it derives a different, valid-looking address, and a `.sol` name resolves to an account that is not the owner's. Both functions now come from `@scure/base`, and a regression test covers the lengths the old implementation got wrong.
- 4974c91: An embedded wallet can now own an ERC-4337 smart account.
  
  `Signer` gains an optional `signHash`, implemented for EVM, which signs a 32-byte digest as an EIP-191 message. `signMessage` could not stand in: it encodes the string it is given, so a userOpHash passed as `"0x1234…"` was signed as those 66 characters rather than the 32 bytes they denote. The signature recovers the right key over the wrong digest, and a SimpleAccount — which applies `toEthSignedMessageHash` to the raw userOpHash — rejects it. That is why account abstraction previously refused embedded wallets outright.
  
  Exposed as `Wallet.signHash` and `PocketConnector.signHash`.
  
  Also extracts the private-key validation that was inlined three times in the EVM signer. The RLP helpers in the same directory were duplicated the same way and drifted until one copy rejected 18% of valid signatures.
- 4974c91: Finish removing the third-party simulation provider, and stop hardcoding provider preference.
  
  The earlier removal only cleaned `connect-core`. `wallet-engine` still declared `"blowfish"` in `SimulationProviderName`, still advertised a `blowfishApiKey` config field a consumer could set and never benefit from, and still had a routing branch preferring a provider by that name. The generated API report also still described a `BlowfishProvider` class and a `setBlowfishApiKey` method that no longer exist; it has been regenerated.
  
  That routing branch turned out not to be dead code: it was the only way a consumer-registered provider could win in `"auto"` mode, so removing it regressed custom providers — caught by the existing tests. Auto mode now prefers any registered provider that is available and is not the built-in `eth_call` fallback, which keeps the capability without the SDK naming who supplies it.
  
  `BalanceChange.tokenDecimals` is now `number | undefined`, matching the copy in `connect-core`. The two had drifted: one side admitted the precision may be unknown while the other guaranteed a number, so the same value was optional on one half of the workspace and required on the other. A caller that cannot tell "unknown" from a real value has no choice but to guess, and guessing 18 for a 6-decimal token understates an amount by a factor of a trillion.
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
- 4974c91: `SimulationResult` now says what the provider actually examined.
  
  An empty `balanceChanges` meant two incompatible things — the provider looked and the transaction moves no tokens, or the provider cannot look at all — and a UI has no way to tell them apart. It renders the second as the first: "no balance changes" beside a Sign button reads as reassurance when nothing was inspected.
  
  The optional `coverage` field reports whether token movement, approval grants and risk were examined. The built-in `eth_call` provider reports false for all three, because executing a call tells you whether it reverts, not what moved; filling them needs state-diff tracing or a third-party service. Absent coverage should be read as unknown and treated as conservatively as false.
  
  `balanceChanges` and `approvalChanges` are documented accordingly: empty is not a finding unless coverage says so.
- 4974c91: The embedded wallet can derive Solana accounts.
  
  Previously it derived EVM keys only — `m/44'/60'/0'/0/0` was the sole path — so a user could connect a Solana wallet through the SDK but not hold one in it.
  
  `deriveSolanaKeypair` derives from a BIP-39 seed at `m/44'/501'/0'/0'`, the path Phantom, Solflare and Backpack default to. Matching it is the point: the same recovery phrase must produce the same account in any of them, or the wallet is a place funds go in and cannot come out of. `toSolanaSecretKeyBytes` returns the 64-byte secret ‖ public form the Solana CLI and `@solana/web3.js` expect, which is the export route.
  
  BIP-32 cannot do this — it is defined over secp256k1 and its child derivation adds scalars, which ed25519's clamped keys do not permit — so the underlying `slip10` module implements SLIP-0010, verified against the specification's own ed25519 test vectors. It supports hardened derivation only and refuses a non-hardened segment rather than hardening it silently, because deriving a different key than the caller asked for would put funds at an address they never see.
  
  Adds `@scure/base` for base58. Encoding an address is a path where a mistake sends funds somewhere unrecoverable, and the workspace already relies on `@scure`/`@noble` for this class of work; a hand-written base58 would have been a third copy in this repo.
- 4974c91: The embedded wallet can now sign for Solana, and import a Solana key.
  
  Signing routes by the active namespace instead of using one signer fixed at construction. The EVM signer applies EIP-191 and produces a recoverable secp256k1 signature; Solana signs raw bytes on ed25519 with nothing to recover. Using one for the other does not fail loudly — it produces a well-formed signature that verifies against nothing, which is the worst shape of wrong for a signing path, because everything looks like it worked. The tests check each signature against its own account's public key rather than merely checking that one came back.
  
  `signTypedData` and `signHash` refuse on Solana and name the signer, rather than substituting something. EIP-712 and the EIP-191 digest form are Ethereum constructions with no Solana equivalent to quietly stand in.
  
  A caller-supplied `config.signer` still wins for every namespace, so an integration that brings its own is not silently overridden.
  
  `importPrivateKey` now accepts what MetaMask, Phantom and `solana-keygen` export — `0x` hex, base58, or a 64-byte JSON array — and works out which chain the key belongs to rather than asking. For the Solana forms that is a proof rather than a guess: the trailing 32 bytes must be the ed25519 public key of the leading 32. Only the detected namespace is enabled.
  
  Three refusals are distinct, because they mean different things to whoever pasted the value: a bare 32-byte hex says nothing about which chain it is for, a 64-byte value whose halves do not pair is not a keypair at all, and anything else is an unrecognized format. Its parameter widens from `` `0x${string}` `` to `string` to accept the base58 and JSON forms.
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

- 4974c91: `PocketConnector` passes the wallet's namespace surface through: `accounts()`, `account(namespace)`, `setActiveNamespace()`, `backfillAccounts()` and `save()`.
  
  `backfillAccounts()` persists what it adds. A derived account that is not written is gone on the next load, so a user would be asked to backfill again every session and would reasonably conclude the feature does not work.
  
  `importFromPrivateKey` widens to `string` so the base58 and JSON forms reach the engine, which detects the chain rather than asking.
  
  `wallet-engine` now exports `WalletAccount`, `WalletNamespace`, `WalletDataV1` and `migrateWalletData`, which consumers need to work with the version 2 shape.
- 4974c91: `simulateERC20Transfer` no longer fails whenever `decimals` is omitted.
  
  Its decimals lookup read only the caller's `rpcUrl` argument, and nothing forwarded one — so the call threw "No RPC URL available for ERC-20 decimals lookup" even when the manager had been constructed with a perfectly good endpoint. The throw happened inside the method's own try, so it surfaced as `status: "unavailable"` with "Failed to prepare simulation" rather than as an error: a UI showed no preview and the user signed with nothing to check.
  
  Verified by running it against a stubbed RPC before the fix; the default path failed every time.
  
  `_erc20StaticCall` now falls back to the endpoint the manager was configured with — `EthCallProvider` exposes a readonly `rpcUrl` for that — and `simulateERC20Transfer` takes an optional trailing `rpcUrl`, so the per-call override that `simulate` already honoured is reachable from the ERC-20 path too.
  
  A test asserting the old behavior has been rewritten: it built a manager with an endpoint and asserted the lookup would refuse to use it, which encoded the bug as the specification.
- 4974c91: Lock the self-custody exit guarantee with interoperability tests.
  
  If this project disappears, a user's funds have to remain reachable from any other wallet. That holds only while the mnemonic is standard BIP-39, the derivation is the BIP-44 path other wallets default to (`m/44'/60'/0'/0/0`), and the phrase can be read back from storage rather than shown once.
  
  All three are now asserted. Two published BIP-39 vectors pin the addresses MetaMask, Rabby and Ledger Live derive; the rest are cross-checked against a derivation built directly on `@scure/bip39`, `@scure/bip32` and `@noble/curves`, so agreement is independent rather than the implementation confirming itself. A refactor that changes the derivation now fails a test instead of silently stranding funds.
- 648fe91: Expose non-secret session-policy authorization status and the exact signed
  off-chain policy message through `SessionKeyInfo`, while keeping signatures and
  private keys out of the public UI model. Keep wallet-engine's public session
  metadata (including millisecond expiry timestamps) aligned with that shared
  type so declaration builds remain publishable. Add a verifier boundary for
  revalidating persisted off-chain authorization without exposing its signature
  through the session list, including an atomic verify-and-sign boundary that
  closes the cross-tab policy-change window. Build the browser entry against Web
  Crypto so bundled cryptography cannot silently resolve to an empty Node
  `crypto` shim in Vite.
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
