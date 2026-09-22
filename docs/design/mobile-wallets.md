# Mobile: what "native/mobile 2/10" actually means, and the first package

Status: design, step 1 of STATE.md thread 4 (promoted from "watch" to a
work item on 2026-09-22). No code change.

## Where Naculus stands

`core` already knows it is on a phone (`detectPlatform()` →
`"mobile-web" | "in-app-browser"`), connectors declare `supports.mobile`
and `supports.deepLink`, and `UniversalConnector.deepLink?(target)` exists.
So **mobile web** — a dApp opened in Safari/Chrome on a phone, connecting to
a wallet app via WalletConnect deep links or running inside a wallet's
in-app browser via EIP-6963 / `window.ethereum` — works today and is what
the connectors were built for.

What does *not* exist is anything for an app that is itself native:

| Surface | Reown | Privy | Naculus |
|---|---|---|---|
| Mobile web (dApp in phone browser) | yes | yes | **yes** |
| React Native SDK (JS app, native shell) | yes | yes | no |
| Solana Mobile Wallet Adapter (Android, Wallet Standard over local transport) | yes | yes | no |
| Native iOS / Android / Flutter / Unity SDKs | yes | partly | no |
| Embedded wallet on device (secure enclave / keystore-backed) | yes | yes | no |

The 2/10 is the bottom three rows. They are three different amounts of work,
and only the first two are Naculus-shaped.

## Which package first, and why

**React Native** is the one to build. Reasons:

1. Naculus is a TypeScript SDK with a React binding at 51 hooks. React
   Native reuses `@naculus/connect-appkit-react` hooks *as they are* — the
   hooks do not touch the DOM; the provider and the connectors do. The gap is
   therefore a **platform layer**, not a rewrite.
2. Solana MWA is itself delivered as a React Native package
   (`@solana-mobile/mobile-wallet-adapter-protocol`), so MWA support falls
   out of the RN package rather than being a separate thread.
3. Native iOS/Android SDKs mean re-implementing the connector layer in
   Swift/Kotlin. That is a different product with a different team; not a
   Naculus 0.x item.

## `@naculus/connect-native` (working name) — what it contains

```
 connect-appkit-react hooks  (unchanged)
          │
 connect-native provider     (replaces Web3ConnectProvider's browser bits)
   ├─ storage: AsyncStorage (or a faster key-value store) adapter behind core's StorageAdapter
   ├─ WalletConnect: same connector, deep-link opener = Linking.openURL,
   │    universal-link return handling, no QR modal (list of installed
   │    wallets via canOpenURL instead)
   ├─ Coinbase: Mobile Wallet Protocol (their RN SDK) as a connector adapter
   ├─ Solana: MWA transport → produces a Wallet-Standard-shaped wallet that
   │    connector-solana already consumes; roles (identity/signer/payer)
   │    unchanged; MWA's "authorize/reauthorize" maps onto CAIP-25
   │    sessionScopeChanged / sessionRevoked (thread 13)
   ├─ platform: detectPlatform() → "native-ios" | "native-android"
   │    (new Platform values; additive)
   └─ embedded wallet: wallet-engine's worker isolation has no Web Worker
        on RN → run the IsolatedSigner in a JSI/Hermes worker or accept
        in-thread signing with keystore-backed encryption key;
        **decision needed before this piece**, not before the package
```

Deliberately out: UI components (`packages/wc` is Stencil/DOM; RN gets none
of it — apps bring their own buttons and use the hooks), passkeys (RN
WebAuthn story is immature; leave `connector-passkeys` web-only), Flutter /
Unity / native SDKs.

## What has to change outside the new package

- `core`: `Platform` union gains the two native values; `StorageAdapter`
  contract is already abstract — confirm nothing in `session-manager/
  persistence.ts` assumes `localStorage` synchronously. `detectPlatform()`
  must not touch `navigator.userAgent` on RN (it exists but lies).
- `connector-walletconnect`: the QR/URI surface is already exposed as
  `connector.uri`; the RN provider consumes it via `Linking`. Check
  `SignClient.init` storage option is pluggable (it is, via
  `storageOptions` / custom `KeyValueStorage`) so relay session persistence
  goes to AsyncStorage.
- `connector-solana`: accept a caller-supplied Wallet-Standard wallet object
  instead of only discovering from `window` — a small constructor option.
  This is also what thread 15's Kit adapter benefits from.
- `wallet-engine`: the worker-isolation decision above.

## Boundary for step 2

- New package `connect-lib/packages/connect-native/` (or under appkit as
  `packages/native` — decide by which repo's release train it should ride;
  it depends on both, so **appkit** is the natural home, next to `react`).
- Peer dependencies: `react-native`, `@react-native-async-storage/
  async-storage`, `@solana-mobile/mobile-wallet-adapter-protocol-web3js`,
  `@coinbase/wallet-mobile-sdk` — **each a user decision**, all peers, none
  bundled. No new dependency in existing packages.
- Not testable by the current tester gate (no RN runtime there). Step 2
  must include a minimal Expo example app in the tester repo (or a sibling
  `naculus-native-tester`) that runs the connect → sign → session-revoke
  loop against MWA's fake wallet and WalletConnect's test relay; without
  it the package is unverified by the workspace's own rule.
- Invariants: no key material outside wallet-engine; CAIP-2 chain ids;
  connectors keep dispatching on `session.walletType`; the RN provider
  never re-implements policy — it wires existing connectors and managers.
- Review: connector adapters (deep-link return handling, MWA authorize) are
  signing/account-selection paths → Claude review per adapter.

## Order and size

1. Platform + storage + WalletConnect over deep links (the smallest end-to-
   end proof; ~400 lines + example app).
2. Solana MWA (unlocks the "Solana MWA gap", thread 4 as originally filed).
3. Coinbase MWP.
4. Embedded wallet on device (after the isolation decision).

This is a 0.3.x / 0.4.0 line of work, not a patch. Step 1 is a Codex
package once the peer dependencies are approved and the example-app
location is chosen.
