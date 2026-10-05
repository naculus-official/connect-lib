import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../storage";
import { createSessionKeyError, SESSION_KEY_ERROR_MESSAGES } from "./errors";
import { SessionKeyManager } from "./SessionKeyManager";

describe("createSessionKeyError", () => {
  it("appends cleaned string details while preserving the code and details", () => {
    const details = "signerAddress must be a non-zero EVM address";
    const error = createSessionKeyError("session_key_invalid_input", details);

    expect(error.message).toBe(
      "Session key signing input is invalid. signerAddress must be a non-zero EVM address.",
    );
    expect(error.code).toBe("session_key_invalid_input");
    expect(error.details).toBe(details);
  });

  it("does not duplicate terminal punctuation", () => {
    const error = createSessionKeyError(
      "session_key_invalid_input",
      "Signer address is invalid!",
    );

    expect(error.message).toBe(
      "Session key signing input is invalid. Signer address is invalid!",
    );
  });

  it("leaves the message unchanged for object or missing details", () => {
    const thrownValue = new Error("storage failure");
    const withObject = createSessionKeyError(
      "session_key_storage_unavailable",
      thrownValue,
    );
    const withoutDetails = createSessionKeyError("session_key_expired");

    expect(withObject.message).toBe(
      SESSION_KEY_ERROR_MESSAGES.session_key_storage_unavailable,
    );
    expect(withObject.details).toBe(thrownValue);
    expect(withoutDetails.message).toBe(
      SESSION_KEY_ERROR_MESSAGES.session_key_expired,
    );
    expect(withoutDetails.details).toBeUndefined();
  });

  it("neutralizes controls and collapses whitespace without changing details", () => {
    const details = "bad\n\tvalue\u0000from\u0085caller\u2028now";
    const error = createSessionKeyError("session_key_invalid_input", details);

    expect(error.message).toBe(
      "Session key signing input is invalid. bad value from caller now.",
    );
    expect(error.details).toBe(details);
  });

  it("replaces bidi controls in the message without changing details", () => {
    const details = "abc\u202Edef\u2066ghi";
    const error = createSessionKeyError("session_key_invalid_input", details);

    expect(error.message).toBe(
      "Session key signing input is invalid. abc def ghi.",
    );
    expect(error.details).toBe(details);
  });

  it("caps display details at 200 code points plus an ellipsis", () => {
    const details = "😀".repeat(10_000);
    const error = createSessionKeyError("session_key_not_found", details);
    const displayDetail = error.message.slice(
      SESSION_KEY_ERROR_MESSAGES.session_key_not_found.length + 1,
    );

    expect(Array.from(displayDetail)).toHaveLength(201);
    expect(displayDetail).toBe(`${"😀".repeat(200)}…`);
    expect(error.details).toBe(details);
  });

  it("surfaces a reason from SessionKeyManager validation", () => {
    expect(
      () =>
        new SessionKeyManager(
          { defaultExpiryMs: 2, maxExpiryMs: 1 },
          new MemoryStorageAdapter(),
        ),
    ).toThrow(
      "Session key signing input is invalid. defaultExpiryMs and maxExpiryMs must be positive safe integers, and defaultExpiryMs cannot exceed maxExpiryMs.",
    );
  });
});
