# @naculus/connector-solana

Solana wallet connector for the Naculus Connect ecosystem.

Detects and connects to Solana browser wallets such as **Phantom**, **Solflare**, and generic Solana providers via `window.solana`. Implements the `UniversalConnector` interface from `@naculus/connect-core`.

## Features

- 🔍 **Wallet Discovery** — Auto-detects Phantom, Solflare, and generic Solana wallet extensions
- 🔗 **Connect & Disconnect** — Connect to any discovered Solana wallet
- ✍️ **Sign Messages** — Sign arbitrary messages via `solana_signMessage`
- 📝 **Sign Transactions** — Sign transactions via `solana_signTransaction`
- 📤 **Send Transactions** — Sign + send transactions via `solana_signAndSendTransaction`
- 🔄 **Chain Switching** — Update session chain ID (e.g., mainnet ↔ devnet)
- 🧩 **SIWS** — Sign-In With Solana message creation and verification via `@naculus/siwx`

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

## Dependencies

- `@naculus/connect-core` — Core connector interfaces and utilities
- `@naculus/siwx` — SIWS message creation and parsing
- `tweetnacl` — Ed25519 signature verification for Solana

## License

MIT
