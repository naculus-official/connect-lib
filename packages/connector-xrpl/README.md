# @naculus/connector-xrpl

**XRPL / Xaman wallet connector** — standalone package providing XRP Ledger wallet connectivity via Xaman (formerly Xumm) deep links.

This is the extracted connector from the [naculus/connect](https://github.com/naculus/connect) monorepo, published as a standalone package.

## Features

- Connect to XRP Ledger wallets via Xaman deep links
- Sign transactions and messages
- Switch between mainnet, testnet, and devnet
- XRP amount formatting utilities
- Address validation (both X-address and classic r-address)

## Installation

```bash
npm install @naculus/connector-xrpl
# or
pnpm add @naculus/connector-xrpl
```

## Usage

```typescript
import { createXRPLConnector } from "@naculus/connector-xrpl";

const connector = createXRPLConnector("mainnet");

// Connect (browser-only, triggers Xaman deep link)
const session = await connector.connect();

// Sign a transaction
const tx = connector.createPaymentTx("rDestinationAddress", "1000000");
const txid = await connector.signTransaction(session, { transaction: tx });

// Format XRP amounts
const xrp = formatXRPAmount("1000000"); // "1.000000"
const drops = parseXRPAmount("1.5");    // "1500000"
```

## API

### Classes

- `XRPLConnector` — implements `UniversalConnector` interface

### Functions

- `createXRPLConnector(network?)` — factory function
- `formatXRPAmount(amount)` — convert drops to XRP (6 decimals)
- `parseXRPAmount(amount)` — convert XRP to drops
- `isValidXRPAddress(address)` — validate X-address format
- `isValidXRPClassicAddress(address)` — validate classic r-address format

## Requirements

- Browser runtime (uses `window` for deep link handling and message events)
- Node.js 18+ for build

## License

MIT
