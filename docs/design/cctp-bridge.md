# Circle CCTP V2 bridge provider

Status: **draft 2026-10-05** — written by Claude during a Codex quota gap;
decisions below await approval before the provider is released.

## Why

A lock-and-mint bridge leaves the user holding a wrapped token whose value
depends on that bridge (USDC.e). CCTP burns native USDC on the source chain
and Circle mints native USDC on the destination: no wrapped asset, no bridge
liquidity risk. `RouteEngine` has a `BridgeProvider` interface and an Axelar
provider verified only against mocked HTTP; CCTP becomes the USDC path.

## Flow (EVM → EVM, with Circle's Forwarding Service)

1. `GET {iris}/v2/burn/USDC/fees/{srcDomain}/{dstDomain}?forward=true` →
   per finality threshold: `minimumFee` (basis points) and `forwardFee`
   (`low` / `med` / `high`, USDC base units).
2. `maxFee = forwardFee.med + amount × minimumFee / 10 000`; the user burns
   `amount + maxFee` so the recipient receives `amount`.
3. `USDC.approve(TokenMessengerV2, amount + maxFee)` — exact, never unlimited.
4. `TokenMessengerV2.depositForBurnWithHook(amount + maxFee, dstDomain,
   mintRecipient (bytes32), USDC, destinationCaller = 0, maxFee,
   minFinalityThreshold, hookData = FORWARD)` where `FORWARD` is the static
   32-byte Forwarding Service hook (`"cctp-forward"`, version 0, length 0).
5. Circle attests the burn and its Forwarding Service calls
   `receiveMessage` on the destination — **the user needs no gas on the
   destination chain**. Poll `GET {iris}/v2/messages/{srcDomain}?transactionHash=…`
   until `status == "complete"` (bounded timeout).

`minFinalityThreshold`: `1000` = Fast Transfer (seconds; subject to Circle's
global fast-transfer allowance), `2000` = Standard (hard finality; minutes).
If `maxFee` cannot cover fast + forwarding fees, CCTP falls back to Standard
with forwarding. Polygon PoS does not support Fast Transfer as a source
(Circle docs, "Source (Fast transfer): N/A"); routes from it use Standard.

Without forwarding (`hookData` empty, `depositForBurn`), the app must fetch
the attestation and call `MessageTransmitterV2.receiveMessage(message,
attestation)` on the destination itself, paying gas there.

## Addresses and domains (source: Circle docs, fetched 2026-10-05)

- Contract addresses: https://developers.circle.com/cctp/references/contract-addresses.md
- Domains: https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md
- Forwarding: https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service.md
- Attestation API: https://developers.circle.com/api-reference/cctp/all/get-messages-v2

| | Mainnet | Testnet |
|---|---|---|
| TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| Iris API | `https://iris-api.circle.com` | `https://iris-api-sandbox.circle.com` |

Domains used here: Ethereum / Sepolia 0, OP 2, Arbitrum 3, Base / Base
Sepolia 6, Polygon PoS 7. USDC addresses come from the core chain registry
(`usdcVariant: "native"` only); a chain without native USDC is refused.

## Boundary

- USDC → USDC only; any other token, a bridged USDC (`usdcVariant !==
  "native"`), or a chain without a domain is refused fail-closed.
- Calldata is built only for `approve` (exact amount to TokenMessengerV2),
  `depositForBurnWithHook`/`depositForBurn`, and `receiveMessage`. The mint
  recipient is caller-supplied, validated as a non-zero EVM address and
  left-padded to bytes32; never defaulted.
- The provider never signs or sends; transactions go through the existing
  `EVMRouteExecutor` (or the app's wallet) as route steps.
- Fee quotes come from Circle's API at estimate time; a missing or malformed
  quote refuses the route (no silent zero fee).
- No new dependencies; ABI encoding by hand (connect-core has no viem).

## Package entry

`import { CctpBridgeProvider, waitForCctpAttestation } from "@naculus/connect-core/cctp"`
— a separate tsup entry (9.3 KB gzip, bundling the chain registry and
keccak) so the root entry stays within its size budget and apps that do not
bridge never load it. `CCTP_V2` addresses stay in the root constants.

## Live run (2026-10-05)

Sepolia → Base Sepolia, Fast + Forwarding: quote max fee 0.054403 USDC on a
1.0 USDC burn; approve `0x2b9b…de62`, burn `0xa836…f628`; attestation
complete after 11 s; recipient (no Base Sepolia ETH) received 0.945597 native
USDC.

## Decisions to approve

1. **Forwarding Service by default** (user needs no destination gas; costs
   the forward fee, ~0.06 USDC on testnet). Recommended for consumer UX.
2. **Fast Transfer by default** (`1000`), Standard as an option. Recommended.
3. Mainnet enabled only after a live testnet run (Sepolia → Base Sepolia).
