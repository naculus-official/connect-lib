# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
