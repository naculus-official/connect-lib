/// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasskeysConnector, createPasskeyUnlockProvider } from "./index";

/**
 * WebAuthn PRF, the extension that lets an authenticator produce a wrapping
 * key for stored wallet material.
 *
 * The properties worth pinning are all about refusing to lock a user out.
 * PRF is not universally supported, it cannot be added to a credential after
 * creation, and it is bound to the device — so every unsupported path has to
 * return null for a caller to fall back on, never throw and never hang.
 */

const CREDENTIAL = {
  id: "cred-1",
  rawId: btoa("raw-id-bytes"),
  publicKey: btoa("public-key-bytes"),
  createdAt: Date.now(),
};

function withStoredCredential(extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    "naculus_passkeys_credential",
    JSON.stringify({ ...CREDENTIAL, ...extra }),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("createPasskey requests PRF", () => {
  it("asks for the extension, because it cannot be added later", async () => {
    let seen: CredentialCreationOptions | undefined;
    vi.stubGlobal("navigator", {
      credentials: {
        create: vi.fn(async (opts: CredentialCreationOptions) => {
          seen = opts;
          return {
            id: "c",
            rawId: new Uint8Array(8).buffer,
            response: { getPublicKey: () => new Uint8Array(65).buffer },
            getClientExtensionResults: () => ({ prf: { enabled: true } }),
          };
        }),
      },
    });

    const connector = createPasskeysConnector();
    const cred = await connector.createPasskey();

    const ext = (seen?.publicKey as PublicKeyCredentialCreationOptions)
      ?.extensions as { prf?: unknown } | undefined;
    expect(ext?.prf).toBeDefined();
    expect(cred.prfSupported).toBe(true);
  });

  it("records that the authenticator declined", async () => {
    vi.stubGlobal("navigator", {
      credentials: {
        create: vi.fn(async () => ({
          id: "c",
          rawId: new Uint8Array(8).buffer,
          response: { getPublicKey: () => new Uint8Array(65).buffer },
          getClientExtensionResults: () => ({}),
        })),
      },
    });
    const cred = await createPasskeysConnector().createPasskey();
    expect(cred.prfSupported).toBe(false);
  });

  it("leaves support unknown when the platform cannot report it", async () => {
    // Different from declining: one is worth retrying on a newer browser, the
    // other is settled. Recording false for both would lose that.
    vi.stubGlobal("navigator", {
      credentials: {
        create: vi.fn(async () => ({
          id: "c",
          rawId: new Uint8Array(8).buffer,
          response: { getPublicKey: () => new Uint8Array(65).buffer },
        })),
      },
    });
    const cred = await createPasskeysConnector().createPasskey();
    expect(cred.prfSupported).toBeUndefined();
  });
});

describe("derivePrfKey", () => {
  const salt = new Uint8Array(32).fill(3);

  it("returns the authenticator's output", async () => {
    withStoredCredential({ prfSupported: true });
    let seen: CredentialRequestOptions | undefined;
    vi.stubGlobal("navigator", {
      credentials: {
        get: vi.fn(async (opts: CredentialRequestOptions) => {
          seen = opts;
          return {
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(9).buffer } },
            }),
          };
        }),
      },
    });

    const key = await createPasskeysConnector().derivePrfKey(salt);
    expect(key).toHaveLength(32);
    expect(key?.every((b) => b === 9)).toBe(true);

    const ext = (seen?.publicKey as PublicKeyCredentialRequestOptions)
      ?.extensions as { prf?: { eval?: { first?: Uint8Array } } };
    expect(ext?.prf?.eval?.first).toBe(salt);
  });

  it("returns null without prompting when the credential has no PRF", async () => {
    // Known not to work. A prompt the user answers for nothing is worse than
    // an immediate fallback.
    withStoredCredential({ prfSupported: false });
    const get = vi.fn();
    vi.stubGlobal("navigator", { credentials: { get } });

    expect(await createPasskeysConnector().derivePrfKey(salt)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns null when the platform reports no extension results", async () => {
    withStoredCredential({ prfSupported: true });
    vi.stubGlobal("navigator", {
      credentials: { get: vi.fn(async () => ({})) },
    });
    expect(await createPasskeysConnector().derivePrfKey(salt)).toBeNull();
  });

  it("returns null when the user cancels", async () => {
    withStoredCredential({ prfSupported: true });
    vi.stubGlobal("navigator", {
      credentials: { get: vi.fn(async () => null) },
    });
    expect(await createPasskeysConnector().derivePrfKey(salt)).toBeNull();
  });

  it("returns null when WebAuthn is absent entirely", async () => {
    withStoredCredential({ prfSupported: true });
    vi.stubGlobal("navigator", {});
    expect(await createPasskeysConnector().derivePrfKey(salt)).toBeNull();
  });

  it("refuses when there is no credential at all", async () => {
    // A missing credential is a caller error, not a capability gap, so this
    // one throws rather than falling back silently.
    vi.stubGlobal("navigator", { credentials: { get: vi.fn() } });
    await expect(createPasskeysConnector().derivePrfKey(salt)).rejects.toThrow(
      /No passkey found/,
    );
  });

  it("requires user verification for the derivation", async () => {
    withStoredCredential({ prfSupported: true });
    let seen: CredentialRequestOptions | undefined;
    vi.stubGlobal("navigator", {
      credentials: {
        get: vi.fn(async (opts: CredentialRequestOptions) => {
          seen = opts;
          return {
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).buffer } },
            }),
          };
        }),
      },
    });
    await createPasskeysConnector().derivePrfKey(salt);
    if (!seen?.publicKey) throw new Error("navigator.credentials.get was not called");
    expect(
      (seen.publicKey as PublicKeyCredentialRequestOptions).userVerification,
    ).toBe("required");
  });
});

describe("createPasskeyUnlockProvider", () => {
  it("returns null before a credential exists instead of throwing", async () => {
    const connector = createPasskeysConnector();
    const provider = createPasskeyUnlockProvider(connector);
    // A wallet configured for passkey unlock before the user has registered
    // one is an ordinary state. Throwing here would make the passphrase wrap
    // unreachable and the wallet impossible to open.
    await expect(provider.derive(new Uint8Array(32))).resolves.toBeNull();
  });

  it("passes the salt through to the authenticator unchanged", async () => {
    withStoredCredential({ prfSupported: true });
    const salt = new Uint8Array(32).fill(7);
    let seenSalt: unknown;
    vi.stubGlobal("navigator", {
      credentials: {
        get: vi.fn(async (opts: CredentialRequestOptions) => {
          seenSalt = (
            opts.publicKey?.extensions as {
              prf?: { eval?: { first?: unknown } };
            }
          )?.prf?.eval?.first;
          return {
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(9).buffer } },
            }),
          };
        }),
      },
    });

    const provider = createPasskeyUnlockProvider(createPasskeysConnector());
    const out = await provider.derive(salt);
    expect(seenSalt).toBe(salt);
    expect(out).toEqual(new Uint8Array(32).fill(9));
  });

  it("returns null for a credential registered without PRF", async () => {
    withStoredCredential({ prfSupported: false });
    const provider = createPasskeyUnlockProvider(createPasskeysConnector());
    await expect(provider.derive(new Uint8Array(32))).resolves.toBeNull();
  });
});
