# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
