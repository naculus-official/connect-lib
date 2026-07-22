import { describe, expect, it } from "vitest";
import { isWalletError, WalletError } from "./errors";

describe("WalletError", () => {
  it("should create error with code and message", () => {
    const error = new WalletError("wallet_unavailable", "Wallet not found");

    expect(error.code).toBe("wallet_unavailable");
    expect(error.message).toBe("Wallet not found");
    expect(error.name).toBe("WalletError");
  });

  it("should use code as default message", () => {
    const error = new WalletError("user_rejected");

    expect(error.code).toBe("user_rejected");
    expect(error.message).toBe("user_rejected");
  });

  it("should store details", () => {
    const details = { originalError: new Error("Original") };
    const error = new WalletError("tx_failed", "Transaction failed", details);

    expect(error.details).toBe(details);
  });
});

describe("isWalletError", () => {
  it("should return true for WalletError with matching code", () => {
    const error = new WalletError("session_expired");
    expect(isWalletError(error, "session_expired")).toBe(true);
  });

  it("should return true for any WalletError when code not specified", () => {
    const error = new WalletError("wallet_unavailable");
    expect(isWalletError(error)).toBe(true);
  });

  it("should return false for non-matching code", () => {
    const error = new WalletError("wallet_unavailable");
    expect(isWalletError(error, "session_expired")).toBe(false);
  });

  it("should return false for non-WalletError objects", () => {
    expect(isWalletError(new Error("Regular error"))).toBe(false);
    expect(isWalletError({ code: "test" })).toBe(false);
    expect(isWalletError(null)).toBe(false);
    expect(isWalletError(undefined)).toBe(false);
  });
});
