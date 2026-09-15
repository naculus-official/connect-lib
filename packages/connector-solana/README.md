# @naculus/connector-solana

Solana wallet connector for the Naculus Connect ecosystem.

Discovers Solana wallets through the **Wallet Standard** registry — the path Solana's own frontend documentation points new projects at — and falls back to legacy `window.solana` / `window.solflare` detection only when no Wallet Standard wallet registers. Implements the `UniversalConnector` interface from `@naculus/connect-core`.

## Features

- 🔍 **Wallet Standard discovery** — Dispatches `wallet-standard:register-wallet` and adapts any
  wallet that registers (Phantom, Solflare, Backpack, …) without a per-wallet adapter
- 🪫 **Legacy fallback** — `window.solana` / `window.solflare` detection is kept for older
  extensions and logs a warning recommending Wallet Standard
- 🔗 **Connect & Disconnect** — Connect to any discovered Solana wallet
- ✍️ **Sign Messages** — Sign arbitrary messages via `solana_signMessage`
- 📝 **Sign Transactions** — Sign transactions via `solana_signTransaction`
- 📤 **Send Transactions** — Sign + send transactions via `solana_signAndSendTransaction`
- 🔄 **Chain Switching** — Update session chain ID (e.g., mainnet ↔ devnet)
- 🧩 **SIWS** — Sign-In With Solana message creation and verification via `@naculus/siwx`
- 🎭 **Signer roles** — `identity` / `signer` / `payer`, so a wallet that cannot fill
  the role a flow needs is known before the user is asked to approve anything

## Installation

```bash
pnpm add @naculus/connector-solana
```

## Usage

```ts
import { createSolanaConnector } from "@naculus/connector-solana";

const connector = createSolanaConnector();

// Start wallet discovery
connector.startDiscovery();

// Check available wallets
const wallets = connector.getDiscoveredWallets();
console.log("Found wallets:", wallets.map((w) => w.name));

// Connect to the first discovered wallet
try {
  const session = await connector.connect();
  console.log("Connected:", session.id);

  // Get accounts
  const accounts = await connector.getAccounts(session);
  console.log("Accounts:", accounts);

  // Sign a message
  const signature = await connector.signMessage(session, { message: "Hello Solana!" });

  // Disconnect
  await connector.disconnect(session);
} catch (err) {
  console.error("Connection failed:", err);
}
```

### Signer roles

A connected wallet is not one undifferentiated "it signs things". Three
different questions get asked of it, and a wallet can answer yes to one and no
to another:

| Role | What it does | Wallet Standard feature |
|---|---|---|
| `identity` | Names the account, for an `authority`, `owner` or `feePayer` **field**. No signing. | none — always available |
| `signer` | Signs a transaction someone else assembled and someone else will submit. | `solana:signTransaction` |
| `payer` | Signs **and** broadcasts through the wallet's own RPC, returning the transaction signature. | `solana:signAndSendTransaction` |

A send-only wallet — a legitimate configuration, and the usual shape behind
Mobile Wallet Adapter — has a `payer` and no `signer`. Ask first rather than
finding out when the co-signing flow reaches the wallet:

```ts
const roles = connector.getRoles(session);

if (roles?.payer) {
  const txSignature = await roles.payer.signAndSendTransaction(serialized);
}

if (!roles?.signer) {
  // This wallet will not hand back an unsent signed transaction.
  // Offer a different one instead of opening a dialog that cannot succeed.
}

// Absent, not throwing, when the wallet has no batch feature — so you can
// choose between one approval and N without provoking an error first.
const signed = roles?.signer?.signAllTransactions
  ? await roles.signer.signAllTransactions(batch)
  : await Promise.all(batch.map((tx) => roles!.signer!.signTransaction(tx)));
```

`requireRole(roles, "signer", wallet.name)` throws a `WalletError` with code
`method_unsupported` for call sites that genuinely cannot continue without one.

The answer comes from what the wallet **declared** — its Wallet Standard
`features` record, or the methods present on a legacy injected provider —
recorded at discovery. It cannot be recovered by probing the provider
afterwards: the Wallet Standard adapter defines every method and throws inside
the ones the wallet lacks, so `typeof provider.signAndSendTransaction ===
"function"` is true even for wallets that cannot send.

### Utility Functions

```ts
import { isPhantomInstalled, isSolflareInstalled, getSolanaProvider } from "@naculus/connector-solana";

if (isPhantomInstalled()) {
  console.log("Phantom wallet is available!");
}

const provider = getSolanaProvider("phantom");
```

### SIWS (Sign-In With Solana)

```ts
import { createSolanaSiwsMessage, verifySolanaSiwsMessage } from "@naculus/connector-solana";

const message = createSolanaSiwsMessage({
  domain: "example.com",
  address: "4sGjMW1s...",
  uri: "https://example.com/login",
});
```

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Watch mode
pnpm dev
```

## API

### `createSolanaConnector(): SolanaConnector`
Create a new Solana connector instance.

### `SolanaConnector` methods
- `startDiscovery()` — Scan for browser wallet extensions
- `stopDiscovery()` — Stop scanning
- `getDiscoveredWallets()` — Get list of found wallets
- `connect(walletId?: string)` — Connect to a wallet (optional specific wallet ID)
- `disconnect(session)` — Disconnect active session
- `getAccounts(session)` — Get account addresses from session
- `getRoles(session)` — Which of `identity` / `signer` / `payer` this wallet can fill; `null` with no live session
- `signMessage(session, input)` — Sign a message with the connected wallet
- `signTransaction(session, input)` — Sign a transaction
- `sendTransaction(session, input)` — Sign and send a transaction
- `switchChain(session, chainId)` — Switch chain in session
- `onUpdate(callback)` — Subscribe to wallet discovery updates
- `clear()` — Reset connector state

### Utility exports
- `isPhantomInstalled()` — Check if Phantom wallet is available
- `isSolflareInstalled()` — Check if Solflare wallet is available
- `getSolanaProvider(walletId)` — Get the provider for a discovered wallet
- `solanaRoles(wallet, address, chain)` — Role split as a pure function, without a session
- `requireRole(roles, role, walletName)` — The role, or a `method_unsupported` `WalletError`
- `featuresFromWalletStandard(features)` / `featuresFromLegacyProvider(provider)` — What a wallet declared

## Dependencies

- `@naculus/connect-core` — Core connector interfaces and utilities
- `@naculus/siwx` — SIWS message creation and parsing
- `tweetnacl` — Ed25519 signature verification for Solana

## License

MIT
