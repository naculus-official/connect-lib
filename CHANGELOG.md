# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Session keys that act on the owner's account through EIP-7702** (`@naculus/connect-core`, `@naculus/wallet-engine`) — `mode: "eip7702"` session keys on MetaMask Delegation Framework v1.3.0 (Ethereum, Sepolia, Base, Base Sepolia, Arbitrum One, Optimism, Polygon). The owner's account, already delegated to `EIP7702StatelessDeleGatorImpl`, signs an EIP-712 `Delegation` to the session key whose caveats encode the scope (expiry, targets, methods, native caps, one token allowance, one recipient, call count) and pin the session key as the only redeemer; the key then sends `redeemDelegations` transactions and the chain enforces the caveats. Scopes the chain cannot enforce are refused (several tokens or recipients, no `allowedMethods`, the owner's account or DelegationManager as a target, forbidden selectors). core: `caveatsFromScope`, `buildDelegation`, `delegationTypedData`, `prepareDelegation` / `attachDelegation` / `buildDelegationRedemption` / `signDelegationRedemption`. `PocketWallet.createSessionKey({ mode: "eip7702", … })` and `sendWithSession` use it, including with `isolation: "worker"` (the worker signs the delegation). Design: `docs/design/eip7702-session-delegation.md`.

- **The crypto worker signs EIP-712 typed data** (`@naculus/wallet-engine`) — `IsolatedSigner.signTypedData`, so `PocketWallet.signTypedData` works with `isolation: "worker"`. The EIP-712 encoder moved to a module shared by `EVMSigner` and the worker (byte-identical output, pinned by viem vectors).

### Fixed

- **EIP-712 signatures over negative `int8`…`int248` values were wrong** (`@naculus/wallet-engine`) — the encoder used an N-bit two's complement where ABI sign-extends to 256 bits, so such signatures matched no verifier.
- **EIP-712 dropped struct types referenced through fixed or nested arrays** (`@naculus/wallet-engine`) — `P[2]` or `P[][]` left `P` out of the encoded type string, so the signature matched no verifier.

### Changed

- **An `eip7702` session key signs only its delegation redemptions** (`@naculus/connect-core`) — `setAuthorization` no longer accepts `type: "eip7702"` (it stored unverified bytes); such keys are authorized with `attachDelegation`, and raw-digest signing, typed-data signing and `getSessionBundle` refuse them.

## 0.3.0 — 2026-09-25

**Breaking for `@naculus/wallet-engine` session-key users** — see *Changed (breaking)*. Everything else is additive.

### Added

- **`@naculus/connector-solana-kit`** (new package) — `toKitSigners(roles)` turns the Solana roles a connected wallet can fill into `@solana/kit` 8 signers: a `TransactionModifyingSigner` (a wallet may rewrite the message, so the result is decoded as a new transaction with its lifetime re-derived), a `MessagePartialSigner` and a `TransactionSendingSigner`, each `null` when the wallet lacks the feature. The account's own signature is verified against its address before Kit sees it, a wallet's bytes never fill another account's signature slot, and a co-signer's existing signature is kept only when the wallet left the message unchanged. `@solana/kit` ^8 is a peer dependency; `@naculus/connector-solana` stays Kit-free.

- **`@naculus/payments-x402`** (new package) — pays x402 v2 challenges with a session key. `createX402Fetch({ signer })` answers a 402 `PAYMENT-REQUIRED` challenge once: it picks the first requirement it can pay (`exact` scheme, EIP-3009 transfer method, single EIP-155 chain; Permit2, Solana and unknown schemes are refused), builds the `TransferWithAuthorization`, has it signed by `sessionKeyX402Signer(manager, sessionId)` under the key's policy (payee via `allowedRecipients`, amount via `tokenAllowances`, chain via `allowedChainIds`), and retries with `PAYMENT-SIGNATURE`. A second 402 is an error, a challenge that arrived through a redirect or names another origin is refused, the paid retry never follows a redirect, and nothing is broadcast. Without `allowedRecipients` the key pays whatever `payTo` the server names, up to its token budget.

### Changed (breaking)

- **The embedded wallet's session keys run on connect-core's engine** (`@naculus/wallet-engine`) — wallet-engine's own `SessionKeyManager` copy is removed. It enforced neither token allowances nor forbidden selectors (`approve`, `setApprovalForAll`, …), signed with keys the owner never authorized, had no cross-tab lock, and returned a signature before recording usage. `PocketWallet` now builds the transaction and its signing hash, and core's `SessionKeyManager` checks the full policy against that same transaction, signs the hash and records usage before the signature is returned. `createSessionKey` has the wallet's EVM account sign the key's authorization. **Migration:**
  - `SessionKeyManager` is no longer exported from `@naculus/wallet-engine` (import it from `@naculus/connect-core`; its constructor differs), and `SessionSignResult` is removed.
  - Session keys created by 0.2.x are **not carried over**. Their records (localStorage `naculus_session_keys`) are left untouched and no longer read: each old session key is its own EOA, and that encrypted record is the only copy of its private key. **Before upgrading, move any funds off your 0.2.x session-key addresses** (a 0.2.x build can still sign with them); then create new keys. New records live under `naculus_embedded_session_keys`, or in the adapter passed as `sessionKeys.storage`.
  - Core's scope rules and defaults now apply: `allowedContracts` is required, omitted limits default to 0.1 ETH total value and 50 transactions, `tokenAllowances` and forbidden selectors are enforced, and only `mode: "offchain"` keys can be created (`eip7702` / `aa_module` are refused with `method_not_allowed`).
  - `listSessions` returns revoked and expired keys too (check `status`), and scope refusals use core's `session_key_scope_exceeded` instead of `session_scope_exceeded`.
  - A key whose scope sets `allowedRecipients` cannot send transactions (core refuses raw-digest signing for it).
  - `wipe()` and `destroySession()` also clear the isolated worker's key and the session manager.

### Fixed

- **Session-key transactions came from the wrong address** (`@naculus/wallet-engine`) — `sendWithSession` read the nonce and estimated gas for the wallet's own address, but the session key signs and sends as its own EOA. Nonce, gas estimate and the reported `from` are now the session key's address, and the transaction must be for the configured chain.

### Package impact

`@naculus/wallet-engine` carries the breaking change and the session-key fix. `@naculus/payments-x402` and `@naculus/connector-solana-kit` are new (each was bootstrapped on npm at 0.2.8 so its trusted publisher could be configured; 0.3.0 is their first release from the Publish workflow). The other 13 packages are version-bump-only releases required by the lockstep release model.

## 0.2.8 — 2026-09-24

### Security

- **Session-key recipient limits are bound to what is signed** (`@naculus/connect-core`) — an independent review of 0.2.7's EIP-3009 path found that `allowedRecipients` could be bypassed. `signWithSessionKey` and `signWithVerifiedOffchainAuthorization` sign a caller-supplied 32-byte digest checked only against a transaction the caller describes, so a harmless `transfer(payee, 0)` could accompany the digest of a transfer to anyone. While `allowedRecipients` is set, both now refuse, and so does `getSessionBundle` (which returned the raw key); only `signTypedDataWithSessionKey` / `signTypedDataWithVerifiedOffchainAuthorization`, where the manager derives the digest itself, can sign. **Upgrade if you use `allowedRecipients`** — in 0.2.7 it is not a payee guarantee.

### Fixed

- **Typed-data requests are read once** (`@naculus/connect-core`) — fields were read several times, so getters (or non-string objects passing the address check through `toString`) could have one transfer checked and another signed. The request is copied once; addresses and the nonce must be strings.
- **Typed data needs a token allowance** (`@naculus/connect-core`) — `TransferWithAuthorization` for a token with no `tokenAllowances` entry had no amount limit; it is now refused.

### Changed

- **Behavior change:** a session key whose scope sets `allowedRecipients` can no longer sign raw digests or export its key. With `allowedRecipients` unset, raw-digest signing is unchanged; its documentation now states that the scope applies to the described transaction, not to the digest.

### Package impact

`@naculus/connect-core` carries functional change. The other 13 packages are version-bump-only releases required by the lockstep release model.

## 0.2.7 — 2026-09-23

### Added

- **EIP-7702 owner delegation** (`@naculus/wallet-engine`, `@naculus/connect-core`, `@naculus/connector-embedded`) — an embedded-wallet account can delegate its code to an allowlisted implementation and revoke it. wallet-engine: `authorizationHash`, `PocketWallet.signAuthorization`, type-4 (`0x04`) transaction encoding in one shared EVM encoder used by `EVMSigner` and the crypto worker, and `PocketWallet.sendDelegation` — the only type-4 send path, which signs its own single authorization and sends it from and to the account (nonce = authorization nonce − 1, EIP-1559 fees only). `chainId: 0` authorizations are refused unless `unsafeAllowAnyChainAuthorization` is set. connect-core: `prepareDelegationAuthorization` (explicit allowlist, empty by default; `REVOKE_DELEGATE` always allowed; nonce computed from the pending count), `delegateAccount` / `revokeDelegation`, and optional `UniversalConnector.signAuthorization?` / `sendDelegation?` hooks. connector-embedded implements both for its own EVM account only. Browser and WalletConnect wallets do not implement them by design (they upgrade accounts through `wallet_sendCalls`). Design: `docs/design/eip7702-execution.md`.
- **Session keys sign EIP-3009 `TransferWithAuthorization` under policy** (`@naculus/connect-core`) — `signTypedDataWithSessionKey` / `signTypedDataWithVerifiedOffchainAuthorization` accept only that primary type, compute the digest from the checked request, and apply policy to the equivalent `transfer(to, value)` plus from-is-self and a `validBefore` inside the session lifetime. `SessionKeyScope` gains a recipient allowlist (`allowedRecipients`). Design: `docs/design/agentic-payments.md`.

### Changed

- **`signMessage` never falls back to `eth_sign`** (`@naculus/connector-walletconnect`, `@naculus/connector-coinbase`) — a wallet that refuses `personal_sign` now fails with `signature_rejected` after one request instead of being asked for a blind digest signature.
- **One burn-address definition** (`@naculus/connect-core`) — `isBurnAddress` is the union of known sinks, vanity prefixes and "dead" anywhere in the address.
- **`sendTransaction`, `bumpFee` and `sendWithSession` refuse type-4 transactions** (`@naculus/wallet-engine`) — their input comes from dapps; delegation goes through `sendDelegation`.

### Fixed

- **Worker isolation signed with the wrong key after a reload** (`@naculus/wallet-engine`) — with `isolation: "worker"`, a wallet saved while Solana was active reloaded with the Solana seed in the EVM worker, so EVM signatures recovered to an address the wallet does not hold. The worker is now always started with the eip155 key and cleared when there is none.
- **WalletConnect `session_extend` cleared the local expiry** (`@naculus/connector-walletconnect`) — the event carries no params; the new expiry is read from the stored session.
- **Session keys keep their PBKDF2 work factor** (`@naculus/connect-core`) — records persist `kdfIterations`, so changing the configured count no longer makes existing keys undecryptable. Revocation is documented as device-local.

### Package impact

`@naculus/connect-core`, `@naculus/wallet-engine`, `@naculus/connector-embedded`, `@naculus/connector-walletconnect` and `@naculus/connector-coinbase` carry functional change. The other 9 packages are version-bump-only releases required by the lockstep release model.

## 0.2.6 — 2026-09-21

### Added

- **CAIP-25 session lifecycle** (`@naculus/connect-core`) — `UniversalConnector.onSessionChanged?` lets a connector report a wallet-initiated change to a live session: a narrowed or re-issued scope, a new expiry, or the wallet ending it. `SessionManager` applies each change fail-closed and emits `sessionScopeChanged`, `sessionExpiryChanged` and `sessionRevoked`: a scope the wallet narrowed is applied immediately (dropped chains lose their chain sessions and the active chain moves), and a scope the wallet widened is never accepted beyond what the app already held (the excess is reported in `rejectedChains`). A revoked or expired session is torn down without calling the connector's `disconnect` and clears persistence when it was the active one. `getSession(idOrTopic)` and `revokeSession(id)` address a session directly. Design: `docs/design/caip25-session.md`.
- **Connector-neutral scope request** (`@naculus/connect-core`, `@naculus/connector-walletconnect`, `@naculus/connector-evm-injected`) — `connect({ scope: { required, optional } })` carries a CAIP-25 scope request. WalletConnect proposes it in place of its defaults; the injected connector refuses a wallet whose current chain is outside `required.eip155.chains` instead of returning a session on the wrong chain.
- **WalletConnect produces session changes** (`@naculus/connector-walletconnect`) — `session_update`, `session_extend`, `session_delete` and `session_expire` from the relay are published through `onSessionChanged`, filtered to the current topic.

### Changed

- **Sessions end when the wallet says so, on every connector** (`@naculus/connect-core`) — previously only WalletConnect's private expiry handler reacted to a wallet ending a session. Consumers listening for `sessionDisconnected` receive it for wallet-initiated revocation as before; `sessionRevoked` adds the reason.

### Package impact

`@naculus/connect-core`, `@naculus/connector-walletconnect` and `@naculus/connector-evm-injected` carry functional change. The other 11 packages are version-bump-only releases required by the lockstep release model.

## 0.2.5 — 2026-09-17

### Changed

- **Session keys now fail closed** (`@naculus/connect-core`) — `signWithSessionKey` refuses a key with no owner authorization attached; set `unsafeAllowUnauthorizedSigning: true` to restore the previous behavior. `tokenAllowances` is enforced at signing time: only exact-length ERC-20 `transfer` / `transferFrom` calldata to an allowance-scoped token is accepted and the decoded amount is charged against a per-token cumulative budget. `increaseAllowance` joins the forbidden selectors. `maxExpiryMs` (default 30 days) caps session lifetime; the constructor throws if `defaultExpiryMs` exceeds it. Usage accounting still withholds the signature when the record cannot be persisted.
- **One simulation implementation** (`@naculus/connect-core`, `@naculus/wallet-engine`) — connect-core is now the only `SimulationManager`; wallet-engine re-exports it, so its public surface and `PocketWallet` auto-simulation are unchanged. Both ERC-20 call forms are kept (`TokenConfig`, or bare address with optional decimals and per-call `rpcUrl`), a decimals lookup no longer falls back to a public RPC, and results carry a `coverage` triple so an empty change list is not mistaken for no changes.
- **WalletConnect no longer requests `eth_sign` by default** (`@naculus/connector-walletconnect`) — removed from `DEFAULT_EVM_METHODS`. The `personal_sign` → `eth_sign` fallback in `signMessage` remains reachable only when a consumer's own namespace authorizes it.

### Added

- **EIP-55 helpers** (`@naculus/connect-core`) — `toChecksumAddress` and `isChecksumAddress` in address validation, tested against the eight official vectors. `isValidAddress` is unchanged.
- **Per-confirmation notifications** (`@naculus/connect-core`) — a `confirming` status and a `per-confirm` frequency that fires every `confirmInterval` confirmations, never twice for the same count.

### Fixed

- **Session expiry** (`@naculus/connect-core`) — `isSessionExpired` now honours the top-level `expiry` (Unix seconds, milliseconds or ISO string) and treats an unparseable `auth.expiresAt` as expired instead of live.

### Package impact

`@naculus/connect-core`, `@naculus/wallet-engine` and `@naculus/connector-walletconnect` carry functional change. The other 11 packages are version-bump-only releases required by the lockstep release model.

## 0.2.4 — 2026-09-15

### Added

- **Solana wallet roles** — `getRoles(session)` separates a connected wallet's identity, signer, and payer roles. A declared-but-unavailable role is represented as `null`, and Wallet Standard discovery accepts send-only wallets.
- **Package impact** — `@naculus/connector-solana` contains the functional change. The other 13 packages are version-bump-only releases required by the lockstep release model.

## 0.2.3 — 2026-09-15

### Changed

- **Crypto dependencies** — moved the `@noble/*` and `@scure/*` dependencies to 2.x without changing the public API or signing-byte output.
- **Package documentation** — clarified the published `@naculus/connect` README's supported standards and connector scope.
- **Package impact** — packages that consume `@noble/*` or `@scure/*` carry the dependency update; packages without those dependencies are version-bump-only releases.

## 0.2.2 — 2026-09-15

### Fixed

- **Published dependency metadata** — declared `@noble/hashes` directly in `@naculus/siwx`, so consumers no longer rely on a transitive dependency.

### Changed

- **Runtime and test dependencies** — updated XRPL, Ripple keypair, Vitest, Changesets, and Node type dependencies.
- **Package impact** — `@naculus/siwx` contains the published dependency fix and `@naculus/connector-xrpl` carries the XRPL runtime refresh. Other packages are version-bump-only releases; their generated package changelogs also consume accumulated notes from 0.2.0 and 0.2.1.

## 0.2.1 — 2026-09-14

### Added

- **Payment timeline evidence** — records the timestamp and evidence for each payment stage, allowing settlement duration to be measured and preventing premature completion claims.

### Fixed

- **Release typechecking** — repaired the repository's `tsc --noEmit` failures and added typechecking to the publish workflow.
- **Package impact** — `@naculus/connect-core` contains the payment timeline API. The other 13 packages are version-bump-only releases required by the lockstep release model.

## 0.2.0 — 2026-09-14

### Added

- **Account-abstraction and execution planning** — EIP-4337 smart-account support, EIP-7702 delegation reads, sponsorship planning, and a fail-closed `planExecution` decision API.
- **EIP-5792 connector support** — completed the four call-batching methods, including `wallet_showCallsStatus`, across the injected, WalletConnect, and Coinbase connectors with shared capability decoding.
- **Session policy authorization** — signed, owner-authorized session policies with exposed authorization status and signing payloads.
- **Multi-namespace wallet support** — one wallet can operate across EVM and Solana, including Solana signing, transactions, portable key export, RPC reads, and Wallet Standard discovery.
- **Wallet security and passkeys** — passkey-unlocked storage, verifiable passkey assertions with PRF support, and transaction monitoring.
- **Connector account events** — `UniversalConnector` now reports account and chain changes.
- **SIWx smart-account signatures** — verifies ERC-1271 signatures and unwraps ERC-6492 signatures for accounts that are not deployed yet, with hardened chain verifiers and nonce consumption.
- **Core wallet primitives** — added name resolution, token metadata and lists, address validation, chain registry support, and encrypted storage.

### Fixed

- **Fail-closed account abstraction** — rejects malformed UserOperation receipts and unsafe execution plans instead of guessing.
- **Wallet isolation and simulation** — made worker isolation functional, pinned PBKDF2 at 600,000 iterations, and reported what transaction simulation actually checked.

### Changed

- **Package impact** — the functional work spans `@naculus/connect-core`, `@naculus/wallet-engine`, `@naculus/siwx`, the embedded, passkey, Solana, injected-EVM, WalletConnect, and Coinbase connectors. Safe, XRPL, wagmi, Reown, and the umbrella package were updated for the shared connector surface and dependency compatibility.

## 0.1.1 – 0.1.6

### Added

- **SIWx XRPL** — `useSignInWithXrpl` hook, SIWx message signing on XRPL connector
- **SIWx session persistence** — localStorage-based auth session with auto-restore and expiry
- **SIWx message verification** — `verifySiwxMessage` + chain verifier factories (ecrecover/ed25519)
- **SIWx sign-in UI** — `SignInButton` component with demo route
- **SIWx EVM/Solana/X hooks** — `useSignInWithEthereum`, `useSignInWithSolana`
- **SIWx core** — CAIP-122 message package (types, message builder, utilities)
- **ERC-20 balance display** — token balances in ConnectButton wallet view
- **API docs** — TypeDoc HTML output with `api.md` and typedoc config
- **Bundle optimization** — minify + `sideEffects: false` + tree-shaking audit
- **Error handling** — toast notifications, timeout/retry, user-facing error messages
- **Token balance demo** — USDC/USDT/AAVE display in `send.tsx`
- **Embedded wallet demo** — seed phrase backup flow on demo route
- **Wallet detection guide** — install links when no injected wallets found

### Fixed

- ConnectButton styles — inline → Tailwind, ~40% bundle reduction
- Dynamic import path resolution — `configureShadcnPaths()` + `resetShadcnPaths()`
- ThemeProvider SSR safety — replaced direct DOM with `<style>` tag injection
- WalletConnect QR display — skeleton fallback during provider load
- WalletConnect UX — single modal, deduplicated wallet list
- Disconnect now revokes injected wallet permissions for clean reconnect
- Balance CORS errors — fallback RPC provider chain
- Ad-blocker RPC interference — migrated to `ankr.com/eth`
- Provider cache key — EIP-6963 `walletId` instead of `window.ethereum`
- Storage layer unification — `LocalStorageSessionStorage` delegates to `StorageAdapter`
- Runtime-agnostic storage — `globalThis` fallback for Node/SSR/test environments
- QRCode reference — deferred import to prevent SSR breakage
- Dynamic RPC selection — per-chain ID in balance queries
- Chain selector — `availableChains` + CAIP-2 normalization + `useChain` alias
- Connector property sync on client instance
- Embedded wallet error code types
- WalletConnect connector tests — 12 test cases added

### Changed

- Monorepo migration — pnpm workspace with 7 packages
- Logging — replaced `console.*` with structured Logger
- UI customization — `ComponentRegistry` pattern
- Package scope — renamed to `@naculus/*`

## 0.1.0 — 2026-05-19

### Added

- Initial project scaffold
- Core abstractions — Session, Connector, Storage, Error model
- WalletConnect v2 connector (EVM + Solana)
- EIP-6963 injected wallet discovery
- React hooks — `useWallet`, `useConnect`, `useBalance`, `useSignMessage`, `useSendTransaction`, `useChain`, `useAccount`, `useDisconnect`, `useViemClient`, `useSolanaSign`, `useSolanaSend`
- UI components — ConnectButton, WalletModal, ChainSelector, QRCodeModal
- TanStack Start example app with demo routes
- XRPL connector integration
- Embedded wallet (BIP39 self-custodial)
- Mobile detection — `useIsMobile` hook
- Theme system — CSS variable caching
