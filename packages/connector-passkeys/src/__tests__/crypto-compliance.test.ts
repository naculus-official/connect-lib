import { describe, expect, it } from "vitest";
import { createPasskeysConnector } from "../index";

describe("Passkeys crypto boundary", () => {
  it("does not expose a fabricated EVM address", () => {
    const connector = createPasskeysConnector();

    // WebAuthn credentials are not secp256k1 EOAs. An EVM address can only be
    // exposed after a real ERC-4337 smart-account deployment is configured.
    expect(connector.getAddress()).toBeNull();
  });

  it("fails closed until a smart-account implementation is configured", async () => {
    const connector = createPasskeysConnector();

    await expect(connector.connect()).rejects.toMatchObject({
      code: "method_unsupported",
    });
  });
});
