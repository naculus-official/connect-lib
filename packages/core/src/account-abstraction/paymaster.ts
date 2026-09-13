/**
 * Paymaster Integration for ERC-4337
 *
 * Provides Paymaster abstractions for gas sponsorship:
 * - Paymaster interface (pluggable)
 * - VerifyingPaymaster: API-based sponsorship via paymaster RPC
 * - PaymasterService: orchestrator for paymaster data injection
 *
 * @see docs/features/account-abstraction.md
 */

import { AccountAbstractionError } from "./errors";
import type {
  Address,
  Hex,
  PaymasterConfig,
  PaymasterData,
  Paymaster as PaymasterInterface,
  PaymasterRequestOptions,
  PaymasterType,
  UserOperation,
  UserOperationVersion,
} from "./types";
import { serializeUserOperationForRpc } from "./user-operation";

export interface PaymasterStubData extends PaymasterData {
  /** When true, ERC-7677 permits skipping pm_getPaymasterData. */
  isFinal: boolean;
}

// ─── Paymaster Service ─────────────────────────────────────────────────

export interface PaymasterServiceConfig {
  /** Paymaster RPC URL */
  url: string;
  /** Paymaster type */
  type: PaymasterType;
  /** Optional policy configuration */
  policy?: {
    allowedDapps?: string[];
    token?: Address;
    maxGasPerUserOp?: bigint;
  };
  /** Optional API key for authenticated paymaster */
  apiKey?: string;
}

/**
 * PaymasterService manages Paymaster interactions for ERC-4337 UserOperations.
 *
 * Supports:
 * - Verifying paymaster (API-based sponsorship approval)
 * - Sponsor paymaster (free gas for whitelisted dApps)
 * - Custom paymaster implementations
 */
export class PaymasterService implements PaymasterInterface {
  private config: PaymasterServiceConfig;
  private _sponsorInfo: string | null = null;

  constructor(config: PaymasterServiceConfig) {
    this.config = config;
  }

  /**
   * Get paymaster data for a UserOperation.
   *
   * For verifying paymasters, this calls the paymaster RPC's
   * pm_sponsorUserOperation method.
   *
   * @param userOp - The UserOperation to sponsor
   * @returns Paymaster data including paymasterAndData hex
   */
  async getPaymasterData(
    userOp: Partial<UserOperation>,
    request?: PaymasterRequestOptions,
  ): Promise<PaymasterData> {
    if (request) return this.getStandardPaymasterData(userOp, request);
    switch (this.config.type) {
      case "verifying":
        return this.getVerifyingPaymasterData(userOp);
      case "sponsor":
        return this.getSponsorPaymasterData(userOp);
      case "token":
        return this.getTokenPaymasterData(userOp);
      case "custom":
        return this.getCustomPaymasterData(userOp);
      default:
        throw new AccountAbstractionError(
          "aa_paymaster_rejected",
          `Unknown paymaster type: ${this.config.type}`,
        );
    }
  }

  /** Obtain ERC-7677 stub fields before bundler gas estimation. */
  async getPaymasterStubData(
    userOp: Partial<UserOperation>,
    request: PaymasterRequestOptions,
  ): Promise<PaymasterStubData> {
    const version = request.version ?? "0.7";
    const result = parsePaymasterResult(
      await this.postRpc(
        "pm_getPaymasterStubData",
        this.standardParams(userOp, request),
      ),
    );
    this._sponsorInfo = result.sponsor?.name ?? "Sponsored by Paymaster";
    return packStandardPaymasterResult(result, version, this._sponsorInfo, true);
  }

  /** Obtain final ERC-7677 fields after bundler gas estimation. */
  async getPaymasterFinalData(
    userOp: Partial<UserOperation>,
    request: PaymasterRequestOptions,
    stub: PaymasterStubData,
    estimatedVerificationGas?: bigint,
  ): Promise<PaymasterData> {
    const estimatedStub =
      estimatedVerificationGas === undefined ||
      (request.version ?? "0.7") === "0.6"
        ? stub
        : replacePaymasterVerificationGas(stub, estimatedVerificationGas);
    if (estimatedStub.isFinal) return estimatedStub;
    const version = request.version ?? "0.7";
    const result = parsePaymasterResult(
      await this.postRpc(
        "pm_getPaymasterData",
        this.standardParams(
          { ...userOp, paymasterAndData: estimatedStub.paymasterAndData },
          request,
        ),
      ),
    );
    return packStandardPaymasterResult(
      result,
      version,
      result.sponsor?.name ?? stub.sponsorInfo ?? "Sponsored by Paymaster",
      false,
      estimatedStub,
    );
  }

  /**
   * Check if a UserOperation is eligible for sponsorship.
   *
   * @param userOp - The UserOperation to check
   * @returns true if the paymaster would sponsor this operation
   */
  async isSponsored(userOp: Partial<UserOperation>): Promise<boolean> {
    try {
      const data = await this.getPaymasterData(userOp);
      return data.paymasterAndData !== "0x" && data.paymasterAndData.length > 2;
    } catch {
      return false;
    }
  }

  /**
   * Get human-readable sponsorship info.
   */
  get sponsorInfo(): string | null {
    return this._sponsorInfo;
  }

  // ── Verifying Paymaster ─────────────────────────────────────────

  /**
   * Get paymaster data using a verifying paymaster.
   * Calls the paymaster RPC's pm_sponsorUserOperation method.
   */
  private async getVerifyingPaymasterData(
    userOp: Partial<UserOperation>,
  ): Promise<PaymasterData> {
    const serializedOp = this.serializeForPaymaster(userOp);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "pm_sponsorUserOperation",
          params: [serializedOp],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new AccountAbstractionError(
          "aa_paymaster_rejected",
          `Paymaster returned status ${response.status}`,
        );
      }

      const json = (await response.json()) as {
        result?: {
          paymasterAndData?: Hex;
          sponsor?: { name?: string };
        };
        error?: { code: number; message: string };
      };

      if (json.error) {
        throw new AccountAbstractionError(
          "aa_paymaster_rejected",
          `Paymaster error: ${json.error.message}`,
          { code: json.error.code },
        );
      }

      const result = json.result;
      if (!result?.paymasterAndData || result.paymasterAndData === "0x") {
        throw new AccountAbstractionError(
          "aa_paymaster_rejected",
          "Paymaster did not return paymasterAndData",
        );
      }

      this._sponsorInfo = result.sponsor?.name ?? "Sponsored by Paymaster";

      return {
        paymasterAndData: result.paymasterAndData,
        sponsorInfo: this._sponsorInfo,
      };
    } catch (error) {
      if (error instanceof AccountAbstractionError) throw error;
      throw new AccountAbstractionError(
        "aa_paymaster_rejected",
        "Failed to get paymaster data",
        error,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Sponsor Paymaster ───────────────────────────────────────────

  /**
   * Get paymaster data for a simple sponsor paymaster.
   * Uses a static or policy-based sponsorship.
   */
  private async getSponsorPaymasterData(
    userOp: Partial<UserOperation>,
  ): Promise<PaymasterData> {
    const serializedOp = this.serializeForPaymaster(userOp);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "pm_getPaymasterStakeData",
          params: [serializedOp],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new AccountAbstractionError(
          "aa_paymaster_rejected",
          `Sponsor paymaster returned status ${response.status}`,
        );
      }

      const json = (await response.json()) as {
        result?: { paymasterAndData: Hex };
        error?: { code: number; message: string };
      };

      if (json.error || !json.result) {
        // If sponsor paymaster fails, try verifying endpoint
        return this.getVerifyingPaymasterData(userOp);
      }

      this._sponsorInfo = "Gas sponsored by dApp";
      return {
        paymasterAndData: json.result.paymasterAndData,
        sponsorInfo: this._sponsorInfo,
      };
    } catch (error) {
      throw new AccountAbstractionError(
        "aa_paymaster_rejected",
        "Sponsor paymaster failed",
        error,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Token Paymaster ─────────────────────────────────────────────

  /**
   * Get paymaster data for a token paymaster.
   * Requires an ERC-20 token for gas payment.
   */
  private async getTokenPaymasterData(
    userOp: Partial<UserOperation>,
  ): Promise<PaymasterData> {
    // Token paymaster implementations vary.
    // This calls the standard pm_sponsorUserOperation with token info.
    const serializedOp = this.serializeForPaymaster(userOp);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    // If a specific token is configured, pass it as an extra param
    const extraParams: Record<string, unknown> = {};
    if (this.config.policy?.token) {
      extraParams.token = this.config.policy.token;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "pm_sponsorUserOperation",
          params: [serializedOp, this.config.policy?.token],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new AccountAbstractionError(
          "aa_paymaster_rejected",
          `Token paymaster returned status ${response.status}`,
        );
      }

      const json = (await response.json()) as {
        result?: { paymasterAndData: Hex };
        error?: { code: number; message: string };
      };

      if (json.error) {
        throw new AccountAbstractionError(
          "aa_paymaster_rejected",
          `Token paymaster error: ${json.error.message}`,
        );
      }

      this._sponsorInfo = this.config.policy?.token
        ? `Gas paid with ERC-20 token`
        : "Gas sponsored";

      return {
        paymasterAndData: json.result?.paymasterAndData ?? "0x",
        sponsorInfo: this._sponsorInfo,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Custom Paymaster ────────────────────────────────────────────

  /**
   * Get paymaster data using a custom paymaster implementation.
   * Delegates to the configured URL which should implement the paymaster RPC.
   */
  private async getCustomPaymasterData(
    userOp: Partial<UserOperation>,
  ): Promise<PaymasterData> {
    // Custom paymasters follow the same RPC pattern by default
    return this.getVerifyingPaymasterData(userOp);
  }

  /**
   * ERC-7677 paymaster flow. The stub call is required for v0.7 because the
   * paymaster supplies the verification and post-op gas limits that are
   * packed into `paymasterAndData`.
   */
  private async getStandardPaymasterData(
    userOp: Partial<UserOperation>,
    request: PaymasterRequestOptions,
  ): Promise<PaymasterData> {
    const stub = await this.getPaymasterStubData(userOp, request);
    return this.getPaymasterFinalData(userOp, request, stub);
  }

  private standardParams(
    userOp: Partial<UserOperation>,
    request: PaymasterRequestOptions,
  ): unknown[] {
    return [
      this.serializeForPaymaster(userOp, request.version ?? "0.7"),
      request.entryPoint,
      toQuantity(request.chainId),
      request.context ?? {},
    ];
  }

  private async postRpc(method: string, params: unknown[]): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AccountAbstractionError(
          "aa_paymaster_rejected",
          `Paymaster returned status ${response.status}`,
        );
      }
      const json = (await response.json()) as {
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      if (json.error) {
        throw new AccountAbstractionError(
          "aa_paymaster_rejected",
          `Paymaster error: ${json.error.message ?? "unknown error"}`,
          json.error,
        );
      }
      return json.result;
    } catch (error) {
      if (error instanceof AccountAbstractionError) throw error;
      throw new AccountAbstractionError(
        "aa_paymaster_rejected",
        "Failed to get paymaster data",
        error,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Serialize a partial UserOperation for paymaster RPC calls.
   * Converts bigint fields to hex strings.
   */
  private serializeForPaymaster(
    userOp: Partial<UserOperation>,
    version?: UserOperationVersion,
  ): Record<string, string> {
    if (version) {
      const serialized = serializeUserOperationForRpc(
        {
          sender:
            userOp.sender ?? "0x0000000000000000000000000000000000000000",
          nonce: userOp.nonce ?? 0n,
          initCode: userOp.initCode ?? "0x",
          callData: userOp.callData ?? "0x",
          accountGasLimits:
            userOp.accountGasLimits ?? `0x${"00".repeat(32)}`,
          preVerificationGas: userOp.preVerificationGas ?? 0n,
          maxFeePerGas: userOp.maxFeePerGas ?? 0n,
          maxPriorityFeePerGas: userOp.maxPriorityFeePerGas ?? 0n,
          paymasterAndData: userOp.paymasterAndData ?? "0x",
          signature: "0x",
        },
        version,
      );
      delete serialized.signature;
      return serialized;
    }

    // Compatibility payload for providers that only implement the older
    // pm_sponsorUserOperation convention. It is intentionally not used by
    // SmartAccountManager, which always supplies ERC-7677 context.
    return {
      sender: userOp.sender ?? "0x0000000000000000000000000000000000000000",
      nonce: `0x${(userOp.nonce ?? 0n).toString(16)}`,
      initCode: userOp.initCode ?? "0x",
      callData: userOp.callData ?? "0x",
      // v0.7: use accountGasLimits
      accountGasLimits:
        userOp.accountGasLimits ??
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      preVerificationGas: `0x${(userOp.preVerificationGas ?? 0n).toString(16)}`,
      maxFeePerGas: `0x${(userOp.maxFeePerGas ?? 0n).toString(16)}`,
      maxPriorityFeePerGas: `0x${(userOp.maxPriorityFeePerGas ?? 0n).toString(16)}`,
      paymasterAndData: userOp.paymasterAndData ?? "0x",
      signature: userOp.signature ?? "0x",
    };
  }
}

interface PaymasterRpcResult {
  paymasterAndData?: string;
  paymaster?: string;
  paymasterData?: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
  isFinal?: boolean;
  sponsor?: { name?: string };
}

function parsePaymasterResult(value: unknown): PaymasterRpcResult {
  if (!value || typeof value !== "object") {
    throw new AccountAbstractionError(
      "aa_paymaster_rejected",
      "Paymaster returned an invalid result",
    );
  }
  return value as PaymasterRpcResult;
}

function decodePackedPaymasterData(value: Hex): {
  paymaster: Address;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  paymasterData: Hex;
} {
  const raw = value.slice(2);
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(raw) || raw.length < 104) {
    throw new AccountAbstractionError(
      "aa_paymaster_rejected",
      "ERC-7677 v0.7 stub returned malformed packed paymaster data",
    );
  }
  return {
    paymaster: `0x${raw.slice(0, 40)}` as Address,
    paymasterVerificationGasLimit: toQuantity(
      BigInt(`0x${raw.slice(40, 72)}`),
    ),
    paymasterPostOpGasLimit: toQuantity(BigInt(`0x${raw.slice(72, 104)}`)),
    paymasterData: `0x${raw.slice(104)}` as Hex,
  };
}

function replacePaymasterVerificationGas(
  stub: PaymasterStubData,
  verificationGasLimit: bigint,
): PaymasterStubData {
  const decoded = decodePackedPaymasterData(stub.paymasterAndData);
  return {
    ...stub,
    paymasterAndData: encodePackedPaymasterData(
      decoded.paymaster,
      toQuantity(verificationGasLimit),
      decoded.paymasterPostOpGasLimit,
      decoded.paymasterData,
    ),
  };
}

function packStandardPaymasterResult(
  result: PaymasterRpcResult,
  version: UserOperationVersion,
  sponsorInfo: string,
  isStub: boolean,
  fallback?: PaymasterStubData,
): PaymasterStubData {
  if (version === "0.6") {
    const paymasterAndData = result.paymasterAndData ?? fallback?.paymasterAndData;
    if (!isHex(paymasterAndData) || paymasterAndData === "0x") {
      throw new AccountAbstractionError(
        "aa_paymaster_rejected",
        "ERC-7677 paymaster did not return v0.6 paymasterAndData",
      );
    }
    return {
      paymasterAndData,
      sponsorInfo,
      isFinal: !isStub || result.isFinal === true,
    };
  }

  const prior = fallback
    ? decodePackedPaymasterData(fallback.paymasterAndData)
    : undefined;
  const paymaster = result.paymaster ?? prior?.paymaster;
  const paymasterData = result.paymasterData ?? prior?.paymasterData;
  // The stub MUST supply postOp gas. Verification gas is optional and is
  // intentionally zero until the bundler estimates it.
  const verificationGas =
    result.paymasterVerificationGasLimit ??
    prior?.paymasterVerificationGasLimit ??
    "0x0";
  const postOpGas =
    result.paymasterPostOpGasLimit ?? prior?.paymasterPostOpGasLimit;
  if (
    !isAddress(paymaster) ||
    !isHex(paymasterData) ||
    !isQuantity(verificationGas) ||
    !isQuantity(postOpGas)
  ) {
    throw new AccountAbstractionError(
      "aa_paymaster_rejected",
      "ERC-7677 paymaster did not return complete v0.7 paymaster fields",
    );
  }
  return {
    paymasterAndData: encodePackedPaymasterData(
      paymaster,
      verificationGas,
      postOpGas,
      paymasterData,
    ),
    sponsorInfo,
    isFinal: !isStub || result.isFinal === true,
  };
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isQuantity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) &&
    BigInt(value) < 1n << 128n
  );
}

function toQuantity(value: bigint | number): string {
  const quantity = BigInt(value);
  if (quantity < 0n) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Paymaster quantities cannot be negative.",
    );
  }
  return `0x${quantity.toString(16)}`;
}

function encodePackedPaymasterData(
  paymaster: Address,
  verificationGasLimit: string,
  postOpGasLimit: string,
  paymasterData: Hex,
): Hex {
  if (!isQuantity(verificationGasLimit) || !isQuantity(postOpGasLimit)) {
    throw new AccountAbstractionError(
      "aa_paymaster_rejected",
      "Paymaster gas limits must be canonical uint128 quantities.",
    );
  }
  return `${paymaster}${BigInt(verificationGasLimit)
    .toString(16)
    .padStart(32, "0")}${BigInt(postOpGasLimit)
    .toString(16)
    .padStart(32, "0")}${paymasterData.slice(2)}` as Hex;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create a PaymasterService from a PaymasterConfig.
 *
 * @param config - Paymaster configuration
 * @returns PaymasterService instance
 */
export function createPaymasterService(
  config: PaymasterConfig,
): PaymasterService {
  return new PaymasterService({
    url: config.url,
    type: config.type,
    policy: config.policy,
  });
}
