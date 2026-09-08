import type {
  ConnectorSupport,
  SendCallsOptions,
  UniversalConnector,
  UniversalWalletSession,
} from "@naculus/connect-core";
import { WalletError } from "@naculus/connect-core";

export interface PasskeyConfig {
  storageKey?: string;
  relyingParty?: {
    name: string;
    id: string;
  };
  chainId?: string;
}

/**
 * Everything a verifier needs to check a WebAuthn assertion.
 *
 * All four fields are required, not conveniences: the signature covers
 * `authenticatorData ‖ SHA-256(clientDataJSON)`, so a verifier that receives
 * only the first cannot reconstruct what was signed.
 */
/** Decode the base64 form credentials are stored in. */
function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface PasskeyAssertion {
  /** The credential that produced this, base64url as the platform reports it. */
  credentialId: string;
  /** Hex, as returned by the authenticator. For ES256 this is DER, not raw r‖s. */
  signature: string;
  /** Signed as-is. Carries the RP ID hash, the user-verified flag and the counter. */
  authenticatorData: ArrayBuffer;
  /** Hashed into the signature. Contains the challenge, origin and type. */
  clientDataJSON: ArrayBuffer;
  /** Present for a discoverable credential; identifies which account signed. */
  userHandle: ArrayBuffer | null;
}

export interface PasskeyCredential {
  /**
   * Whether the authenticator enabled the PRF extension at creation.
   *
   * Absent on credentials created before PRF was requested; treat absent as
   * false. PRF cannot be added to an existing credential, so this is the
   * signal that unlocking by passkey requires re-registration first.
   */
  prfSupported?: boolean;
  id: string;
  rawId: string;
  publicKey: string;
  createdAt: number;
}

const DEFAULT_STORAGE_KEY = "naculus_passkeys_credential";
const DEFAULT_CHAIN = "eip155:1";
const DEFAULT_RP_NAME = "Naculus Web3 Connect";

const SUPPORT: ConnectorSupport = {
  desktop: true,
  mobile: true,
  deepLink: false,
  qr: false,
  trustedReconnect: true,
};

function ab2hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ab2b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function b642ab(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function getRpId(): string {
  if (typeof window !== "undefined") {
    return window.location.hostname;
  }
  return "localhost";
}

function normalizeEip155ChainId(chainId: string): string {
  if (typeof chainId !== "string" || !/^eip155:[1-9][0-9]*$/.test(chainId)) {
    throw new WalletError(
      "chain_unsupported",
      `Invalid EIP-155 chain ID: ${chainId}`,
    );
  }
  const reference = BigInt(chainId.slice("eip155:".length));
  if (reference <= 0n) {
    throw new WalletError(
      "chain_unsupported",
      `Invalid EIP-155 chain ID: ${chainId}`,
    );
  }
  return `eip155:${reference.toString(10)}`;
}

class PasskeysConnectorImpl implements UniversalConnector {
  readonly id = "passkeys";
  readonly name = "Passkeys";
  readonly kind = "passkeys" as const;
  readonly namespaces = ["eip155"];
  readonly supports = SUPPORT;

  private cfg: Required<PasskeyConfig>;
  private _credential: PasskeyCredential | null = null;

  constructor(config: PasskeyConfig = {}) {
    this.cfg = {
      storageKey: config.storageKey ?? DEFAULT_STORAGE_KEY,
      relyingParty: config.relyingParty ?? {
        name: DEFAULT_RP_NAME,
        id: getRpId(),
      },
      chainId: normalizeEip155ChainId(config.chainId ?? DEFAULT_CHAIN),
    };
  }

  private getStorage(): Storage | null {
    if (typeof localStorage !== "undefined") return localStorage;
    return null;
  }

  private saveCredential(cred: PasskeyCredential): void {
    this._credential = cred;
    const storage = this.getStorage();
    if (storage) {
      storage.setItem(this.cfg.storageKey, JSON.stringify(cred));
    }
  }

  private loadCredential(): PasskeyCredential | null {
    if (this._credential) return this._credential;
    const storage = this.getStorage();
    if (!storage) return null;
    const raw = storage.getItem(this.cfg.storageKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PasskeyCredential>;
      if (
        typeof parsed.id !== "string" ||
        typeof parsed.rawId !== "string" ||
        typeof parsed.publicKey !== "string" ||
        typeof parsed.createdAt !== "number" ||
        !Number.isFinite(parsed.createdAt)
      ) {
        return null;
      }
      // Drop legacy records that included a locally-derived EVM address. A
      // WebAuthn key is not a secp256k1 EOA and must not be presented as one.
      this._credential = {
        id: parsed.id,
        rawId: parsed.rawId,
        publicKey: parsed.publicKey,
        createdAt: parsed.createdAt,
        // Carried through, not rebuilt from scratch. Dropping it would make
        // every reload forget that this credential has no PRF, so unlocking
        // would prompt the user for a derivation that cannot succeed.
        ...(typeof parsed.prfSupported === "boolean"
          ? { prfSupported: parsed.prfSupported }
          : {}),
      };
      return this._credential;
    } catch {
      return null;
    }
  }

  private clearCredential(): void {
    this._credential = null;
    const storage = this.getStorage();
    if (storage) {
      storage.removeItem(this.cfg.storageKey);
    }
  }

  /** Create and persist a WebAuthn credential for a future smart-account. */
  async createPasskey(): Promise<PasskeyCredential> {
    if (typeof navigator === "undefined" || !navigator.credentials) {
      throw new WalletError(
        "wallet_unavailable",
        "WebAuthn not available in this environment",
      );
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const createOpts: CredentialCreationOptions = {
      publicKey: {
        challenge,
        rp: {
          name: this.cfg.relyingParty.name,
          id: this.cfg.relyingParty.id,
        },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: `user-${Date.now()}`,
          displayName: "Web3 Passkey",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "required",
          userVerification: "required",
        },
        // PRF has to be asked for at creation. An authenticator will not add
        // it to an existing credential, so a passkey registered without this
        // can never produce a wrapping key — the user has to register a new
        // one. Requesting it costs nothing where it is unsupported: the
        // extension is simply absent from the results.
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
        timeout: 60_000,
      },
    };

    const credential = (await navigator.credentials.create(
      createOpts,
    )) as PublicKeyCredential;

    if (!credential) {
      throw new WalletError(
        "wallet_unavailable",
        "Passkey creation was cancelled",
      );
    }

    const pkCred = credential as any;
    const publicKeyBytes =
      pkCred.response?.getPublicKey?.() ?? pkCred.response?.publicKey ?? null;
    if (
      !(publicKeyBytes instanceof ArrayBuffer) ||
      publicKeyBytes.byteLength === 0
    ) {
      throw new WalletError(
        "wallet_unavailable",
        "WebAuthn public key unavailable; cannot persist passkey credential",
      );
    }

    // Recorded at creation because it cannot be added later. A credential
    // without it needs re-registration before it can unlock anything, and a
    // caller needs to know that before it tries.
    //
    // Left undefined when the platform cannot report extension results at all,
    // which is a different fact from the authenticator declining PRF: the
    // first is worth retrying, the second is not.
    const readExtensions = (
      credential as PublicKeyCredential & {
        getClientExtensionResults?: () => { prf?: { enabled?: boolean } };
      }
    ).getClientExtensionResults;
    const prfSupported =
      typeof readExtensions === "function"
        ? readExtensions.call(credential)?.prf?.enabled === true
        : undefined;

    const passkeyCred: PasskeyCredential = {
      id: credential.id,
      rawId: ab2b64(credential.rawId),
      publicKey: ab2b64(publicKeyBytes),
      createdAt: Date.now(),
      ...(prfSupported === undefined ? {} : { prfSupported }),
    };

    this.saveCredential(passkeyCred);
    return passkeyCred;
  }

  /**
   * Authenticate with the passkey, returning everything a verifier needs.
   *
   * A WebAuthn signature covers `authenticatorData ‖ SHA-256(clientDataJSON)`.
   * This used to return the signature and `authenticatorData` only, which made
   * it unverifiable by anyone: without `clientDataJSON` a verifier cannot
   * rebuild the signed bytes, cannot check that the challenge it issued is the
   * one that was signed, and cannot check the origin. Those three are the
   * whole of WebAuthn's replay and phishing protection.
   *
   * `userHandle` is included because a discoverable credential identifies the
   * account by it, and a verifier that trusts the credential ID alone accepts
   * a signature from whatever credential the client chose to present.
   */
  async authenticate(challenge: BufferSource): Promise<PasskeyAssertion> {
    const cred = this.loadCredential();
    if (!cred) {
      throw new WalletError(
        "wallet_unavailable",
        "No passkey found. Create one first.",
      );
    }

    const getOpts: CredentialRequestOptions = {
      publicKey: {
        challenge,
        allowCredentials: [
          {
            id: b64ToBytes(cred.rawId).buffer as ArrayBuffer,
            type: "public-key",
          },
        ],
        userVerification: "required",
        timeout: 60_000,
      },
    };

    const assertion = (await navigator.credentials.get(
      getOpts,
    )) as PublicKeyCredential;

    if (!assertion) {
      throw new WalletError(
        "wallet_unavailable",
        "Passkey authentication was cancelled",
      );
    }

    const response = assertion.response as AuthenticatorAssertionResponse;

    return {
      credentialId: assertion.id,
      signature: ab2hex(response.signature),
      authenticatorData: response.authenticatorData,
      clientDataJSON: response.clientDataJSON,
      userHandle: response.userHandle ?? null,
    };
  }

  /**
   * Derive a wrapping key from the authenticator, via the WebAuthn PRF
   * extension.
   *
   * This is what raises the bar on stored key material. Today decryption needs
   * only JavaScript running on this origin; with PRF it needs the user's
   * authenticator — a fingerprint or face, not a script.
   *
   * Three things a caller must handle rather than assume:
   *
   * - **Not universally supported.** Firefox lags, and older credentials were
   *   created without the extension. Returning null rather than throwing lets
   *   a caller fall back to the existing passphrase path instead of locking
   *   the user out of their own wallet.
   * - **Device-bound.** The output belongs to this authenticator. A new device
   *   yields a different key, so the recovery phrase remains the only backup
   *   that survives losing the device. PRF protects the local copy, not the
   *   wallet.
   * - **Salt must be stable and stored.** The same salt yields the same key;
   *   a different one yields a different key and the ciphertext will not open.
   *
   * Returns 32 bytes suitable as HKDF input, or null when unavailable.
   */
  async derivePrfKey(salt: Uint8Array): Promise<Uint8Array | null> {
    const cred = this.loadCredential();
    if (!cred) {
      throw new WalletError(
        "wallet_unavailable",
        "No passkey found. Create one first.",
      );
    }
    if (cred.prfSupported === false) {
      // Known not to work. Saying so beats a prompt the user answers for
      // nothing.
      return null;
    }
    if (typeof navigator === "undefined" || !navigator.credentials) {
      return null;
    }

    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          {
            id: b64ToBytes(cred.rawId).buffer as ArrayBuffer,
            type: "public-key",
          },
        ],
        userVerification: "required",
        extensions: {
          prf: { eval: { first: salt } },
        } as AuthenticationExtensionsClientInputs,
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;

    if (!assertion) return null;

    const read = (
      assertion as PublicKeyCredential & {
        getClientExtensionResults?: () => {
          prf?: { results?: { first?: ArrayBuffer } };
        };
      }
    ).getClientExtensionResults;
    if (typeof read !== "function") return null;
    const first = read.call(assertion)?.prf?.results?.first;
    if (!first || first.byteLength === 0) return null;
    return new Uint8Array(first);
  }

  hasCredential(): boolean {
    return this.loadCredential() !== null;
  }

  getAddress(): string | null {
    // A WebAuthn public key is P-256/EdDSA material, not an EIP-155
    // secp256k1 EOA key. An address requires a deployed smart-account factory.
    return null;
  }

  // ── UniversalConnector Implementation ───────────────────────────

  async connect(_input?: unknown): Promise<UniversalWalletSession> {
    throw new WalletError(
      "method_unsupported",
      "Passkeys require an ERC-4337 smart-account deployment; this connector does not derive or invent an EVM address",
    );
  }

  async reconnect(
    session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    void session;
    throw new WalletError(
      "method_unsupported",
      "Passkeys cannot reconnect as an EVM wallet until an ERC-4337 smart-account is configured",
    );
  }

  async disconnect(_session: UniversalWalletSession): Promise<void> {
    this.clearCredential();
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    void session;
    return [];
  }

  async signMessage(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    throw new WalletError(
      "method_unsupported",
      "WebAuthn assertions are not EIP-191 message signatures. Connect a passkey smart-account connector to sign EVM messages.",
    );
  }

  async signTransaction(
    session: UniversalWalletSession,
    _input: unknown,
  ): Promise<unknown> {
    throw new WalletError(
      "method_unsupported",
      "signTransaction not supported via Passkeys",
    );
  }

  async sendTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    throw new WalletError(
      "method_unsupported",
      "sendTransaction not supported via Passkeys",
    );
  }

  async switchChain(
    session: UniversalWalletSession,
    chainId: string,
  ): Promise<void> {
    this.cfg = { ...this.cfg, chainId: normalizeEip155ChainId(chainId) };
  }

  async sendCalls(
    _session: UniversalWalletSession,
    _calls: any[],
    _chainId?: string,
    _options?: SendCallsOptions,
  ): Promise<string> {
    throw new WalletError(
      "method_unsupported",
      "sendCalls not supported via Passkeys",
    );
  }

  async getCapabilities(
    _session: UniversalWalletSession,
  ): Promise<Record<string, any>> {
    return {};
  }

  async getCallsStatus(
    _session: import("@naculus/connect-core").UniversalWalletSession,
    _bundleHash: string,
  ): Promise<import("@naculus/connect-core").CallsStatus> {
    throw new WalletError(
      "method_unsupported",
      "getCallsStatus not supported via Passkeys",
    );
  }
}

export function createPasskeysConnector(
  config?: PasskeyConfig,
): PasskeysConnectorImpl {
  return new PasskeysConnectorImpl(config);
}

export default PasskeysConnectorImpl;

/**
 * Anything that can evaluate WebAuthn PRF for a salt.
 *
 * Declared structurally rather than imported from `@naculus/wallet-engine`,
 * which sits below this package: the shape is two lines, and matching it costs
 * less than a dependency pointing the wrong way down the stack.
 */
export interface PasskeyUnlockProvider {
  derive(salt: Uint8Array): Promise<Uint8Array | null>;
}

/**
 * Adapt a passkeys connector into the unlock provider `PocketWallet` accepts.
 *
 * ```ts
 * const passkeys = createPasskeysConnector();
 * const wallet = new PocketWallet({
 *   encryptionPassphrase: async () => await askUser(),
 *   prfUnlock: createPasskeyUnlockProvider(passkeys),
 * });
 * ```
 *
 * The salt is chosen and stored by the wallet, inside that wallet's own
 * record. One credential can therefore protect several wallets independently:
 * each has its own salt, so the key that opens one does not open another.
 *
 * Returns null instead of throwing when no credential exists yet. A wallet
 * being configured for passkey unlock before the user has registered one is an
 * ordinary state, not an error, and the passphrase wrap still opens the record.
 */
export function createPasskeyUnlockProvider(
  connector: Pick<PasskeysConnectorImpl, "derivePrfKey" | "hasCredential">,
): PasskeyUnlockProvider {
  return {
    async derive(salt: Uint8Array): Promise<Uint8Array | null> {
      if (!connector.hasCredential()) return null;
      return connector.derivePrfKey(salt);
    },
  };
}

export type { VerifyOptions } from "./verify";
export { verifyPasskeyAssertion } from "./verify";
