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
  PaymasterType,
  UserOperation,
} from "./types";

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
  ): Promise<PaymasterData> {
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

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Serialize a partial UserOperation for paymaster RPC calls.
   * Converts bigint fields to hex strings.
   */
  private serializeForPaymaster(
    userOp: Partial<UserOperation>,
  ): Record<string, string> {
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
