# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## 0.10.0 — 2026-10-04

Recurring payments groundwork: an authorization can now cap spend per period, enforced by the device or, for EIP-7702 delegations, by the chain. Additive, with one fix that refuses what used to be silently widened (see Fixed).

### Added

- **Periodic authorization limits** (`@naculus/connect-core`) — grants take an optional `period` (`amount` per fixed window of `seconds` from `start`, unused amount forfeited), on top of the per-payment, lifetime-total and count limits. EVM and Solana off-chain session keys enforce it before signing (`enforcement: "device"`), fail closed on missing or malformed period usage, and reset per window. Existing scopes, usage records and Solana v1 scope bindings are unchanged.
- **Periodic limits on chain** (`@naculus/connect-core`) — `periodLimits` compile to MetaMask Delegation Framework v1.3.0 `ERC20PeriodTransferEnforcer` / `NativeTokenPeriodTransferEnforcer` caveats; the EVM compiler's `mode: "eip7702"` reports `enforcement: "on-chain"`, and `requireOnChain` succeeds only when every limit has a caveat (device-only EVM, Solana and MPP targets are refused). A per-payment cap is accepted on chain when the total or period caveat already bounds a single transfer (e.g. 10 per 30 days, 120 total). Verified on Sepolia against the deployed enforcers: paid within a 60-second period, refused above it, paid again after the reset. Set `start` from chain time, not the device clock; the enforcer requires `start > 0`.

### Fixed

- **EIP-7702 delegations no longer drop limits they cannot express** (`@naculus/connect-core`) — since 0.8.0, `buildDelegation` silently ignored `tokenMaxPerTx`, producing an on-chain delegation without the per-transaction cap. It now refuses `tokenMaxPerTx`, multiple token allowances and mismatched period limits with `session_key_invalid_input`. Only hand-built `eip7702` scopes that set them are affected; the authorization compiler emits `offchain` scopes, or `eip7702` scopes without `tokenMaxPerTx`.

## 0.9.0 — 2026-10-04

Additive; no breaking change. Pay x402 from MetaMask, Coinbase Wallet, Rabby, OKX or Phantom with `walletX402Signer`, and switch to chains the wallet has not added yet (Base Sepolia among them).

### Added

- **External-wallet x402 signer** (`@naculus/payments-x402`) — `walletX402Signer` pays EIP-3009 challenges through an EIP-1193 wallet. It switches to the typed-data chain, maps wallet rejection, and recovers the returned 65-byte signature against the requested account before the payment is sent; smart-contract wallet signatures remain explicitly unsupported.

### Fixed

- **Injected wallets can add payment-supported EVM chains** (`@naculus/connect-core`, `@naculus/connector-evm-injected`) — `wallet_addEthereumChain` parameters now come from the core chain registry instead of a second connector-only list. The registry includes Base Sepolia (x402/MPP testnet) and add-chain metadata for Ethereum, Sepolia, Base, Arbitrum, Optimism, and Polygon. Unknown-chain errors retain their specific chain-naming message through the public session switch API without changing the `chain_unsupported` code.

## 0.8.1 — 2026-10-03

Additive; no breaking change.

### Added

- **EVM session-key usage in authorization listings** (`@naculus/connect-core`) — `SessionKeyInfo` can expose the authoritative persisted native value, per-token spend, and transaction count, allowing `listAuthorizations` to report EVM spend without changing signing, enforcement, or legacy records.

## 0.8.0 — 2026-10-03

Adds the authorization model (declare what a delegate may spend once, compile it to the existing enforcers, list and revoke it) and opt-in on-chain receipt verification. No breaking change; everything is additive:

- `SessionKeyScope` gains `tokenMaxPerTx` and `nativeTransfer`, both optional and off by default. Existing keys and scopes behave exactly as before.
- x402 and MPP fetch results gain `settlementBinding` (what the client signed), used by `verifyX402Settlement` / `verifyMppSettlement`. Fetch itself is unchanged; verification is a separate call.

### Added

- **Unified authorization model** (`@naculus/connect-core`) — declares versioned, CAIP-19 asset grants once, validates them fail-closed, previews spend decisions with a pure evaluator, and compiles only faithfully expressible policies to the existing EVM, Solana, and MPP session enforcers. Deterministic differential tests keep evaluator decisions aligned with those signing-time checks.
- **Authorization listing and revocation dispatch** (`@naculus/connect-core`) — `listAuthorizations` reads existing EVM, Solana, and MPP voucher managers into one exact-or-flagged view without new storage; legacy unrestricted-recipient EVM keys and scopes outside the shared value-transfer model are identified explicitly. `revokeListedAuthorization` routes to the owning manager, reporting when a Solana delegate still needs owner-signed on-chain revocation without signing or broadcasting itself.
- **Fully expressible EVM authorization grants** (`@naculus/connect-core`) — session scopes can independently cap each allowance-scoped token transfer with `tokenMaxPerTx`, including EIP-3009 typed-data signing, and can opt into positive-value empty-calldata native transfers only to `allowedRecipients`. The authorization compiler now emits both shapes without widening contract calls or native-value budgets.
- **Opt-in settlement verification** (`@naculus/connect-core`, `@naculus/payments-x402`, `@naculus/payments-mpp`) — verifies EIP-3009 receipts by chain, confirmation depth, exact `Transfer`, and signed `AuthorizationUsed` nonce; verifies Solana charges by genesis, transaction outcome, exact owner balance deltas, and signed-message hash; and verifies MPP session closes by program ownership, distributed channel state, and the last voucher cumulative. Fetch remains unchanged and never verifies or broadcasts implicitly.

## 0.7.0 — 2026-10-01

Adds the client side of the Solana MPP **session** intent (metered payments over a payment channel). Compatibility notes:

- `EthCall` (`@naculus/siwx`) — `to` is now optional. A custom `EthCall` must pass a call without `to` through as a contract-creation `eth_call` (standard JSON-RPC behavior); this is how counterfactual ERC-6492 signatures are verified.
- `createMppSessionFetch` follows `draft-solana-session-00` as revised in July–August 2026. It interoperates with the pay-kit session server from source (`solana-foundation/pay-kit` main, verified on a mainnet fork running the deployed `CHNLx…` program), **not** with `@solana/mpp` 0.7.0 on npm, which predates those revisions.

### Added

- **`createMppSessionFetch`** (`@naculus/payments-mpp`) — opens a policy-checked Solana MPP payment channel with an owner-signed transaction and a sealed delegated voucher key, signs only app-metered cumulative usage, supports cooperative and forced close, and exposes open channels for recovery UI. Program deployment, RPC cluster, mint, payee, price, grace period, split policy and server blockhash are verified before signing.
- **`ChannelVoucherKeyManager`** (`@naculus/connect-core`) — creates record-bound encrypted ed25519 keys for Solana MPP channels, fixes channel identity at creation, verifies the channel PDA after open, and persists cumulative voucher budgets before returning canonical 50-byte voucher signatures.

### Fixed

- **Counterfactual ERC-6492 SIWX signatures** (`@naculus/siwx`) — `createEVMVerifier` now verifies undeployed smart accounts with the ERC-6492 validator creation bytecode through a contract-creation `eth_call`, while deployed accounts continue to use ERC-1271 with the inner signature.
- **Solana MPP forced close completes without a server** (`@naculus/connect-core`, `@naculus/payments-mpp`) — adds the permissionless channel `seal` transaction builder and makes `forceClose().withdrawPayer()` seal an elapsed `Closing` channel before withdrawing. It now reports the exact retry time during the grace period and refuses missing or unrecognized channel state instead of broadcasting a transaction that the program will reject.
- **Solana MPP session recovery and accounting** (`@naculus/payments-mpp`) — signed voucher units are committed exactly once across failed requests, meter additions made in flight are preserved, concurrent first requests share one channel open, and a failed response after the signed open reaches the server retains the channel for `forceClose()` recovery while revoking its voucher key.

## 0.6.0 — 2026-09-30

No breaking changes to public APIs. Two connectors now refuse inputs they used to mishandle silently — see *Fixed* (Coinbase `connect({ chainId })`, `SmartAccountManager` with a foreign `chainId`).

### Added

- **Solana payment-channel primitives for the MPP session intent** (`@naculus/connect-core`) — channel PDA derivation, open / topUp / requestClose / withdrawPayer builders, the 50-byte voucher encoding with `signVoucher` / `verifyVoucher`, `assertTrustedChannelProgram` (the channel program must be the reviewed deployment: address, ProgramData, deployed slot and upgrade authority), and `verifySignedChannelOpen`. Byte-identical to `@solana/mpp` 0.7.0's generated client. The session client itself is not in this release. Design: `docs/design/mpp-session.md`.
- **`normalizeEip155ChainId` / `requireEip155ChainId`** (`@naculus/connect-core`) — one EIP-155 chain-ID reader for wallet events (`eip155:N`, `0x` hex, decimal) and one checker for configuration.

### Changed

- **Chain IDs from wallets and configuration go through connect-core** (`@naculus/connector-embedded`, `@naculus/connector-passkeys`, `@naculus/connector-evm-injected`) — each connector had its own copy. Chain IDs above `Number.MAX_SAFE_INTEGER` are now refused everywhere (`connector-passkeys` and `connector-evm-injected` accepted them before).

- **Unused runtime dependencies removed** (`@naculus/connector-xrpl`, `@naculus/connector-solana`, `@naculus/wallet-engine`) — `xrpl`, `@solana/web3.js` and `@noble/ciphers` were declared but never imported (connector-xrpl talks to XRPL nodes directly; connector-solana uses plain `fetch`), so every install downloaded them for nothing. No behavior change.

- **connector-solana no longer depends on `@naculus/siwx` or `tweetnacl`** — they served `src/siws.ts`, which was never exported. Its README showed `createSolanaSiwsMessage` / `verifySolanaSiwsMessage` imports that did not exist; that verifier also checked only the signature (not signer, domain, nonce or expiry). The README now shows Sign-In With Solana through `@naculus/siwx`, which checks all of them.

### Fixed

- **EIP-6963 wallet selection accepts the discovered wallet ID** (`@naculus/connector-evm-injected`) — appkit returns each discovered provider's UUID as its wallet ID, but the connector treated a string passed to `connect()` only as an RDNS. Selecting a wallet by its advertised ID now finds that exact provider; RDNS selection remains supported. A string that is one wallet's UUID and a different wallet's RDNS is refused (`wallet_unavailable`) rather than resolved: announcements are unauthenticated, so a provider could otherwise claim another wallet's RDNS as its UUID and capture callers selecting by RDNS.
- **x402 with a Solana session key skips unsponsored requirements** (`@naculus/payments-x402`) — a requirement whose fee payer is the key or its owner is now skipped when choosing what to pay, so another acceptable requirement can be used; before, it was chosen and the key refused to sign (`session_scope_exceeded`). The key still refuses such a payment if asked directly.
- **connector-evm-injected re-exports its types with `export type`** — a bundler compiling sources file by file (Vite/Rollup) failed on the plain re-export; the published declarations are unchanged.
- **`abiEncodeUint256` error message** (`@naculus/connect-core`) — an amount above 2^256 − 1 was reported as "negative".
- **`SmartAccountManager` refuses a chainId it has no RPC for** (`@naculus/connect-core`) — the manager reads chain state through its one `rpcUrl`, so an account `chainId` different from the manager's `chainId` now throws `aa_invalid_input` before any RPC call instead of reading the wrong chain. Chain IDs are compared canonically (`eip155:01` is `eip155:1`); a malformed or unregistered foreign chain ID now reports the mismatch rather than `aa_no_entry_point`.
- **Coinbase connect honors the requested chain** (`@naculus/connector-coinbase`) — `connect({ chainId })` ignored `chainId` and created the session on whatever chain the wallet was on. It now throws `invalid_input` for a chain ID that is not EIP-155, and `chain_unsupported` when the wallet is on a different chain; it does not switch chains. Without `chainId`, the wallet's chain is used as before.

## 0.5.0 — 2026-09-28

**Behavior change for `@naculus/wallet-engine`** — see *Changed*: `isolation: "secure"` now throws. Everything else is additive or a fix.

### Added

- **`@naculus/payments-mpp` — MPP payments by a policy-bound session key** (new package) — answers a 402 `WWW-Authenticate: Payment` challenge for `method="evm"`, `intent="charge"` with an EIP-3009 `authorization` credential (tempoxyz/mpp-specs `draft-evm-charge-00`), signed by the session key under its policy, and retries once. Built-in EIP-712 domains for Circle USDC on the seven delegated-session chains; `tokenDomains` for others. Permit2, `transaction` and `hash` credentials, splits and every other method are refused. Interoperates with the reference SDK `mppx` (its challenges parse; our credential deserializes and its HMAC-bound challenge still verifies).

- **Solana payments for x402 and MPP, signed by the connected wallet** (`@naculus/payments-x402`, `@naculus/payments-mpp`, `@naculus/connect-core`) — x402 `exact` on SVM and MPP `solana` charges (pull mode, SPL tokens): one `TransferChecked` to the payee's associated token account, fee-payer sponsored or self-funded. Each payment is a wallet prompt (Solana session keys are not in this release). Before signing, the RPC must serve the challenge's cluster; after signing, the wallet's transaction is checked against the payment (same transfer, fee payer, blockhash and memo; only Lighthouse assertions may be added; the payer's signature must verify). core: `buildSplTransferTransaction`, `verifySignedSplTransfer`, `parseSolanaTransaction`, `associatedTokenAddress`, `readMint`, `solanaPaymentRpc`, `assertSolanaCluster`. `createX402Fetch`'s `signer` becomes optional (pass `signer`, `solana`, or both).

- **Solana session keys** (`@naculus/connect-core`, `@naculus/payments-x402`, `@naculus/payments-mpp`) — `SolanaSessionKeyManager`: an ed25519 key the owner approves once as the SPL delegate of its token account for one mint (`ApproveChecked`; the chain caps the total at the approved budget, and the owner can `Revoke` from any device). It then pays x402 SVM and MPP `solana` charges without a wallet prompt, within its scope (allowed recipients, per-payment limit, budget, expiry, count) and only when the fee is sponsored. The key signs only transfers the manager builds from checked facts, with the blockhash from the app's RPC after a cluster check; spends are recorded before the signature is returned. Pass `solana: { sessionKey: { manager, id }, rpc }` instead of `signer`. core also adds `buildApproveDelegateTransaction`, `buildRevokeDelegateTransaction`, `verifySignedOwnerTransaction`, `sourceOwner` on `SplTransferPayment`, and `sendTransaction` on `solanaPaymentRpc`. Design: `docs/design/solana-session-keys.md`.

- **Hooks for React Native** (`@naculus/connect-core`, `@naculus/connector-walletconnect`, `@naculus/connector-solana`, `@naculus/connector-coinbase`, `@naculus/connector-evm-injected`, `@naculus/wallet-engine`) — additive, web behavior unchanged. core: `Platform` gains `"native-ios"` / `"native-android"`, set with `setPlatformOverride` (React Native cannot be detected from `navigator`); `detectPlatform` / `isMobileBrowser` no longer throw when `navigator.userAgent` is absent; `isMobileDevice()` (mobile browser or declared native), which the connector manager now uses to prefer mobile-capable connectors. WalletConnect: `openUrl` option for `deepLink` (`Linking.openURL`). Solana: `registerWallet(wallet)` for a Wallet Standard wallet the app holds (Mobile Wallet Adapter). Coinbase: `provider` option to use an EIP-1193 provider (Mobile Wallet Protocol) instead of the web SDK. EIP-6963: `registerProvider(info, provider)` for an EIP-1193 provider the app holds. core: `aesGcmSeal` / `aesGcmOpen` (AES-256-GCM without WebCrypto, for React Native). wallet-engine: `KeyStoreStorageAdapter` — the wallet record sealed with AES-256-GCM under a key held by the platform key store (Keychain / Keystore on React Native); the platform glue stores only opaque strings. connector-solana sessions record `detectPlatform()` like every other connector (an iPad browser is now `mobile-web`), and `registerWallet`'s unregister removes only the entry it added. EIP-6963 discovery is skipped where `window` has no DOM event API (React Native), instead of throwing — found running the Expo example on the Android emulator.

- **x402 server side** (`@naculus/payments-x402/server`, new entry point) — `buildPaymentRequired`, `verifyPayment`, `settlePayment` and `requirePayment` for a resource server or facilitator (x402 v2, `exact` on EVM with EIP-3009 and on SVM). Verification applies the scheme's rules (EVM: token domain, payee, amount, validity window, signature, unused nonce, balance, a simulated transfer; SVM: the facilitator's transaction rules, Token-2022 screen, cluster check). Settlement goes through caller-held keys (`submit`, `signAsFeePayer`), never holds a private key, and claims each payload in an injectable duplicate-settlement store first; a Solana payment is keyed on the hash of its message, so a re-signed message is still a duplicate. Solana settlement reports success only after `confirmSolana` answers true. Permit2, ERC-7710, EIP-1271 payers and a hosted `/verify` / `/settle` API are not included.

- **MPP server side** (`@naculus/payments-mpp/server`, new entry point) — `createChallenge` (HMAC-SHA256-bound challenge ids, constant-time comparison), `verifyCredential`, `settleCredential`, `Payment-Receipt` and RFC 9457 problem responses, with an injectable replay store. EVM `authorization` (EIP-3009) and Solana `transaction` (pull mode) charges; success only once the transfer is confirmed on chain. Solana replay keys are the message hash, not a signature.

### Changed

- **`isolation: "secure"` throws** (`@naculus/wallet-engine`) — it was documented as encrypting in-memory secrets and zero-filling them, but was never implemented: the wallet silently used the default in-page signer. `PocketWallet` now fails at construction with a `WalletError` (`invalid_input`) instead of claiming protection it does not give. Use `isolation: "worker"`. The value stays in the type, marked deprecated.

### Fixed

- **WalletConnect could not start outside a bundler** (`@naculus/connector-walletconnect`) — the connector default-imported `@walletconnect/sign-client`, which under Node ESM is the module object (no `init`); only a bundler's CJS interop made it work in the browser. SSR, server-side and Node consumers failed on the first pairing. It now uses the named `SignClient` export. Found by a real-relay connect → personal_sign → disconnect run against a `@walletconnect/sign-client` wallet.

## 0.4.0 — 2026-09-26

**Behavior change for `eip7702` session keys** — see *Changed*: `setAuthorization` no longer accepts `type: "eip7702"`. Everything else is additive or a fix.

### Added

- **Session keys that act on the owner's account through EIP-7702** (`@naculus/connect-core`, `@naculus/wallet-engine`) — `mode: "eip7702"` session keys on MetaMask Delegation Framework v1.3.0 (Ethereum, Sepolia, Base, Base Sepolia, Arbitrum One, Optimism, Polygon). The owner's account, already delegated to `EIP7702StatelessDeleGatorImpl`, signs an EIP-712 `Delegation` to the session key whose caveats encode the scope (expiry, targets, methods, native caps, one token allowance, one recipient, call count) and pin the session key as the only redeemer; the key then sends `redeemDelegations` transactions and the chain enforces the caveats. Scopes the chain cannot enforce are refused (several tokens or recipients, no `allowedMethods`, the owner's account or DelegationManager as a target, forbidden selectors). core: `caveatsFromScope`, `buildDelegation`, `delegationTypedData`, `prepareDelegation` / `attachDelegation` / `buildDelegationRedemption` / `signDelegationRedemption`. `PocketWallet.createSessionKey({ mode: "eip7702", … })` and `sendWithSession` use it, including with `isolation: "worker"` (the worker signs the delegation). Design: `docs/design/eip7702-session-delegation.md`.

- **The crypto worker signs EIP-712 typed data** (`@naculus/wallet-engine`) — `IsolatedSigner.signTypedData`, so `PocketWallet.signTypedData` works with `isolation: "worker"`. The EIP-712 encoder moved to a module shared by `EVMSigner` and the worker (byte-identical output, pinned by viem vectors).

### Fixed

- **Safe App handshake is sent only to the exact parent origin** (`@naculus/connector-safe`) — the handshake used to fall back to `postMessage(…, "*")` when the browser did not expose `ancestorOrigins` (Firefox), and replies were accepted from any origin there. The parent origin now comes from `ancestorOrigins` or `document.referrer`; when neither is available, Safe detection fails closed (a Safe App whose parent strips the referrer on Firefox is no longer detected). `allowedOrigins` narrows it further. CodeQL alerts #10–#13.
- **EIP-712 signatures over negative `int8`…`int248` values were wrong** (`@naculus/wallet-engine`) — the encoder used an N-bit two's complement where ABI sign-extends to 256 bits, so such signatures matched no verifier.
- **EIP-712 dropped struct types referenced through fixed or nested arrays** (`@naculus/wallet-engine`) — `P[2]` or `P[][]` left `P` out of the encoded type string, so the signature matched no verifier.

### Changed

- **An `eip7702` session key signs only its delegation redemptions** (`@naculus/connect-core`) — `setAuthorization` no longer accepts `type: "eip7702"` (it stored unverified bytes); such keys are authorized with `attachDelegation`, and raw-digest signing, typed-data signing and `getSessionBundle` refuse them.

### Packages

`@naculus/connect-core`, `@naculus/wallet-engine` and `@naculus/connector-safe` carry the changes above. The other 13 packages are version-bump-only releases required by the lockstep release model.

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
