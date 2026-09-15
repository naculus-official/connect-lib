import { describe, expect, it, vi } from "vitest";
import { createProviderFromWalletStandard } from "./discovery";

/**
 * Wallet Standard is the discovery path Solana's own docs point new projects
 * at, and it was the least-covered module in the package (22.4% statements
 * over 19 branches). These cover the adapter contract: required features are
 * enforced up front, optional ones degrade, and a malformed connect result is
 * rejected rather than producing a provider with no usable account.
 */

const ADDR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
// Wallet Standard accounts carry both a base58 address and the raw key bytes.
const ACCOUNT = { address: ADDR, publicKey: new Uint8Array(32).fill(7) };

function makeWallet(over: Record<string, unknown> = {}) {
  return {
    name: "Mock",
    features: {
      "standard:connect": {
        connect: vi.fn(async () => ({ accounts: [ACCOUNT] })),
      },
      "solana:signMessage": { signMessage: vi.fn(async () => ({})) },
      "solana:signTransaction": { signTransaction: vi.fn(async () => ({})) },
      ...over,
    },
  } as never;
}

describe("createProviderFromWalletStandard", () => {
  it("refuses a wallet missing standard:connect", () => {
    const w = makeWallet();
    delete (w as unknown as { features: Record<string, unknown> }).features[
      "standard:connect"
    ];
    expect(() => createProviderFromWalletStandard(w)).toThrow(
      /standard:connect/,
    );
  });

  it("refuses a wallet that declares no solana signing feature at all", () => {
    const w = makeWallet();
    const features = (w as unknown as { features: Record<string, unknown> })
      .features;
    delete features["solana:signMessage"];
    delete features["solana:signTransaction"];
    expect(() => createProviderFromWalletStandard(w)).toThrow(
      /no solana: signing feature/,
    );
  });

  /**
   * A send-only wallet is a legitimate Wallet Standard configuration. It used
   * to be refused here, which removed it from the picker entirely; now it
   * connects and `roles.signer` is what reports the limitation.
   */
  it("accepts a wallet that can only sign-and-send", () => {
    const w = makeWallet({
      "solana:signAndSendTransaction": { signAndSendTransaction: vi.fn() },
    });
    const features = (w as unknown as { features: Record<string, unknown> })
      .features;
    delete features["solana:signMessage"];
    delete features["solana:signTransaction"];
    expect(() => createProviderFromWalletStandard(w)).not.toThrow();
  });

  it("throws at call time for a solana feature the wallet lacks", async () => {
    const w = makeWallet();
    delete (w as unknown as { features: Record<string, unknown> }).features[
      "solana:signTransaction"
    ];
    await expect(
      createProviderFromWalletStandard(w).signTransaction(new Uint8Array(1)),
    ).rejects.toThrow(/solana:signTransaction/);
  });

  it("accepts a wallet with only the required features", () => {
    expect(() => createProviderFromWalletStandard(makeWallet())).not.toThrow();
  });

  it("returns the first account from a Wallet Standard connect result", async () => {
    const provider = createProviderFromWalletStandard(makeWallet());
    const res = await provider.connect();
    expect(String(res.publicKey)).toContain(ADDR);
  });

  it("rejects a connect result with no valid Solana account", async () => {
    const w = makeWallet({
      "standard:connect": { connect: vi.fn(async () => ({ accounts: [] })) },
    });
    await expect(createProviderFromWalletStandard(w).connect()).rejects.toThrow(
      /no valid Solana account/,
    );
  });

  it("rejects an account object without an address", async () => {
    const w = makeWallet({
      "standard:connect": {
        connect: vi.fn(async () => ({ accounts: [{ notAnAddress: 1 }] })),
      },
    });
    await expect(createProviderFromWalletStandard(w).connect()).rejects.toThrow(
      /no valid Solana account/,
    );
  });

  it("passes connect options through to the wallet", async () => {
    const connect = vi.fn(async () => ({ accounts: [ACCOUNT] }));
    const w = makeWallet({ "standard:connect": { connect } });
    await createProviderFromWalletStandard(w).connect({ onlyIfTrusted: true });
    expect(connect).toHaveBeenCalledWith({ onlyIfTrusted: true });
  });
});
