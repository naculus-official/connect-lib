# @naculus/connect

Cross-chain Web3 connection SDK. Pure library, no frontend components.

## Positioning

`connect-lib/` is a framework-agnostic library monorepo that only handles **connection logic**. Frontend components (React hooks, UI components) live in the separate [`connect-react/`](../connect-react/) project.

```
naculus/
├── connect-lib/       ← You are here: pure library
└── connect-react/     ← Frontend components (React)
```

## Package map

| Package | Description | Dependencies |
|------|------|------|
| `@naculus/connect-core` | Core interfaces: `UniversalConnector`, `UniversalWalletSession`, `ConnectorManager`, `WalletError` | — |
| `@naculus/connector-walletconnect` | WalletConnect v2 bridge | `core` |
| `@naculus/connector-evm-injected` | EIP-6963 browser-injected wallet discovery | `core` |
| `@naculus/connector-embedded` | Embedded non-custodial wallet (implemented via wallet-engine) | `core` + `wallet-engine` |
| `@naculus/connector-passkeys` | WebAuthn Passkeys wallet | `core` |
| `@naculus/connector-solana` | Solana injected wallet (Phantom / Solflare) | `core` |
| `@naculus/connector-xrpl` | XRP Ledger wallet (Xaman) | `core` |
| `@naculus/wallet-engine` | Low-level crypto engine (BIP39, HD derivation, signing) | `@noble/*` |
| `@naculus/siwx` | CAIP-122 Sign-In With X cross-chain verification | `core` |

### Dependency direction

```
wallet-engine (crypto engine)
  │
  v
connector-embedded
  │
  v
core ← connector-walletconnect / connector-evm-injected / connector-passkeys / connector-solana / connector-xrpl
  │
  v
siwx
```

## Quick start

> **⚠️ Pre-release** — packages are not yet published to npm.
> For local dev, see [Development](#development) below.

```sh
pnpm add @naculus/connect
# Or individual packages: pnpm add @naculus/connect-core @naculus/connector-walletconnect
```

> **Use React?** Install `connect-react` instead — it wraps the library in hooks.
> See [connect-react](../connect-react/).

```ts
import { ConnectorManager } from "@naculus/connect-core";
import { WalletConnectConnector, createWalletConnectConnector } from "@naculus/connector-walletconnect";

const manager = new ConnectorManager();

// Register connector
const wcConnector = createWalletConnectConnector({
  projectId: "your_project_id",
  metadata: { name: "My App", description: "...", url: "...", icons: [] },
});
manager.register("walletconnect", wcConnector);

// Connect
const session = await manager.connect("walletconnect");

// Sign
const signature = await manager.signMessage({ message: "hello" });

// Disconnect
await manager.disconnect();
```

## Standards compliance

| Standard | Status | Package |
|------|------|------|
| EIP-1193 (Provider API) | ✅ | connector-evm-injected |
| EIP-6963 (Multi Injected Provider Discovery) | ✅ | connector-evm-injected |
| EIP-4361 / CAIP-122 (SIWx) | ✅ | siwx |
| Solana Wallet Standard | ✅ | connector-solana |
| WalletConnect v2 (CAIP-25) | ✅ | connector-walletconnect |

## Development

```sh
pnpm install
pnpm build          # Build all packages
pnpm test:run       # Run tests
pnpm tsc --noEmit   # Type check
```

### Run single package only

```sh
pnpm --filter @naculus/connect-core build
pnpm --filter @naculus/connector-solana test
```

### WalletConnect tests (requires public URL)

```sh
pnpm tunnel           # Start tunnel (default port 3000)
pnpm tunnel:3000      # Specify port
```

## Project structure

```
connect-lib/
├── packages/            # Main packages
│   ├── core/            #   Core interfaces and types
│   ├── connector-*/     #   Per-chain connectors
│   ├── wallet-engine/   #   Crypto engine
│   └── siwx/            #   Cross-chain identity verification
├── e2e/                 # E2E tests
├── scripts/             # Dev helper scripts
└── docs/                # Technical documentation
```

## FAQ

**Q: Does connect-lib/ have UI components?**
No. Frontend components are in `connect-react/`.

**Q: What's the difference between wallet-engine and connector-embedded?**
`wallet-engine` is a pure crypto library (key generation, signing) — it doesn't know what `UniversalConnector` is. `connector-embedded` is the adapter layer that wraps wallet-engine into a connector.

**Q: How to add a new connector?**
Implement the `UniversalConnector` interface (`packages/core/src/connector.ts`), then register it in `ConnectorManager`.
