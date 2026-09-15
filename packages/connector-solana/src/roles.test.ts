import { describe, expect, it, vi } from "vitest";
import {
  featuresFromLegacyProvider,
  featuresFromWalletStandard,
  requireRole,
  type SolanaWalletFeatures,
  solanaRoles,
} from "./roles";
import type { DiscoveredSolanaWallet, SolanaProvider } from "./types";

const ADDR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const ALL: SolanaWalletFeatures = {
  signMessage: true,
  signTransaction: true,
  signAllTransactions: true,
  signAndSendTransaction: true,
};

function makeWallet(
  features: Partial<SolanaWalletFeatures> = {},
  provider: Partial<SolanaProvider> = {},
): DiscoveredSolanaWallet {
  return {
    id: "mock",
    name: "Mock Wallet",
    icon: "",
    source: "wallet-standard",
    features: { ...ALL, ...features },
    provider: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      signMessage: vi.fn(async () => ({ signature: new Uint8Array([1]) })),
      signTransaction: vi.fn(async () => new Uint8Array([2])),
      signAllTransactions: vi.fn(async () => [new Uint8Array([3])]),
      signAndSendTransaction: vi.fn(async () => ({ signature: "sig" })),
      on: vi.fn(),
      ...provider,
    } as SolanaProvider,
  };
}

describe("featuresFromWalletStandard", () => {
  it("reads the declaration, key by key", () => {
    expect(
      featuresFromWalletStandard({
        "standard:connect": {},
        "solana:signAndSendTransaction": {},
      }),
    ).toEqual({
      signMessage: false,
      signTransaction: false,
      signAllTransactions: false,
      signAndSendTransaction: true,
    });
  });
});

describe("featuresFromLegacyProvider", () => {
  it("treats a missing method as a no", () => {
    const provider = {
      signMessage: () => {},
      signTransaction: () => {},
    } as unknown as SolanaProvider;
    expect(featuresFromLegacyProvider(provider)).toEqual({
      signMessage: true,
      signTransaction: true,
      signAllTransactions: false,
      signAndSendTransaction: false,
    });
  });
});

describe("solanaRoles", () => {
  it("gives a fully capable wallet all three roles", () => {
    const roles = solanaRoles(makeWallet(), ADDR, CHAIN);
    expect(roles.identity).toEqual({ address: ADDR, chain: CHAIN });
    expect(roles.signer?.address).toBe(ADDR);
    expect(roles.payer?.address).toBe(ADDR);
    expect(roles.signer?.signAllTransactions).toBeTypeOf("function");
  });

  /**
   * The case the whole split exists for. A send-only wallet is usable — it
   * can pay — but it will never hand back an unsent signed transaction, and a
   * caller needs that answer before it builds a co-signing flow rather than at
   * the approval prompt.
   */
  it("gives a send-only wallet a payer but no signer", () => {
    const roles = solanaRoles(
      makeWallet({ signTransaction: false, signAllTransactions: false }),
      ADDR,
      CHAIN,
    );
    expect(roles.signer).toBeNull();
    expect(roles.payer).not.toBeNull();
  });

  it("gives a sign-only wallet a signer but no payer", () => {
    const roles = solanaRoles(
      makeWallet({ signAndSendTransaction: false }),
      ADDR,
      CHAIN,
    );
    expect(roles.signer).not.toBeNull();
    expect(roles.payer).toBeNull();
  });

  /** Identity needs no signing at all, so it survives every reduction. */
  it("always gives an identity, even for a wallet that can do nothing else", () => {
    const roles = solanaRoles(
      makeWallet({
        signMessage: false,
        signTransaction: false,
        signAllTransactions: false,
        signAndSendTransaction: false,
      }),
      ADDR,
      CHAIN,
    );
    expect(roles.identity.address).toBe(ADDR);
    expect(roles.signer).toBeNull();
    expect(roles.payer).toBeNull();
  });

  /**
   * Absent rather than throwing, so a caller can choose between one approval
   * and N approvals without first provoking an error.
   */
  it("omits signAllTransactions when the wallet has no batch feature", () => {
    const roles = solanaRoles(
      makeWallet({ signAllTransactions: false }),
      ADDR,
      CHAIN,
    );
    expect(roles.signer?.signAllTransactions).toBeUndefined();
    expect(roles.signer?.signTransaction).toBeTypeOf("function");
  });

  it("omits signMessage when the wallet cannot sign messages", () => {
    const roles = solanaRoles(makeWallet({ signMessage: false }), ADDR, CHAIN);
    expect(roles.signer?.signMessage).toBeUndefined();
  });

  it("unwraps the provider's signature envelopes", async () => {
    const wallet = makeWallet();
    const roles = solanaRoles(wallet, ADDR, CHAIN);
    await expect(
      roles.signer?.signMessage?.(new Uint8Array([9])),
    ).resolves.toEqual(new Uint8Array([1]));
    await expect(
      roles.payer?.signAndSendTransaction(new Uint8Array([9])),
    ).resolves.toBe("sig");
  });

  /**
   * The declaration is authoritative, not the adapter. Every Wallet Standard
   * provider defines `signAndSendTransaction` and throws inside it, so probing
   * the provider would report every wallet as a payer.
   */
  it("believes the declaration over the presence of a provider method", () => {
    const wallet = makeWallet({ signAndSendTransaction: false });
    expect(wallet.provider.signAndSendTransaction).toBeTypeOf("function");
    expect(solanaRoles(wallet, ADDR, CHAIN).payer).toBeNull();
  });
});

describe("requireRole", () => {
  it("returns the role when it exists", () => {
    const roles = solanaRoles(makeWallet(), ADDR, CHAIN);
    expect(requireRole(roles, "signer", "Mock Wallet").address).toBe(ADDR);
  });

  it("names the wallet and the missing feature when it does not", () => {
    const roles = solanaRoles(
      makeWallet({ signTransaction: false }),
      ADDR,
      CHAIN,
    );
    expect(() => requireRole(roles, "signer", "Mock Wallet")).toThrow(
      /Mock Wallet.*solana:signTransaction/s,
    );
  });

  it("reports a missing payer as a send problem, not a signing one", () => {
    const roles = solanaRoles(
      makeWallet({ signAndSendTransaction: false }),
      ADDR,
      CHAIN,
    );
    expect(() => requireRole(roles, "payer", "Mock Wallet")).toThrow(
      /solana:signAndSendTransaction/,
    );
  });
});
