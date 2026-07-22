import type {
  ConnectorSupport,
  SessionNamespace,
  UniversalConnector,
  UniversalWalletSession,
} from "@naculus/connect-core";
import { createEmptySession, WalletError } from "@naculus/connect-core";

export interface PasskeyConfig {
  storageKey?: string;
  relyingParty?: {
    name: string;
    id: string;
  };
  chainId?: string;
}

export interface PasskeyCredential {
  id: string;
  rawId: string;
  publicKey: string;
  address: string;
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

async function sha256(data: BufferSource): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", data);
}

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
      chainId: config.chainId ?? DEFAULT_CHAIN,
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
      this._credential = JSON.parse(raw) as PasskeyCredential;
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

  /** Create a new passkey via WebAuthn and derive an address. */
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
      pkCred.response?.getPublicKey?.() ??
      pkCred.response?.publicKey ??
      new ArrayBuffer(0);
    const { keccak_256 } = await import("@noble/hashes/sha3.js");
    const { bytesToHex } = await import("@noble/hashes/utils.js");
    const hash = keccak_256(new Uint8Array(publicKeyBytes));
    const address = `0x${bytesToHex(hash.slice(-20))}`;

    const passkeyCred: PasskeyCredential = {
      id: credential.id,
      rawId: ab2b64(credential.rawId),
      publicKey: ab2b64(publicKeyBytes),
      address,
      createdAt: Date.now(),
    };

    this.saveCredential(passkeyCred);
    return passkeyCred;
  }

  /** Authenticate with the passkey, returning the assertion signature. */
  async authenticate(
    challenge: BufferSource,
  ): Promise<{ signature: string; authenticatorData: ArrayBuffer }> {
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
            id: new Uint8Array(
              atob(cred.rawId)
                .split("")
                .map((c) => c.charCodeAt(0)),
            ).buffer,
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
    const signature = ab2hex(response.signature);

    return { signature, authenticatorData: response.authenticatorData };
  }

  hasCredential(): boolean {
    return this.loadCredential() !== null;
  }

  getAddress(): string | null {
    const cred = this.loadCredential();
    return cred?.address ?? null;
  }

  // ── UniversalConnector Implementation ───────────────────────────

  async connect(_input?: unknown): Promise<UniversalWalletSession> {
    const existing = this.loadCredential();

    if (!existing) {
      await this.createPasskey();
    }

    const cred = this.loadCredential();
    if (!cred) {
      throw new WalletError(
        "wallet_unavailable",
        "Failed to create passkey wallet",
      );
    }

    const chainId = this.cfg.chainId;
    const address = `${chainId}:${cred.address}`;

    const namespace: SessionNamespace = {
      chains: [chainId],
      accounts: [address],
      methods: ["personal_sign", "eth_signTypedData_v4", "eth_sendTransaction"],
      events: ["chainChanged", "accountsChanged"],
    };

    const session = createEmptySession({
      id: `passkeys-${cred.id}`,
      walletId: this.id,
      walletType: "passkeys",
      namespaces: { eip155: namespace },
      platform:
        typeof window !== "undefined" && "ontouchstart" in window
          ? "mobile-web"
          : "desktop-web",
    });

    return session;
  }

  async reconnect(
    session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    const cred = this.loadCredential();
    if (!cred) {
      throw new WalletError(
        "wallet_unavailable",
        "No passkey credential found for reconnect",
      );
    }
    return session;
  }

  async disconnect(_session: UniversalWalletSession): Promise<void> {
    this.clearCredential();
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    const cred = this.loadCredential();
    if (!cred) return [];
    const chainId = this.cfg.chainId;
    return [`${chainId}:${cred.address}`];
  }

  async signMessage(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    const raw = input as Record<string, unknown>;
    const message = raw.message as string;
    if (!message) {
      throw new WalletError("invalid_input", "Message is required for signing");
    }

    const challenge = await sha256(new TextEncoder().encode(message));
    const { signature } = await this.authenticate(challenge);

    return `0x${signature}`;
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
    this.cfg = { ...this.cfg, chainId };
  }

  async sendCalls(
    _session: UniversalWalletSession,
    _calls: any[],
    _chainId?: string,
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
