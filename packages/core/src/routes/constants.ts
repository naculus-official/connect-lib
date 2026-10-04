// Circle CCTP V2 constants; only the @naculus/connect-core/cctp entry imports them.
/**
 * Circle CCTP V2 (burn-and-mint native USDC). Sources, fetched 2026-10-05:
 * - addresses: https://developers.circle.com/cctp/references/contract-addresses.md
 * - domains: https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md
 * - forwarding hook: https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service.md
 * Design: docs/design/cctp-bridge.md.
 */
export const CCTP_V2 = {
  tokenMessenger: {
    mainnet: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    testnet: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  },
  messageTransmitter: {
    mainnet: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    testnet: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  },
  irisApi: {
    mainnet: "https://iris-api.circle.com",
    testnet: "https://iris-api-sandbox.circle.com",
  },
  /** EVM chain ID → CCTP domain. */
  domains: {
    1: 0,
    11155111: 0,
    10: 2,
    11155420: 2,
    42161: 3,
    421614: 3,
    8453: 6,
    84532: 6,
    137: 7,
  } as Readonly<Record<number, number>>,
  testnetChainIds: [11155111, 11155420, 421614, 84532] as readonly number[],
  /** "Source (Fast transfer): N/A" in Circle's table. */
  fastSourceUnsupported: [137] as readonly number[],
  /** Static Forwarding Service hook: "cctp-forward", version 0, length 0. */
  forwardHookData:
    "0x636374702d666f72776172640000000000000000000000000000000000000000",
  finality: { fast: 1000, standard: 2000 },
} as const;
