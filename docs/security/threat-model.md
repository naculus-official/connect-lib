# Threat model and audit-readiness

Status: **documentation only**, written for a third-party security review.
Describes `naculus-official/connect-lib` at `dev` = `d95e311` (2026-09-27).
Every statement about behavior cites the code it comes from; paths are
relative to `packages/`. Statements marked **(inferred)** are conclusions
drawn from the code, not behavior the code states or tests.

External specifications the payment code implements, as pinned by the
existing design notes:

- x402 v2 — `coinbase/x402` `specs/` (pinned 2026-09-24 in
  `docs/design/agentic-payments.md`). Note: `coinbase/x402` is now a
  development fork; its README (commit `dd927a2`, 2026-04-21) says the
  canonical repository is `https://github.com/x402-foundation/x402`. The v2
  HTTP transport there (`specs/transports-v2/http.md`, last changed
  `e187dda`, 2026-08-31) still uses the `PAYMENT-REQUIRED` /
  `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers that
  `payments-x402/src/wire.ts` implements.
- MPP — `https://github.com/tempoxyz/mpp-specs` @ `08e7dd8`
  (`draft-httpauth-payment-01`, `draft-payment-intent-charge-00`,
  `draft-evm-charge-00`, `draft-solana-charge-00`), pinned 2026-09-26 in
  `docs/design/agentic-payments.md`.
- MetaMask Delegation Framework v1.3.0 —
  `https://github.com/MetaMask/delegation-framework`, release of 2025-07-24,
  pinned 2026-09-25 in `docs/design/eip7702-session-delegation.md`.

## 1. Scope

In scope: key generation, storage and signing in `core` (session keys,
Solana payment builder/verifier, EIP-7702 delegation helpers),
`wallet-engine` (embedded wallet), `payments-x402`, `payments-mpp`, and the
signing entry points of the `connector-*` packages.

Out of scope: UI packages in `naculus-official/connect-appkit`, the React
Native package described in `docs/design/mobile-wallets.md` (not present on
connect-appkit's default branch at `d18ada8`), smart contracts Naculus
calls but does not ship (Delegation Framework, token contracts, SPL Token),
and third-party wallets.

## 2. Assets

| # | Asset | Where it is created | Where it lives at rest | Where it lives in memory |
|---|---|---|---|---|
| A1 | **Mnemonic** (BIP-39, 128-bit entropy) | `PocketWallet.generate()` / `importMnemonic()` (`wallet-engine/src/wallet.ts:872`, `:896`) | Inside the `WalletData` record written by the configured `StorageAdapter` (see §4.4) | `PocketWallet.data.mnemonic`, a JS string; readable through the `mnemonic` getter (`wallet.ts:1984`) and `getWalletData()` (`wallet.ts:2020`) |
| A2 | **Embedded-wallet account keys** — secp256k1 (EIP-155) and ed25519 seed (Solana), per BIP-44 path | Derived from A1, or imported raw (`importPrivateKey`) | Same record as A1 (`WalletData.accounts[].privateKey`, hex) | `PocketWallet.data.accounts[]`; with `isolation: "worker"` also a copy of the EVM key inside the worker (`wallet.ts:868`) |
| A3 | **EVM session keys** (secp256k1) | `SessionKeyManager.createSessionKey` (`core/src/session-keys/SessionKeyManager.ts:239`) | `StoredSessionKey` record; private key AES-256-GCM sealed (`core/src/session-keys/storage.ts:160`), PBKDF2-SHA256 ≥ 600 000 | Decrypted per signature in `signStoredSessionKey` (`SessionKeyManager.ts:1045`); retained in `activeBundle` (`:1082`) |
| A4 | **Solana session keys** (ed25519, SPL delegate) | `SolanaSessionKeyManager.createSessionKey` (`core/src/session-keys/solana-session-keys.ts`) | Record under `solana_session_keys`; secret sealed with AES-GCM whose associated data is a hash of the record's fixed facts (`recordBinding`, `:137`) | Opened per payment, zero-filled after use (`signPayment`, `:490`) |
| A5 | **Delegation / authorization signatures** — (a) off-chain policy signature by the owner over a policy message; (b) EIP-712 `Delegation` signed by the owner (Delegation Framework); (c) EIP-7702 authorization tuple; (d) owner-signed SPL `ApproveChecked` | (a) `setAuthorization` (`SessionKeyManager.ts:685`); (b) `attachDelegation` (`:790`); (c) `PocketWallet.signAuthorization` / `sendDelegation` (`wallet.ts:1277`, `:1667`); (d) `attachApproval` (`solana-session-keys.ts:419`) | (a), (b) in the session-key record, **not encrypted**; (c) on chain once sent; (d) on chain once broadcast | — |
| A6 | **Payment authorizations** — EIP-3009 `TransferWithAuthorization` signatures (x402 EVM `exact`, MPP `evm` charge), partially signed Solana `TransferChecked` transactions (x402 SVM `exact`, MPP `solana` charge) | `payments-x402/src/evm-exact.ts`, `svm-exact.ts`; `payments-mpp/src/evm-charge.ts`, `solana-charge.ts` | Not persisted by Naculus; sent in `PAYMENT-SIGNATURE` / `Authorization: Payment` | Bearer until settled or expired (see §5.6) |
| A7 | **Storage unlock material** — wallet passphrase, WebAuthn PRF output, the RN key-store key | Supplied by the app (`encryptionPassphrase`, `prfUnlock`) or generated (`KeyStoreStorageAdapter`, `wallet-engine/src/storage/key-store.ts:65`) | Passphrase: never stored by Naculus. PRF salt: in the record (not secret by design, `docs/design/passkey-storage-unlock.md`). RN key: platform key store | Transient during `load`/`save` |
| A8 | **Session-key budget counters** — `useCount`, `accumulatedValue`, `accumulatedGas`, `accumulatedTokenSpends`, Solana `spent` | Updated on every signature | Same record as A3/A4, **plaintext** | — |

## 3. Adversaries considered

| Adversary | Capability assumed |
|---|---|
| Malicious or compromised **402 server** / MPP realm | Chooses every field of the challenge (amount, payee, asset, network, timeouts, memo, extensions); can redirect; can lie in receipts |
| Malicious or compromised **facilitator** | Receives signed payment authorizations; decides whether and when to settle; for Solana, is the fee payer and co-signer |
| Malicious or faulty **RPC** (EVM or Solana) | Returns arbitrary nonce, gas, code, genesis hash, blockhash, account data |
| Malicious **dapp code** calling Naculus APIs | Can call any exported function with any argument; can pass objects with getters |
| **Same-origin script** (XSS, compromised dependency) | Reads/writes `localStorage` / IndexedDB, calls any API on live objects, reads JS memory reachable from globals |
| Malicious **external wallet** or wallet extension | Returns altered signed bytes |
| **Other browser tabs** of the same origin | Run the same code concurrently against the same storage |
| **Device thief** with at-rest storage only | Offline brute force of stored ciphertext |

## 4. Trust boundaries

### 4.1 Wallet (external)

External connectors forward signing requests to a wallet the user controls
and trust the wallet's confirmation UI as the bound. Naculus adds only
consistency checks before forwarding: e.g. `connector-evm-injected` requires
`from` to be a session account (`assertSessionTransactionFrom`,
`connector-evm-injected/src/index.ts:943`) and refuses serialized
transactions it cannot decode; `connector-walletconnect` checks CAIP-25
namespaces (`namespace_mismatch` paths in `connector-walletconnect/src/index.ts`);
`connector-passkeys` refuses all EVM signing (`connector-passkeys/src/index.ts:464-490`).

For Solana payments the wallet's output is **not trusted**:
`verifySignedSplTransfer` (`core/src/solana-payment.ts:730`) re-parses what
the wallet returned and requires the same fee payer, blockhash, first three
instructions and memo, permits only Lighthouse instructions after them
(configurable; MPP passes `allowLighthouse: false`,
`payments-mpp/src/solana-charge.ts:244`), and verifies the payer's ed25519
signature over the returned message. `verifySignedOwnerTransaction`
(`solana-payment.ts:545`) does the same for the owner's approve/revoke.

### 4.2 RPC

- EVM: `PocketWallet` reads nonce, fees and code from `rpcUrl`. A delegated
  session key's creation checks `eth_getCode` for the pinned
  `EIP7702StatelessDeleGatorImpl` (`wallet.ts`, `createDelegatedSessionKey`).
  An RPC that lies about code can make that check pass **(inferred)**; the
  on-chain redemption then fails rather than misdirecting funds, since the
  Delegation is validated by the owner account's code on chain.
- Solana: `assertSolanaCluster` (`solana-payment.ts:813`) requires the
  RPC's genesis hash to match the challenge's CAIP-2 cluster before any
  signing, and the blockhash always comes from that RPC, never from the
  server (MPP's advisory `recentBlockhash` is ignored; rationale in
  `docs/design/agentic-payments.md` §Step 5). The RPC is still trusted for
  the genesis hash itself and for mint data (`readMint` → token program and
  decimals). A lying RPC can therefore mis-state the cluster or decimals
  **(inferred)**; `TransferChecked` carries the decimals, so a wrong value
  makes the on-chain instruction fail rather than transfer a different
  amount.

### 4.3 402 server and facilitator

`createX402Fetch` (`payments-x402/src/fetch.ts:62`) and `createMppFetch`
(`payments-mpp/src/fetch.ts:108`) treat the challenge as hostile:

- a challenge that arrived through a redirect, or whose response URL is on
  another origin, is refused (`fetch.ts:92`);
- x402 `resource.url` must be on the requested origin (`fetch.ts:112`);
- the paid retry is sent with `redirect: "error"` (`fetch.ts:157`) so the
  credential cannot follow a redirect;
- exactly one payment per call; a second 402 is an error;
- parsing is fail-closed (`payments-x402/src/wire.ts` header comment);
  x402 EVM accepts only `exact` + EIP-3009 and refuses Permit2
  (`evm-exact.ts`), MPP accepts only `intent="charge"`,
  `credentialTypes` containing `"authorization"`, and no splits
  (`evm-charge.ts`).

What the server still decides: which of the client's acceptable
requirements is first (`selectRequirement` takes the first payable in
server order), the amount, the payee, and `maxTimeoutSeconds`. These are
bounded only by the session-key policy (§5) and the optional `approve`
callback. **Neither fetch wrapper limits amount or payee by itself.**

The facilitator (x402) or server (MPP) receives a bearer authorization
(§5.6). Naculus does not broadcast x402/MPP payments and does not verify
settlement on chain; `PAYMENT-RESPONSE` / `Payment-Receipt` are parsed for
shape only, and a malformed receipt yields `settlement: null` rather than an
error (`fetch.ts` comments).

### 4.4 Storage

| Store | Contents | Protection |
|---|---|---|
| Embedded wallet record (`PocketWallet`, `resolveStorage`, `wallet.ts:604`) | A1, A2 | IndexedDB by default, **unencrypted unless `encryptionPassphrase` is supplied**. With a passphrase: `EncryptedStorageAdapter`, a random data key wrapped by PBKDF2-SHA256 600 000 (`storage/encrypted.ts:34`) and optionally by WebAuthn PRF → HKDF (`storage/unlock.ts:58`). Unencrypted `localStorage` is refused in a browser unless `allowInsecureStorage` (default `true` when `window` is undefined). |
| RN wallet record (`KeyStoreStorageAdapter`, `storage/key-store.ts:65`) | A1, A2 | AES-256-GCM via `@noble/ciphers` (`core/src/aead.ts:11`) under a random 32-byte key held by an app-supplied `WalletKeyStore` (e.g. iOS Keychain / Android Keystore); AAD binds a slot name |
| EVM session keys, embedded wallet (`createEmbeddedSessionKeyManager`, `wallet-engine/src/session-keys/embedded.ts`) | A3, A5(a/b), A8 | `localStorage` under `naculus_embedded_` (`:30`), or memory. Private key sealed with a password = SHA-256(seed ‖ `"naculus/embedded-session-keys/v1"`) (`:54`). **Record metadata is plaintext and independent of whether the wallet record is encrypted.** |
| EVM session keys, other hosts (`SessionKeyManager`) | A3, A5(a/b), A8 | App-supplied adapter. Password = `encryptionKey` if supplied, else a **deterministic** SHA-256 of the storage prefix and optional salt (`deriveEncryptionPassword`, `SessionKeyManager.ts:101`) — which any code knowing the prefix can recompute. AAD binds only the public key (`storage.ts:175`). |
| Legacy wallet-engine session keys | pre-0.3.0 funded session-key EOAs | Left in `localStorage` under `naculus_session_keys`, never read or deleted (`embedded.ts:27`; `docs/design/session-keys-convergence.md`) |
| Solana session keys | A4, A8 | App-supplied adapter; `encryptionKey` is required (constructor throws without it). AAD binds id, address, owner, cluster, mint, token program, decimals, budget, per-payment cap, recipients, expiry, max count (`recordBinding`). `status`, `spent`, `useCount` are **not** bound. |

Cross-tab consistency: EVM and Solana session-key mutations run under
`withAdapterLock` (`core/src/session-keys/storage.ts:257`), which uses
`navigator.locks` when present and an in-process map otherwise.

### 4.5 Browser worker vs React Native in-thread

- `isolation: "worker"` selects `IsolatedSigner` (`wallet.ts:574`). The
  worker module is loaded only from a URL derived from `import.meta.url`
  (`signers/isolated-signer.ts:28`), never a page-controlled base. The
  wallet record is still **decrypted on the main thread** and the EVM key is
  copied into the worker with `initWithKey` (`wallet.ts:868`,
  `isolated-signer.ts:111`). The EVM key and the mnemonic remain in
  main-thread memory, and every `PocketWallet` signing method still passes
  `activeAccount().privateKey` to the signer. Solana keys never enter the
  worker. This is documented in
  `docs/design/worker-isolation-threat-model.md`; the one change since that
  note is that `crypto-worker.ts` no longer reads `process.env.PBKDF2_ITER`
  (it is the constant at `signers/crypto-worker.ts:107`).
- `isolation: "secure"` is declared in `PocketConfig` (`wallet.ts:258`,
  documented as "encrypt in-memory secrets, zero-fill after use"), but no
  code path reads the value: only `"worker"` is compared
  (`grep -rn isolation wallet-engine/src`). **"secure" currently behaves as
  the default.**
- React Native has no Web Worker; the design decision
  (`docs/design/mobile-wallets.md`, decisions of 2026-09-27) is in-thread
  signing with the encryption key in the platform key store. In code, that
  is `KeyStoreStorageAdapter` plus the default `EVMSigner`. The key store
  protects the record at rest; in memory, RN has the same exposure as the
  default browser mode **(inferred)**.

## 5. Signing paths and what bounds each

### 5.1 Embedded wallet owner key (A2)

| Entry point | Bound in Naculus |
|---|---|
| `signHash`, `signMessage`, `signTypedData` (`wallet.ts:1195`, `:1220`, `:1236`) | None beyond "a wallet is loaded". Arbitrary digests, messages and typed data are signed. |
| `signTransaction` (`:1251`) | Chain must equal the configured chain (`assertConfiguredChain`). |
| `sendTransaction`, `bumpFee` | Configured chain; type-4 (set-code) transactions refused; optional simulation (`autoSimulate`). |
| `signAuthorization` (`:1277`) | Configured chain; `chainId: 0` needs `unsafeAllowAnyChainAuthorization`. The **delegate is not checked here.** |
| `sendDelegation` (`:1667`) | Authorization nonce = transaction nonce + 1, EIP-1559 fees, EVM namespace. Delegate not checked here. |
| `signSolanaTransaction` (`:1384`) | None: signs whatever message it is given in this account's slot. |
| `exportPrivateKey` / `exportSolanaKeypairJson` (`:1336`) | None; also exposed by `connector-embedded` (`connector-embedded/src/index.ts:443`). |

The EIP-7702 delegate allowlist is enforced in core's
`prepareDelegationAuthorization` (`core/src/delegation.ts:147`), which the
caller builds the request with; `EmbeddedConnector.signAuthorization` /
`sendDelegation` (`connector-embedded/src/index.ts:606`, `:628`) check the
account and chain only, and the comment says the request should be built
with that helper. **A caller that constructs the request itself bypasses
the allowlist (inferred).**

No user-confirmation hook exists in `wallet-engine` or
`connector-embedded` (`grep -i "prompt|consent|confirm"` finds none in the
signing paths). Confirmation UI for the embedded wallet is the host app's
responsibility **(inferred)**. `AuditLogger` defaults to a no-op sink
(`audit-log.ts:27`).

### 5.2 EVM session keys (A3) — `core/src/session-keys/SessionKeyManager.ts`

Common to every signing method (`signStoredSessionKey`, `:1045`), under the
per-key Web Lock and the manager's own lock:

1. Record re-read from storage (never the cache).
2. Status active, not expired, `useCount < maxTxCount`.
3. Owner authorization present (`rawSignature` or `authorization`),
   unless `unsafeAllowUnauthorizedSigning` (`:1053`).
4. `checkScopeAgainstTx`: chain allowlist, contract allowlist, forbidden
   selectors (default `approve`, `increaseAllowance`, `allowance`,
   `setApprovalForAll`, `types.ts:274`), `tokenAllowances` for exact-length
   `transfer` / `transferFrom` calldata (cumulative), recipient allowlist,
   method allowlist, per-tx and cumulative value and gas, count.
5. Sign, then persist usage (`incrementUsageUnlocked`, `:1108`); a persist
   failure throws, so the signature is not returned.

Per method:

| Method | What is signed | Binding between check and signature |
|---|---|---|
| `signWithSessionKey` (`:418`) | Caller-supplied 32-byte digest | **None**: the scope is checked against a caller-described `tx`. Refused when `allowedRecipients` is set or `mode = "eip7702"` (`refuseRawDigestForRecipientScope`, `:564`). |
| `signWithVerifiedOffchainAuthorization` (`:444`) | Caller digest | As above, plus the stored policy signature is re-verified against a message rebuilt from the stored scope by a caller-supplied builder and verifier. |
| `signTypedDataWithSessionKey` (`:488`) and `…WithVerifiedOffchainAuthorization` (`:513`) | EIP-712 digest **computed by the manager** from a snapshot of the request (`snapshotTypedDataRequest`, `typed-data.ts:83`) | Only `TransferWithAuthorization`; `from` = the key's address; token must have a `tokenAllowances` entry; `now < validBefore ≤ scope.expiry`; mapped to `transfer(to, value)` on `verifyingContract` for the scope check. |
| `signDelegationRedemption` (`:936`) | Caller digest of the outer transaction | Outer `to`/`value`/`data`/`chainId` must equal the redemption the manager re-encodes from the stored delegation; the inner execution is scope-checked. The digest itself is not derived by the manager (the method's doc comment states the residual: the key's own gas funds). |
| `getSessionBundle` (`:369`) | Returns the **raw private key** | Status checked; refused for recipient-scoped and `eip7702` keys. After return, revocation cannot recall it (doc comment at `revokeSession`). |

`eip7702`-mode keys are additionally bounded on chain by the Delegation
Framework caveats (`core/src/session-keys/delegation-framework.ts`; mapping
and refusals in `docs/design/eip7702-session-delegation.md`), including
`RedeemerEnforcer` pinning the session key as the only redeemer.
`attachDelegation` requires the delegation to hash-equal the one the
manager builds and the signature to recover to the owner with low-s
(`:790`).

The embedded wallet's `sendWithSession` (`wallet.ts:2459`) builds the
transaction, computes its signing hash, and passes both to
`signWithSessionKey` — so the embedded path is the raw-digest path, with
wallet-engine as the party that ties digest to transaction.

### 5.3 Solana session keys (A4) — `core/src/session-keys/solana-session-keys.ts`

`signPayment` (`:490`) accepts payment facts, not bytes. Under the key's
lock it re-checks (`check`, `:541`): status active, not expired, recipient
in the allowlist, `0 < amount ≤ maxPerPayment`, `spent + amount ≤ budget`,
count, and fee payer ≠ key and ≠ owner (sponsored only). It then fetches
the blockhash after `assertSolanaCluster`, builds the `TransferChecked`
with `buildSplTransferTransaction` (source = owner's ATA, authority = key),
opens the secret (which fails if any bound record fact was edited), checks
that the secret's public key equals the stored address, signs, zero-fills
the secret, re-verifies the result with `allowLighthouse: false`, and
records the spend before returning. On chain, SPL `delegated_amount` caps
the total independently. The one-delegate-per-token-account rule means
approving a key replaces any other delegate (`attachApproval`, `:419`,
retires the owner's other local keys for that mint).

### 5.4 Wallet-signed Solana payments

`createSvmPaymentPayload` (`payments-x402/src/svm-exact.ts`) and
`createSolanaChargeCredential` (`payments-mpp/src/solana-charge.ts`):
Naculus builds the transfer from the challenge, the wallet signs it, and
`verifySignedSplTransfer` checks the result (§4.1). The bound on amount and
payee is the wallet's confirmation UI and the optional `approve` callback.

### 5.5 x402 / MPP EVM payments

`sessionKeyX402Signer` (`payments-x402/src/evm-exact.ts:39`) and
`sessionKeyMppSigner` (`payments-mpp/src/evm-charge.ts:46`) call
`signTypedDataWithSessionKey`, i.e. the path in §5.2 that does **not**
re-verify the owner's off-chain policy signature — it checks only that one
is present. The scope stored in the (plaintext) record is what is enforced
**(inferred consequence: see §6, R4)**.

x402 sets `validAfter = now − 600 s` (`evm-exact.ts:58`) and
`validBefore = now + maxTimeoutSeconds`; MPP sets the nonce to
`keccak256(challenge.id ‖ challenge.realm)` (`challengeNonce`,
`evm-charge.ts:308`) and `validBefore` from `expires` or now + 300 s. MPP
has no EIP-712 domain on the wire; it comes from `tokenDomains` or the
built-in `USDC_DOMAINS` table (`evm-charge.ts:74`, values read from chain on
2026-09-26).

### 5.6 What a payment authorization is worth once signed

An EIP-3009 authorization is a bearer instrument until `validBefore` or
until its nonce is used: anyone holding it can submit it to the token
contract. The paid Solana transaction is valid until its blockhash expires
and needs only the fee payer's signature. Naculus hands both to the server
it is paying and does not track settlement **(inferred from §4.3)**.

## 6. Residual risks already documented

| # | Risk | Where documented |
|---|---|---|
| R1 | Worker isolation is not key-material isolation: decryption on the main thread, key crosses `postMessage`, no protection against XSS or heap capture. `IsolatedSigner.init` (worker-side decryption) has no caller. | `docs/design/worker-isolation-threat-model.md` |
| R2 | Hot-wallet keys cannot be non-extractable `CryptoKey`s (no secp256k1 / mature ed25519 in WebCrypto); a record with PRF and passphrase wraps is only as strong as the passphrase. | `docs/design/passkey-storage-unlock.md` |
| R3 | Off-chain session-key revocation is device-local; an exported `SessionKeyBundle` cannot be recalled; a leaked key plus a signed Delegation stays valid until `expiry` unless the owner calls `disableDelegation` on chain. | `SessionKeyManager.ts` `revokeSession` doc comment; `docs/design/eip7702-session-delegation.md` §Invariants |
| R4 | A raw digest cannot be tied to the transaction described with it; hence the recipient-scope refusal. | `refuseRawDigestForRecipientScope` comment; `docs/design/agentic-payments.md` |
| R5 | Pre-0.3.0 embedded session keys are funded EOAs whose only key copy stays in `naculus_session_keys`, unread. | `docs/design/session-keys-convergence.md` |
| R6 | MPP gives no token EIP-712 domain; a wrong domain yields an unusable signature (liveness, not funds). | `docs/design/agentic-payments.md` §Step 4 |
| R7 | Delegation Framework: allow-list only, no on-chain deny-list; multi-token / multi-recipient scopes refused; the session key's own gas funds are exposed to arbitrary digests in `signDelegationRedemption`. | `docs/design/eip7702-session-delegation.md`; `SessionKeyManager.ts:936` doc comment |
| R8 | Solana: one delegate per token account; approving replaces another dapp's delegate. The chain never expires a delegate; after local expiry the owner must revoke. | `docs/design/solana-session-keys.md` |
| R9 | React Native embedded wallet signs in-thread; weaker isolation than the web worker. | `docs/design/mobile-wallets.md` §Decisions |
| R10 | Server-controlled requirement order, amount and payee reach the key; only policy and `approve` bound them. | `payments-x402/src/fetch.ts` doc comment; `docs/design/agentic-payments.md` |

## 7. Observations from the code not covered by a design note

These are stated from the code; the impact column is **(inferred)**.

| # | Observation | Code | Inferred impact |
|---|---|---|---|
| O1 | `isolation: "secure"` is accepted but has no effect. | `wallet.ts:258`, `:574` | Integrators may believe in-memory secrets are encrypted/zeroed. |
| O2 | Without `encryptionKey`, EVM session-key records are sealed under a password derivable from the public storage prefix. | `SessionKeyManager.ts:101` | At-rest encryption is obfuscation for such hosts. The embedded wallet always supplies a seed-derived key. |
| O3 | EVM session-key budget counters, status and scope are plaintext and unauthenticated; the AAD binds only the public key. | `storage.ts:175`, `:449` (`incrementUsageUnlocked`) | Same-origin script can reset `accumulated*`/`useCount`, or widen `scope`. The `…WithVerifiedOffchainAuthorization` paths detect a widened scope (the rebuilt message no longer matches); the non-verified paths used by x402/MPP (§5.5) and by `sendWithSession` do not. Counters are unprotected on every path. The Solana manager binds scope into AAD but not `spent`; its total is capped on chain. |
| O4 | `SessionKeyManager` keeps the last decrypted key in `activeBundle` after each signature. | `SessionKeyManager.ts:1082` | Prolongs plaintext key lifetime in memory; cleared only by revoke of that id or `clearAll`. |
| O5 | Records sealed by the pre-0.2 CTR+HMAC scheme are still decryptable. | `legacyCtrHmacDecrypt`, `storage.ts:86` | Legacy code path in scope for review. |
| O6 | Expiry is evaluated against the local clock (`Date.now()`) everywhere. | `validateSessionStatus`, Solana `check` | A skewed or manipulated clock extends usable lifetime off chain (on chain, `TimestampEnforcer` and `validBefore` still apply to the chain's clock). |
| O7 | The EIP-7702 delegate allowlist lives in the request builder, not at the signing boundary. | `delegation.ts:147`; `connector-embedded/src/index.ts:606` | See §5.1. |
| O8 | Solana RPC is trusted for the genesis hash used by `assertSolanaCluster`. | `solana-payment.ts:813` | A hostile RPC could let a devnet challenge be signed with mainnet facts; the cluster check is only as good as the RPC the app configured. |
| O9 | `signWithSessionKey` (non-verified) accepts any non-empty `rawSignature` as "authorized"; verification happens only on the `…Verified…` paths. | `SessionKeyManager.ts:1053` | Storage write access can mark a key authorized. |

## 8. Questions an auditor should focus on

1. **Digest binding.** For each path in §5.2, can a caller obtain a
   signature over bytes other than those the scope check evaluated?
   Especially `sendWithSession` → `signWithSessionKey` (who computes the
   hash, and can `tx` differ from the hashed transaction), and
   `signDelegationRedemption`.
2. **Typed-data equivalence.** Is mapping `TransferWithAuthorization` to
   `transfer(to, value)` sound for every check it feeds (forbidden
   selectors, method allowlist, recipient allowlist, token allowance)? Are
   there tokens whose EIP-3009 semantics differ from `transfer`?
3. **Storage integrity (O3, O9).** Given same-origin write access, what can
   be widened on each path? Should counters and authorization state be
   authenticated (e.g. bound into AAD or MAC'd with the encryption key)?
4. **Concurrency.** Does `withAdapterLock` (Web Locks + in-process map)
   make check-sign-account atomic across tabs and across manager instances
   in every runtime Naculus targets, including ones without
   `navigator.locks` and multiple processes sharing an adapter (RN, SSR)?
5. **Challenge parsing.** Fail-closed behavior of `parsePaymentRequired`
   (`payments-x402/src/wire.ts`) and `parsePaymentChallenges`
   (`payments-mpp/src/wire.ts`), including duplicate auth-params, JCS
   decoding, base64 variants, header-size limits, and the MPP credential
   echo.
6. **Origin and redirect handling.** Whether a custom `fetch` or a service
   worker can defeat the `redirected` / `url` checks and `redirect: "error"`.
7. **Solana byte-level verification.** `parseSolanaTransaction`,
   `verifySignedSplTransfer`, `verifySignedOwnerTransaction`: v0 parsing,
   account-permission checks, Lighthouse allowance, ATA derivation,
   Token-2022 handling, and whether any accepted wallet modification can
   move value.
8. **Key lifecycle in memory.** Plaintext lifetime of A1–A4: `activeBundle`
   (O4), `WalletData` strings, `destroySession`/`wipe` overwriting
   (`wallet.ts:1134`, `:1155`), worker `clear`.
9. **KDF and ciphers.** PBKDF2 floor enforcement on write vs. per-record
   iteration counts on read; AES-GCM IV generation; HKDF domain separation
   for PRF; the seed-derived session-key password
   (`embedded.ts:54`); the deterministic fallback (O2).
10. **EIP-7702.** Allowlist placement (O7); `chainId: 0` refusal;
    nonce = tx nonce + 1; that no dapp-reachable path sends type 4
    (`sendTransaction`/`bumpFee`/`sendWithSession` refusal).
11. **Delegation Framework mapping.** `caveatsFromScope` refusals, terms
    encoding, pinned addresses per chain, `RedeemerEnforcer` presence on
    every delegation, and the `attachDelegation` hash-equality check.
12. **RPC trust (O8, §4.2).** Which decisions depend on an unauthenticated
    RPC answer, and whether any of them can redirect funds rather than
    only fail.
13. **Export and bundle APIs.** Whether `exportPrivateKey`,
    `getWalletData`, `mnemonic` and `getSessionBundle` should be reachable
    from a connector surface that dapp code can call.
14. **Legacy data.** The pre-0.2 decryption path (O5) and the unread
    `naculus_session_keys` records (R5).

## 9. How to reproduce the facts above

- Run the tests: `pnpm test:run` (root `package.json`); signing-path tests
  sit next to each file (`*.test.ts`), e.g.
  `core/src/session-keys/*.test.ts`, `core/src/solana-payment.test.ts`,
  `payments-x402/src/x402.test.ts`, `payments-mpp/src/mpp.test.ts`,
  `wallet-engine/src/signers/*.test.ts`.
- Grep checks cited above: `grep -rn isolation packages/wallet-engine/src`
  (O1); `grep -n activeBundle packages/core/src/session-keys/SessionKeyManager.ts`
  (O4).
