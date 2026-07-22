# @naculus/connect-lib — Development notes

Known ceilings and upgrade paths for modules that have reached ponytail convergence
(the simplest implementation that works, with documented limits).

## Getting started

```sh
# Prerequisites: Node >= 22, pnpm >= 9

git clone https://github.com/naculus/connect-lib
cd connect-lib
pnpm install
pnpm build          # Builds all packages

pnpm test:run       # Full test suite
pnpm lint           # Biome lint (suspicious + correctness only)
pnpm dev            # Watch mode for packages that have a dev script
```

## Converged — no further simplification planned

| Module | Known ceiling | Upgrade path |
|--------|--------------|------------------------|
| `UniversalConnector` interface | Matches EIP-1193 patterns. No over-abstraction. | — |
| `ConnectorManager` | Single mutex (`_connecting`), throws on concurrent connect. | per-connector locks if throughput matters |
| `SessionKeyManager` | `crypto.getRandomValues()` for IDs (not `Math.random()`). Collision probability ~2⁻¹²⁸. | — |
| `EncryptedStorageAdapter` | PBKDF2 600K iterations, AES-256-GCM, random salt+IV per write. | worker thread if UI blocking becomes measurable |
| `IndexedDB` default storage | No custom wrapper — uses native API. | manual schema migration; add migration layer if schema changes |
| `feeEstimation.ts` | Static EIP-1559 / legacy gas model detection. No dynamic optimization. | chain-specific overrides when L2s diverge |
| `financial-hazards.test.ts` (60 tests) | Property-based testing without external deps. | structured fuzzing if exploits found |
| `PocketConnector.getStorageSecurityLevel()` | Returns 1-4 enum. Levels map to specific browser APIs. | add detection for OPFS, Storage Buckets when they stabilize |

## Known gaps — deferred features

| Feature | Why deferred | Trigger to build |
|---------|-------------|------------------|
| Session blob HMAC | No integrity check — `ConnectorManager` rejects malformed JSON. | Audit pressure or compliance requirement |
| Session timeout dynamic config | Hardcoded 5 min default in `packages/core/src/constants.ts` (`SESSION_TIMEOUT_MS`). | Multi-env deployment requiring different timeouts per chain |
| Default RPC URLs | Uses public `llamarpc.com`. Edit `packages/core/src/rpc.ts` to swap. | Production deployment with dedicated RPC endpoints |

## Partially converged — notable simplification ceilings

| Module | Current state | Ceiling | Upgrade path |
|--------|--------------|---------|------------------------|
| `EVMSigner` (RLP encoding) | Hand-rolled RLP, audited internally | Use `viem.signTransaction` for audit-critical paths | Swap when audit pressure increases |
| `AES-256-GCM` implementations | Two independent copies (crypto.ts + crypto-worker.ts), same algorithm, both audited | Extract shared dep | Extract when a third consumer appears |
| `StorageAdapter` interfaces | Two interfaces (core vs wallet-engine). | Core: generic key-value. Wallet-engine: WalletData-specific. | Merge only if proven they serve the same use case |

## Architecture decisions

- **Two repos**: connect-lib (library) + connect-react (frontend). Split for CI separation and concern boundaries — frontend code makes up roughly half the combined surface area, but CI cycles and dependency profiles differ enough to warrant separate repos.
- **wallet-engine ≠ connector-embedded**: wallet-engine is pure crypto, connector-embedded is the adapter. Keeping them separate avoids leaking crypto internals into the connector interface.
- **IndexedDB > localStorage**: origin isolation + async + larger quota.
- **CAIP-2 chain IDs**: not plain integers — `eip155:1`, `solana:0`, `xrpl:0`.

## File layout

```
connect-lib/
├── packages/
│   ├── core/                  # Interfaces: UniversalConnector, ConnectorManager, WalletError
│   ├── connector-*/           # Per-chain connector implementations
│   ├── wallet-engine/         # Crypto engine: PocketWallet, EVMSigner, StorageAdapter
│   └── siwx/                  # CAIP-122 Sign-In With X
├── docs/                      # Architecture, security, standards
├── scripts/                   # publish.sh, etc.
└── test-utils/                # Shared test factories, constants, fuzzer
```
