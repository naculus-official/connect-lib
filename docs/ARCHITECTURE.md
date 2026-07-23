# @naculus/connect Architecture Reference

> Last updated: 2026-07-21
> Purpose: record design decisions, avoid repeated questions.

---

## Table of Contents
- [@naculus/connect Architecture Reference](#naculusconnect-architecture-reference)
  - [Table of Contents](#table-of-contents)
  - [1. Why split into two repos?](#1-why-split-into-two-repos)
  - [2. Relationship between wallet-engine and connector-embedded](#2-relationship-between-wallet-engine-and-connector-embedded)
    - [wallet-engine (@naculus/wallet-engine)](#wallet-engine-naculuswallet-engine)
    - [connector-embedded (@naculus/connector-embedded)](#connector-embedded-naculusconnector-embedded)
    - [Decision tree: when to separate, when to combine?](#decision-tree-when-to-separate-when-to-combine)
    - [Future expansion](#future-expansion)
  - [3. Connector pattern](#3-connector-pattern)
    - [UniversalConnector interface](#universalconnector-interface)
    - [Session-Based Routing](#session-based-routing)
  - [4. SIWx (@naculus/siwx)](#4-siwx-naculussiwx)
    - [CAIP-122 message format](#caip-122-message-format)
    - [Chain-specific handling](#chain-specific-handling)
  - [5. Wallet discovery mechanism](#5-wallet-discovery-mechanism)
    - [EVM (EIP-6963)](#evm-eip-6963)
    - [Solana (Wallet Standard + legacy)](#solana-wallet-standard--legacy)
    - [XRPL (Xaman deeplink)](#xrpl-xaman-deeplink)
  - [6. Standards compliance status](#6-standards-compliance-status)
  - [7. XRPL special handling](#7-xrpl-special-handling)
  - [8. Testing](#8-testing)
  - [9. Common decision log](#9-common-decision-log)
    - [Why not use enum for walletType?](#why-not-use-enum-for-wallettype)
    - [Why do ConnectorManager and createClient coexist?](#why-do-connectormanager-and-createclient-coexist)
    - [Why use mutable session objects?](#why-use-mutable-session-objects)
  - [10. Wallet storage security (IndexedDB vs localStorage)](#10-wallet-storage-security-indexeddb-vs-localstorage)
    - [Design decision](#design-decision)
    - [StorageAdapter.type property](#storageadaptertype-property)
    - [Developer force-switch](#developer-force-switch)
    - [AES-256-GCM encryption layer](#aes-256-gcm-encryption-layer)
    - [Why not encrypt by default?](#why-not-encrypt-by-default)
  - [11. Address blackhole protection (Address Validation)](#11-address-blackhole-protection-address-validation)
    - [Design decision: connect-lib handles validation logic](#design-decision-connect-lib-handles-validation-logic)
    - [Exports](#exports)
  - [12. Known Limitations (2026-07-21)](#12-known-limitations-2026-07-21)


## 1. Why split into two repos?

```
2026-07-02 before refactor:
connect/
├── packages/core/             ← library
├── packages/react/            ← React hooks + provider
├── packages/ui/               ← React components
├── packages/connect/          ← umbrella
└── connect-app/               ← demo app

2026-07-02 after refactor:
connect-lib/                    ← pure library
├── packages/core/
├── packages/connector-*/
├── packages/wallet-engine/
└── packages/siwx/

connect-react/                 ← frontend
├── packages/react/
├── packages/ui/
├── packages/connect/
└── connect-app/
```

**Rationale:** Frontend was 52.7% of the codebase but only depends on the library unidirectionally. After splitting:
- Library can be published as a framework-agnostic npm package
- Frontend can iterate independently without affecting the library
- Library tests are faster (no jsdom, react required)

---

## 2. Relationship between wallet-engine and connector-embedded

This is the most frequently asked question. Full explanation below:

### wallet-engine (@naculus/wallet-engine)

- **Position:** Standalone crypto engine
- **Dependencies:** `@noble/curves`, `@noble/hashes`, `@scure/bip39` (pure crypto, zero framework)
- **Unaware of:** `UniversalConnector`, `WalletSession`, CAIP-2
- **Can be used standalone:** `npm install @naculus/wallet-engine` for crypto-only needs
- **Exports:**
  - `PocketWallet` — wallet lifecycle (generate, import, sign)
  - `EVMSigner` — EIP-191 signing, RLP transaction encoding
  - `Signer` interface — abstract, can implement SolanaSigner, XRPLSigner in future
  - `StorageAdapter` interface — pluggable storage (localStorage, IndexedDB, React Native AsyncStorage)
  - `LocalStorageAdapter` — browser localStorage implementation

### connector-embedded (@naculus/connector-embedded)

- **Position:** Adapter layer bridging wallet-engine to the connect SDK
- **Dependencies:** `@naculus/connect-core` (interfaces), `@naculus/wallet-engine` (implementation)
- **Implements:** `UniversalConnector` interface
- **Unaware of:** BIP39 derivation, secp256k1 signing (all delegated to wallet-engine)

### Decision tree: when to separate, when to combine?

```
Need crypto only?                        → Use @naculus/wallet-engine
Need a connect SDK connector?            → Use @naculus/connector-embedded
Need both?                               → Install both (connector-embedded depends on wallet-engine)
```

### Future expansion

If building Solana or XRPL embedded wallets:
1. Add `SolanaSigner`, `XRPLSigner` to wallet-engine (implementing `Signer` interface)
2. Add `connector-embedded-solana` or `connector-embedded-xrpl`
3. Reuse wallet-engine's key management logic

---

## 3. Connector pattern

```
UniversalConnector (interface, core/connector.ts)
├── WalletConnectConnector    (connector-walletconnect)
├── EIP6963ConnectorImpl      (connector-evm-injected)
├── PocketConnectorImpl       (connector-embedded, wraps wallet-engine)
├── PasskeysConnectorImpl     (connector-passkeys)
├── SolanaConnectorImpl       (connector-solana)
└── XRPLConnectorImpl         (connector-xrpl)
```

### UniversalConnector interface

```typescript
interface UniversalConnector {
  id: string;
  name: string;
  kind: string;
  namespaces: string[];
  connect(input?: unknown): Promise<UniversalWalletSession>;
  disconnect(session: UniversalWalletSession): Promise<void>;
  signMessage?(session: UniversalWalletSession, input: unknown): Promise<unknown>;
  sendTransaction?(session: UniversalWalletSession, input: unknown): Promise<unknown>;
  switchChain?(session: UniversalWalletSession, chainId: string): Promise<void>;
  // ... other optional methods
}
```

### Session-Based Routing

All operations dispatch based on `session.walletType`:

```
signMessage(session, input)
  ├─ session.walletType === "solana"    → SolanaConnector
  ├─ session.id startsWith "eip6963-"   → EIP6963Connector
  ├─ session.walletType === "passkeys"  → PasskeysConnector
  └─ default                            → WalletConnectConnector
```

---

## 4. SIWx (@naculus/siwx)

### CAIP-122 message format

```
${domain} wants you to sign in with your ${blockchain} account:
${address}

${statement}

URI: ${uri}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}
```

`blockchain` is auto-derived from CAIP-2 namespace:
- `eip155:*` → "Ethereum"
- `solana:*` → "Solana"
- `xrpl:*` → "XRP Ledger"

### Chain-specific handling

| Chain | Signing prefix | Verification method |
|-------|---------------|-------------------|
| EVM | `\x19Ethereum Signed Message:\n` (EIP-191, handled by viem internally) | `viem.recoverMessageAddress` |
| Solana | No prefix (raw bytes) | `tweetnacl sign.detached.verify` |
| XRPL | No prefix (via Payment+Memo workaround) | `ripple-keypairs.verifyMessage` |

---

## 5. Wallet discovery mechanism

### EVM (EIP-6963)

```
Primary: window.addEventListener("eip6963:announceProvider")
         window.dispatchEvent(new Event("eip6963:requestProvider"))
```

### Solana (Wallet Standard + legacy)

```
Primary: window.addEventListener("wallet-standard:register-wallet")

fallback: window.solana / window.phantom / window.solflare
          console.warn on trigger advising wallet-standard usage
```

### XRPL (Xaman deeplink)

```
xaman://${origin}?xrt=webconnector    (connect)
xaman://tx?xrt=${encodeURIComponent(txjson)}  (sign)
```

---

## 6. Standards compliance status

| Standard | Status | Notes |
|----------|--------|-------|
| EIP-1193 | ✅ | `request({method, params})` + `on`/`removeListener` |
| EIP-6963 | ✅ | Event-driven discovery |
| EIP-4361 / CAIP-122 | ✅ | Cross-chain SIWx message format |
| Solana Wallet Standard | ✅ | `wallet-standard:register-wallet` event |
| WalletConnect v2 (CAIP-25) | ✅ | Via @walletconnect/sign-client |
| XLS-0063 (XRPL SignIn) | ⏳ Stagnant | Proposal stalled, using Payment+Memo |

---

## 7. XRPL special handling

XRPL has no native `signMessage` RPC. Current approach:

1. Construct a fake `Payment` transaction (Destination = self)
2. Put the message to sign in `Memos[0].Memo.MemoData` (hex-encoded)
3. User signs via Xaman deeplink
4. Result is a signed tx blob, not a bare signature

Tracking XLS-0063 proposal status (recorded in `AGENTS.md`).

---

## 8. Testing

```sh
pnpm test:run       # Run all tests
pnpm test:core      # Run core only
```

Test strategy:
- Each connector has unit tests (mock provider/session)
- Core has ConnectorManager unit tests
- walletconnect has integration tests
- React/UI tests live in `connect-react/`

---

## 9. Common decision log

### Why not use enum for walletType?

`walletType` uses a string literal union instead of an enum, because connectors can be externally extended (enum cannot be extended externally).

### Why do ConnectorManager and createClient coexist?

- `ConnectorManager` (core) — pure library, multi-instance, requires manual registration
- `createClient` (react) — singleton, auto-registers all built-in connectors, React integration

Currently planning to move `createClient` to the core layer so non-React projects can also use it.

### Why use mutable session objects?

Some connectors (e.g., WalletConnect) need to modify namespaces after session creation (e.g., switchChain). Immutable sessions would require cloning, causing performance overhead during frequent chain switching.

---

## 10. Wallet storage security (IndexedDB vs localStorage)

### Design decision

`PocketWallet` defaults to **IndexedDB** instead of localStorage. Reasons:

- IndexedDB provides origin isolation — XSS cannot directly access across origins
- Async API, does not block main thread rendering
- Larger storage quota (50MB+ vs 5MB)
- localStorage only used as degradation fallback when IndexedDB is unavailable

### StorageAdapter.type property

Each StorageAdapter implementation reports its own type (`"indexedDb"`, `"localStorage"`, `"encrypted"`),
letting connect-react determine whether to show security warnings.

### Developer force-switch

> ⚠️ Testing utility only, not a production path. PocketWallet auto-selects the best backend at runtime.

```typescript
// Force localStorage for test isolation
const wallet = new PocketWallet({ storageType: "localStorage" });

// Force IndexedDB (throws if unavailable)
const wallet = new PocketWallet({ storageType: "indexedDb" });
```

### AES-256-GCM encryption layer

`EncryptedStorageAdapter` wraps any backend, using PBKDF2 (SHA-256, 600K iterations) + AES-256-GCM.
Each write uses random salt (16 bytes) + IV (12 bytes).

### Why not encrypt by default?

Encryption requires the user to provide a passphrase, which adds friction. The default is IndexedDB (origin isolation + non-blocking).
Users needing higher security can optionally wrap `EncryptedStorageAdapter`.

---

## 11. Address blackhole protection (Address Validation)

### Design decision: connect-lib handles validation logic

Address validation is implemented in `packages/core/src/address-validation.ts`:

```ts
import { isValidAddress, isZeroAddress, isBurnAddress } from "@naculus/connect-core";

isValidAddress("0x1234...")             // viem.isAddress
isValidAddress("solana_addr", "solana") // base58 length check
isZeroAddress("0x0000...0000")          // true
isBurnAddress("0xdead...")              // true (starts with "dead")
```

### Exports

| Function | Returns | What |
|----------|---------|------|
| `isValidAddress(addr, chainNamespace?)` | `boolean` | Checks address format per chain (EVM → viem) |
| `isZeroAddress(addr)` | `boolean` | True for `0x0000…0000` (all chains) |
| `isBurnAddress(addr)` | `boolean` | True if hex starts with `dead`/`deaf`/`deed`/etc |

No react-specific UI warnings yet — that belongs in `connect-react` when a consumer asks for it.

---

## 12. Known Limitations (2026-07-21)

| # | Item | Status | Mitigation |
|---|------|--------|-----------|
| H4 | Embedded wallet missing `eth_signTypedData_v4` | Deferred | Use external signer (viem) for EIP-712 |
| C2 | RLP encoding is hand-rolled (`signers/evm.ts`) | Audited internally | Use viem's `signTransaction` for audit-critical paths |
| M5 | Two independent AES-256-GCM implementations | Accepted | Same algorithm. Update both simultaneously. |
| M6 | Default RPC URLs point to llamarpc.com (public) | Intentional | Override via `rpcUrl` in PocketConfig or ERC20CallOptions |
| M8 | Session blob stored without HMAC integrity | Accepted | ConnectorManager rejects malformed JSON. Use SIWx auth layer for production. |
| M9 | Session timeout 5 min default | Configurable | Set `SESSION_TIMEOUT_MS` in `packages/core/src/constants.ts` or override per env |
| L2 | No EIP-712 typed data signing (connect-core) | Deferred | Same as H4 |
| L3 | Two StorageAdapter interfaces (core vs wallet-engine) | Intentional | Core: generic. Wallet-engine: WalletData-specific. Different concerns. |
