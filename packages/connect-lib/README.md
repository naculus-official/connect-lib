# @naculus/connect

Convenience umbrella package — install one and get all `@naculus/*` packages.

## Install

```sh
npm install @naculus/connect
```

Equivalent to installing all of:

| Package | Description |
|------|------|
| `@naculus/connect-core` | Core interfaces and ConnectorManager |
| `@naculus/connector-walletconnect` | WalletConnect v2 bridge |
| `@naculus/connector-evm-injected` | EVM browser-injected wallet |
| `@naculus/connector-embedded` | Embedded non-custodial wallet |
| `@naculus/connector-passkeys` | WebAuthn Passkeys wallet |
| `@naculus/connector-solana` | Solana wallet |
| `@naculus/connector-xrpl` | XRPL wallet |
| `@naculus/siwx` | CAIP-122 cross-chain verification |
| `@naculus/wallet-engine` | Key engine (BIP39, signing) |

## Usage

```ts
import { ConnectorManager } from "@naculus/connect-core";
import { WalletConnectConnector } from "@naculus/connector-walletconnect";
```

Or install only the packages you need.
