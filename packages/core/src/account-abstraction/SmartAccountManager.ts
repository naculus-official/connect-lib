/**
 * Smart Account Manager
 *
 * Manages ERC-4337 Smart Contract Wallet lifecycle:
 * - Counterfactual address computation (CREATE2)
 * - Account deployment via factory contract
 * - Deploy-and-execute (merge deploy into first UserOperation)
 *
 * Supports the official eth-infinitism SimpleAccount ABIs paired with
 * EntryPoint v0.6 and v0.7 deployments.
 *
 * @see docs/features/account-abstraction.md
 */

import { type AAErrorCode, AccountAbstractionError } from "./errors";
import { PaymasterService } from "./paymaster";
import {
  AA_SUPPORTED_CHAINS,
  type AccountType,
  type Address,
  type BundlerClient,
  type Call,
  DEFAULT_CALL_GAS_LIMIT,
  DEFAULT_PRE_VERIFICATION_GAS,
  DEFAULT_VERIFICATION_GAS_LIMIT,
  type Hex,
  type PaymasterConfig,
  type SendUserOpOptions,
  SIMPLE_ACCOUNT_FACTORY,
  type SmartAccountConfig,
  type SmartAccountInfo,
  type UserOperation,
  type UserOperationGasEstimate,
  type UserOperationReceipt,
  type UserOperationResponse,
} from "./types";
import {
  buildUserOperation,
  encodeGasFees,
  encodeGasLimits,
  serializeUserOperationForRpc,
  signUserOperation,
  signUserOperationV06,
} from "./user-operation";

/**
 * Hash map of known factory addresses for each account type.
 * Keyed by chain ID (CAIP-2 format).
 */
function getFactoryAddress(
  chainId: string,
  accountType: AccountType,
): Address | null {
  // Only the eth-infinitism SimpleAccount factory is implemented here.
  // Never silently use it for a different account implementation.
  if (accountType !== "simple") return null;
  // The factory embeds the EntryPoint in its account implementation. Resolve
  // it from the chain registry so v0.6 and v0.7 can never be mixed.
  //
  // No fallback. `?? SIMPLE_ACCOUNT_FACTORY` contradicted the line above: it
  // returned the v0.7 factory for any chain the registry does not know, which
  // would be an address derived from a contract that is not deployed there.
  // validateAccountConfig currently rejects those chains first with
  // aa_no_entry_point, so this was not reachable — but relying on a caller
  // upstream to have checked is exactly how such a fallback becomes live
  // again, and there is no chain for which guessing a factory is correct.
  return AA_SUPPORTED_CHAINS[chainId]?.factory ?? null;
}

/**
 * Get the EntryPoint address for a given chain.
 */
function getEntryPointForChain(chainId: string): Address | null {
  const info = AA_SUPPORTED_CHAINS[chainId];
  if (info) return info.entryPoint;
  return null;
}

function getUserOperationVersion(chainId: string): "0.6" | "0.7" {
  const info = AA_SUPPORTED_CHAINS[chainId];
  if (!info) throw new AccountAbstractionError("aa_unsupported_chain");
  return info.version;
}

function validateCalls(calls: Call[]): void {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new AccountAbstractionError("aa_no_calls");
  }
  for (const call of calls) {
    if (
      !call ||
      typeof call !== "object" ||
      typeof call.to !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(call.to) ||
      typeof call.value !== "bigint" ||
      call.value < 0n ||
      call.value >= 1n << 256n ||
      typeof call.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data)
    ) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Calls must contain a 20-byte address, uint256 value, and even-length hex data.",
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isHexData(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}

function parseRpcQuantity(value: unknown, field: string): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
  ) {
    throw new AccountAbstractionError(
      "aa_rpc_error",
      `Bundler returned an invalid ${field}.`,
    );
  }
  return BigInt(value);
}

function parseUserOperationReceipt(
  value: unknown,
  expectedHash: Hex,
  expectedEntryPoint: Address,
): UserOperationReceipt {
  if (!isRecord(value)) {
    throw new AccountAbstractionError(
      "aa_rpc_error",
      "Bundler returned an invalid UserOperation receipt.",
    );
  }
  if (
    !isBytes32(value.userOpHash) ||
    value.userOpHash.toLowerCase() !== expectedHash.toLowerCase()
  ) {
    throw new AccountAbstractionError(
      "aa_rpc_error",
      "Bundler receipt does not match the requested UserOperation hash.",
    );
  }
  if (
    !isAddress(value.entryPoint) ||
    value.entryPoint.toLowerCase() !== expectedEntryPoint.toLowerCase()
  ) {
    throw new AccountAbstractionError(
      "aa_rpc_error",
      "Bundler receipt does not match the configured EntryPoint.",
    );
  }
  if (!isAddress(value.sender)) {
    throw new AccountAbstractionError(
      "aa_rpc_error",
      "Bundler receipt contains an invalid sender address.",
    );
  }
  if (
    value.paymaster !== undefined &&
    value.paymaster !== null &&
    !isAddress(value.paymaster)
  ) {
    throw new AccountAbstractionError(
      "aa_rpc_error",
      "Bundler receipt contains an invalid paymaster address.",
    );
  }
  if (typeof value.success !== "boolean" || !isBytes32(value.transactionHash)) {
    throw new AccountAbstractionError(
      "aa_rpc_error",
      "Bundler receipt contains an invalid execution result.",
    );
  }
  if (!Array.isArray(value.logs)) {
    throw new AccountAbstractionError(
      "aa_rpc_error",
      "Bundler receipt contains invalid logs.",
    );
  }

  const logs = value.logs.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !isAddress(candidate.address) ||
      !Array.isArray(candidate.topics) ||
      !candidate.topics.every(isBytes32) ||
      !isHexData(candidate.data)
    ) {
      throw new AccountAbstractionError(
        "aa_rpc_error",
        "Bundler receipt contains an invalid log entry.",
      );
    }
    return {
      address: candidate.address,
      topics: candidate.topics,
      data: candidate.data,
    };
  });

  return {
    userOpHash: value.userOpHash,
    entryPoint: value.entryPoint,
    sender: value.sender,
    nonce: parseRpcQuantity(value.nonce, "nonce"),
    ...(value.paymaster === undefined || value.paymaster === null
      ? {}
      : { paymaster: value.paymaster }),
    actualGasUsed: parseRpcQuantity(value.actualGasUsed, "actualGasUsed"),
    actualGasCost: parseRpcQuantity(value.actualGasCost, "actualGasCost"),
    success: value.success,
    transactionHash: value.transactionHash,
    logs,
  };
}

/**
 * Encode the createAccount call data for the SimpleAccountFactory.
 * The factory's `createAccount(address owner, uint256 salt)` returns the account address.
 *
 * ABI: createAccount(address,uint256) — selector is the first 4 bytes of
 * keccak256("createAccount(address,uint256)") = 0x5fbfb9cf. The previous value
 * (0xcf7aba77) matched no factory signature, so both the counterfactual
 * address lookup and the deployment initCode called a function the
 * SimpleAccountFactory does not expose.
 * Args: owner (left-padded to 32 bytes) + salt (left-padded to 32 bytes)
 */
function encodeCreateAccount(owner: Address, salt: bigint): Hex {
  const selector = "0x5fbfb9cf";
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    throw new AccountAbstractionError("aa_invalid_owner");
  }
  if (salt < 0n || salt >= 1n << 256n) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Account salt must fit in uint256.",
    );
  }
  const ownerArg = owner.toLowerCase().replace("0x", "").padStart(64, "0");
  const saltArg = salt.toString(16).padStart(64, "0");
  return `${selector}${ownerArg}${saltArg}` as Hex;
}

/**
 * Encode the execute call for SimpleAccount.
 * execute(address,uint256,bytes) selector = 0xb61d27f6
 */
function encodeExecute(to: Address, value: bigint, data: Hex): Hex {
  const selector = "0xb61d27f6";
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Invalid call target address.",
    );
  }
  const toArg = to.toLowerCase().replace("0x", "").padStart(64, "0");
  if (value < 0n || value >= 1n << 256n) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Call value cannot be negative.",
    );
  }
  const valueArg = value.toString(16).padStart(64, "0");
  // ABI offsets are relative to the start of the argument block. The bytes
  // tail starts after all three head words: to, value, and the offset itself.
  const dataOffset = toArg.length / 2 + valueArg.length / 2 + 32;
  const dataLen = data.startsWith("0x")
    ? (data.length - 2) / 2
    : data.length / 2;
  const dataRaw = data.replace("0x", "");
  if (dataRaw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(dataRaw)) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Call data must be valid hexadecimal.",
    );
  }
  const offsetArg = dataOffset.toString(16).padStart(64, "0");
  const lengthArg = dataLen.toString(16).padStart(64, "0");
  const paddedData = dataRaw.padEnd(Math.ceil(dataRaw.length / 64) * 64, "0");
  return `${selector}${toArg}${valueArg}${offsetArg}${lengthArg}${paddedData}` as Hex;
}

/**
 * Encode batch execute for SimpleAccount.
 * executeBatch(address[],uint256[],bytes[]) selector = 0x47e1da2a
 *
 * For simplicity, we only pass one array of calldata elements.
 */
function encodeExecuteBatch(calls: Call[], version: "0.6" | "0.7"): Hex {
  if (version === "0.6" && calls.some((call) => call.value !== 0n)) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "SimpleAccount v0.6 executeBatch cannot transfer native value; use separate UserOperations or EntryPoint v0.7.",
    );
  }
  const selector = version === "0.6" ? "0x18dfb3c7" : "0x47e1da2a";
  return `${selector}${version === "0.6" ? encodeExecuteBatchV06Calls(calls) : encodeExecuteBatchCalls(calls)}` as Hex;
}

function encodeExecuteBatchCalls(calls: Call[]): string {
  const n = calls.length;
  const word = (value: bigint | number): string => {
    if (
      typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Array length is invalid.",
      );
    }
    if (typeof value === "bigint" && (value < 0n || value >= 1n << 256n)) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "ABI integer is out of range.",
      );
    }
    return BigInt(value).toString(16).padStart(64, "0");
  };
  const toArray =
    word(n) +
    calls
      .map((c) => {
        if (!/^0x[0-9a-fA-F]{40}$/.test(c.to)) {
          throw new AccountAbstractionError(
            "aa_encode_error",
            "Invalid call target address.",
          );
        }
        return word(BigInt(`0x${c.to.toLowerCase().replace("0x", "")}`));
      })
      .join("");
  const valuesArray = word(n) + calls.map((c) => word(c.value)).join("");
  const tails = calls.map((c) => {
    if (c.value < 0n) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Call value cannot be negative.",
      );
    }
    const rawData = c.data.replace("0x", "");
    if (rawData.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(rawData)) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Call data must be valid hexadecimal.",
      );
    }
    const padded = rawData.padEnd(Math.ceil(rawData.length / 64) * 64, "0");
    return word(rawData.length / 2) + padded;
  });
  const datasArray =
    word(n) +
    tails
      .map((_, i) =>
        word(
          tails
            .slice(0, i)
            .reduce((sum, tail) => sum + tail.length / 2, n * 32),
        ),
      )
      .join("") +
    tails.join("");

  const toArrayLen = 32 + n * 32;
  const valuesArrayLen = 32 + n * 32;
  const toOffset = word(96); // after 3 head words
  const valuesOffset = word(96 + toArrayLen);
  const datasOffset = word(96 + toArrayLen + valuesArrayLen);

  return (
    toOffset + valuesOffset + datasOffset + toArray + valuesArray + datasArray
  );
}

/** ABI payload for SimpleAccount v0.6 executeBatch(address[],bytes[]). */
function encodeExecuteBatchV06Calls(calls: Call[]): string {
  const n = calls.length;
  const word = (value: bigint | number): string => {
    if (
      typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "Array length is invalid.",
      );
    }
    if (typeof value === "bigint" && (value < 0n || value >= 1n << 256n)) {
      throw new AccountAbstractionError(
        "aa_encode_error",
        "ABI integer is out of range.",
      );
    }
    return BigInt(value).toString(16).padStart(64, "0");
  };
  const toArray =
    word(n) +
    calls
      .map((call) =>
        word(BigInt(`0x${call.to.toLowerCase().replace("0x", "")}`)),
      )
      .join("");
  const tails = calls.map((call) => {
    const rawData = call.data.replace("0x", "");
    const padded = rawData.padEnd(Math.ceil(rawData.length / 64) * 64, "0");
    return word(rawData.length / 2) + padded;
  });
  const dataArray =
    word(n) +
    tails
      .map((_, index) =>
        word(
          tails
            .slice(0, index)
            .reduce((sum, tail) => sum + tail.length / 2, n * 32),
        ),
      )
      .join("") +
    tails.join("");
  const toArrayLength = 32 + n * 32;
  const headSize = 32 * 2;
  return word(headSize) + word(headSize + toArrayLength) + toArray + dataArray;
}

/**
 * Check if a contract is deployed at the given address.
 */
async function isContractDeployed(
  rpcUrl: string,
  address: Address,
): Promise<boolean> {
  const code = await rpcCall<string>(rpcUrl, "eth_getCode", [
    address,
    "latest",
  ]);
  return code !== "0x";
}

/**
 * Make a JSON-RPC call.
 */
async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new AccountAbstractionError(
        "aa_rpc_error",
        `RPC returned status ${response.status}`,
      );
    }

    const json = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };

    if (json.error) {
      throw new AccountAbstractionError("aa_rpc_error", json.error.message, {
        code: json.error.code,
      });
    }

    return json.result as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── SmartAccountManager ───────────────────────────────────────────────

export interface SmartAccountManagerConfig {
  /** RPC URL for the target chain */
  rpcUrl: string;
  /** Bundler client configuration */
  bundlerClient: BundlerClient;
  /** Optional paymaster service */
  paymaster?: PaymasterService;
  /** Default paymaster configuration (used if no paymaster instance provided) */
  defaultPaymasterConfig?: PaymasterConfig;
  /** Chain ID in CAIP-2 format */
  chainId: string;
  /** Sign the ERC-4337 userOpHash (EIP-191 by default for SimpleAccount). */
  signer?: (hash: Hex) => Promise<Hex> | Hex;
  /** Signature preimage expected by the account implementation. SimpleAccount uses EIP-191. */
  signerMode?: "raw" | "eip191";
}

export class SmartAccountManager {
  private config: SmartAccountManagerConfig;

  constructor(config: SmartAccountManagerConfig) {
    this.config = config;
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Check if ERC-4337 is supported on the configured chain.
   */
  isAASupported(chainId?: string): boolean {
    const id = chainId ?? this.config.chainId;
    return id in AA_SUPPORTED_CHAINS;
  }

  /**
   * Compute the counterfactual address for a smart account.
   * The account does not need to be deployed yet.
   *
   * Uses the factory's createAccount to compute the address via eth_call.
   *
   * @param config - Smart account configuration
   * @returns The deterministic smart account address
   */
  async getAccountAddress(config: SmartAccountConfig): Promise<Address> {
    const chainId = config.chainId ?? this.config.chainId;
    this.validateAccountConfig(config, chainId);
    const factory = this.getFactory(chainId, config.accountType);

    const salt = config.salt ?? 0n;
    const callData = encodeCreateAccount(config.owner, salt);

    // eth_call the factory to get the deterministic address
    const result = await rpcCall<string>(this.config.rpcUrl, "eth_call", [
      {
        to: factory,
        data: callData,
      },
      "latest",
    ]);

    // The factory returns the account address (20 bytes, padded to 32)
    const raw = result.startsWith("0x") ? result.slice(2) : result;
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new AccountAbstractionError(
        "aa_rpc_error",
        "SimpleAccountFactory returned an invalid address encoding.",
      );
    }
    const addressHex = `0x${raw.slice(-40)}` as Address;
    return addressHex;
  }

  /**
   * Create a SmartAccountManager instance for a given smart account.
   * Computes the address but does not deploy.
   *
   * @param config - Smart account configuration
   * @returns Smart account info
   */
  async createAccount(config: SmartAccountConfig): Promise<SmartAccountInfo> {
    const chainId = config.chainId ?? this.config.chainId;
    this.validateAccountConfig(config, chainId);
    const address = await this.getAccountAddress(config);
    const isDeployed = await isContractDeployed(this.config.rpcUrl, address);

    return {
      address,
      isDeployed,
      accountType: config.accountType,
      owner: config.owner,
    };
  }

  /**
   * Deploy a smart account to the blockchain.
   *
   * Sends a raw transaction to the factory contract with the createAccount call.
   *
   * @param config - Smart account configuration
   * @returns Transaction hash
   */
  async deployAccount(config: SmartAccountConfig): Promise<Hex> {
    const chainId = config.chainId ?? this.config.chainId;
    const address = await this.getAccountAddress(config);
    const deployed = await isContractDeployed(this.config.rpcUrl, address);
    if (deployed) {
      return address;
    }

    // Deployment requires a signed tx to the factory.
    // getDeployCallData returns the payload needed for deployment.
    // The caller must sign and broadcast this tx.
    throw new AccountAbstractionError(
      "aa_account_not_deployed",
      `Account ${address} is not deployed. Use getDeployCallData() to obtain the deploy transaction payload, sign it, and send it to the factory.`,
    );
  }

  /**
   * Deploy using a minimal deployment transaction.
   * For self-custodial setups, the deploy is a simple eth_call via the factory.
   */
  async getDeployCallData(config: SmartAccountConfig): Promise<{
    to: Address;
    data: Hex;
    value: bigint;
  }> {
    const chainId = config.chainId ?? this.config.chainId;
    this.validateAccountConfig(config, chainId);
    const factory = this.getFactory(chainId, config.accountType);
    const salt = config.salt ?? 0n;

    return {
      to: factory,
      data: encodeCreateAccount(config.owner, salt),
      value: 0n,
    };
  }

  // ── UserOperation Methods ───────────────────────────────────────

  /**
   * Send a UserOperation to the bundler.
   *
   * @param config - Smart account config
   * @param calls - Array of calls to execute
   * @param options - Optional overrides (gas, paymaster)
   * @returns UserOperation response
   */
  async sendUserOperation(
    config: SmartAccountConfig,
    calls: Call[],
    options?: SendUserOpOptions,
  ): Promise<UserOperationResponse> {
    validateCalls(calls);

    const chainId = config.chainId ?? this.config.chainId;
    const version = getUserOperationVersion(chainId);
    const address = await this.getAccountAddress(config);

    // Determine initCode (deploy if not deployed and not skipped)
    let initCode: Hex = "0x";
    if (!options?.skipDeploy) {
      const deployed = await isContractDeployed(this.config.rpcUrl, address);
      if (!deployed) {
        const deployData = await this.getDeployCallData(config);
        const factory = this.getFactory(chainId, config.accountType);
        // initCode = factory address (20 bytes) + createAccount calldata
        initCode = `${factory}${deployData.data.replace("0x", "")}` as Hex;
      }
    }

    // Read nonce from entry point
    const entryPoint = config.entryPoint ?? this.getEntryPoint(chainId);
    const nonce = await this.getNonce(entryPoint, address);

    // Encode call data (batch if multiple calls)
    const callData =
      calls.length === 1
        ? encodeExecute(calls[0].to, calls[0].value, calls[0].data)
        : encodeExecuteBatch(calls, version);

    // Get fee data
    let maxFeePerGas: bigint;
    let maxPriorityFeePerGas: bigint;
    if (options?.gasOverrides?.maxFeePerGas !== undefined) {
      maxFeePerGas = options.gasOverrides.maxFeePerGas;
      maxPriorityFeePerGas =
        options.gasOverrides.maxPriorityFeePerGas ??
        (await this.getPriorityFee());
    } else {
      const baseFee = await this.getBaseFee();
      const priorityFee = await this.getPriorityFee();
      maxFeePerGas = baseFee * 2n + priorityFee;
      maxPriorityFeePerGas = priorityFee;
    }
    if (maxPriorityFeePerGas > maxFeePerGas) {
      throw new AccountAbstractionError(
        "aa_invalid_input",
        "maxPriorityFeePerGas cannot exceed maxFeePerGas.",
      );
    }

    const paymasterConfig =
      options?.paymaster ?? this.config.defaultPaymasterConfig;
    const paymasterService = paymasterConfig
      ? (this.config.paymaster ??
        new PaymasterService({
          url: paymasterConfig.url,
          type: paymasterConfig.type,
          policy: paymasterConfig.policy,
        }))
      : undefined;
    const paymasterRequest = paymasterService
      ? {
          entryPoint,
          chainId: BigInt(chainId.split(":")[1]),
          version,
        }
      : undefined;

    // ERC-7677 stub data must be present during bundler estimation; otherwise
    // the estimate ignores paymaster validation entirely and can succeed
    // locally with gas limits the sponsored operation cannot use.
    const provisionalUserOp = buildUserOperation({
      sender: address,
      nonce,
      initCode,
      callData,
      accountGasLimits: encodeGasLimits(
        options?.gasOverrides?.verificationGasLimit ?? 0n,
        options?.gasOverrides?.callGasLimit ?? 0n,
      ),
      preVerificationGas: options?.gasOverrides?.preVerificationGas ?? 0n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasFees: encodeGasFees(maxPriorityFeePerGas, maxFeePerGas),
      paymasterAndData: "0x",
      signature: "0x",
    });
    const paymasterStub =
      paymasterService && paymasterRequest
        ? await paymasterService.getPaymasterStubData(
            provisionalUserOp,
            paymasterRequest,
          )
        : undefined;

    const gasEstimate = await this.estimateUserOperationGas(
      entryPoint,
      {
        ...provisionalUserOp,
        paymasterAndData: paymasterStub?.paymasterAndData ?? "0x",
      },
      version,
    );

    const callGasLimit =
      options?.gasOverrides?.callGasLimit ?? gasEstimate.callGasLimit;
    const verificationGasLimit =
      options?.gasOverrides?.verificationGasLimit ??
      gasEstimate.verificationGasLimit;
    const preVerificationGas =
      options?.gasOverrides?.preVerificationGas ??
      gasEstimate.preVerificationGas;

    // Build the v0.7 accountGasLimits
    const accountGasLimits = encodeGasLimits(
      verificationGasLimit,
      callGasLimit,
    );

    // Build partial UserOperation
    let userOp = buildUserOperation({
      sender: address,
      nonce,
      initCode,
      callData,
      accountGasLimits,
      preVerificationGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasFees: encodeGasFees(maxPriorityFeePerGas, maxFeePerGas),
      paymasterAndData: "0x",
      signature: "0x",
    });

    if (paymasterService && paymasterRequest && paymasterStub) {
      const paymasterData = await paymasterService.getPaymasterFinalData(
        userOp,
        paymasterRequest,
        paymasterStub,
        gasEstimate.paymasterVerificationGasLimit,
      );
      userOp = { ...userOp, paymasterAndData: paymasterData.paymasterAndData };
    }

    if (!this.config.signer) {
      throw new AccountAbstractionError(
        "aa_signature_failed",
        "A raw UserOperation signer is required before sending to a bundler.",
      );
    }
    const signedUserOp =
      version === "0.6"
        ? await signUserOperationV06(
            userOp,
            this.config.signer,
            entryPoint,
            BigInt(chainId.split(":")[1]),
            this.config.signerMode ?? "eip191",
          )
        : await signUserOperation(
            userOp,
            this.config.signer,
            entryPoint,
            BigInt(chainId.split(":")[1]),
            this.config.signerMode ?? "eip191",
          );
    const userOpHash = await this.sendUserOpToBundler(
      signedUserOp,
      entryPoint,
      version,
    );

    return {
      userOpHash,
      sender: address,
      nonce,
    };
  }

  /**
   * Get the nonce for a smart account from the EntryPoint.
   */
  async getNonce(entryPoint: Address, sender: Address): Promise<bigint> {
    const key = "0x" + "0".repeat(64); // default key (0)
    const selector = "0x35567e1a"; // getNonce(address,uint192)
    const senderArg = sender.toLowerCase().replace("0x", "").padStart(64, "0");
    const keyArg32 = key.replace("0x", "").padStart(64, "0");

    const result = await rpcCall<string>(this.config.rpcUrl, "eth_call", [
      { to: entryPoint, data: `${selector}${senderArg}${keyArg32}` },
      "latest",
    ]);

    return BigInt(result);
  }

  /**
   * Estimate gas for a UserOperation via the bundler's eth_estimateUserOperationGas.
   */
  async estimateUserOperationGas(
    entryPoint: Address,
    partialUserOp: Partial<UserOperation>,
    version: "0.6" | "0.7" = "0.7",
  ): Promise<UserOperationGasEstimate> {
    const expectedEntryPoint = this.getEntryPoint(this.config.chainId);
    const expectedVersion = getUserOperationVersion(this.config.chainId);
    if (
      entryPoint.toLowerCase() !== expectedEntryPoint.toLowerCase() ||
      version !== expectedVersion
    ) {
      throw new AccountAbstractionError(
        "aa_invalid_input",
        `EntryPoint ${entryPoint} and UserOperation version ${version} do not match manager chain ${this.config.chainId}.`,
      );
    }
    const bundlerUrl = this.config.bundlerClient.url;
    // sendUserOperation checks this; estimation did not, so an unconfigured
    // bundler surfaced here as a fetch failure against an empty URL instead of
    // naming the missing configuration.
    if (!bundlerUrl) {
      throw new AccountAbstractionError("aa_no_bundler");
    }
    const params = {
      ...partialUserOp,
      sender:
        partialUserOp.sender ?? "0x0000000000000000000000000000000000000000",
      nonce: partialUserOp.nonce ?? 0n,
      initCode: partialUserOp.initCode ?? "0x",
      callData: partialUserOp.callData ?? "0x",
      accountGasLimits:
        partialUserOp.accountGasLimits ?? encodeGasLimits(0n, 0n),
      gasFees:
        partialUserOp.gasFees ??
        encodeGasFees(
          partialUserOp.maxPriorityFeePerGas ?? 0n,
          partialUserOp.maxFeePerGas ?? 0n,
        ),
      preVerificationGas: partialUserOp.preVerificationGas ?? 0n,
      maxFeePerGas: partialUserOp.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: partialUserOp.maxPriorityFeePerGas ?? 0n,
      paymasterAndData: partialUserOp.paymasterAndData ?? "0x",
      signature: partialUserOp.signature ?? "0x",
    };
    const serializedParams = serializeUserOperationForRpc(
      params as UserOperation,
      version,
    );

    const result = await rpcCall<{
      callGasLimit?: string;
      verificationGasLimit?: string;
      preVerificationGas?: string;
      accountGasLimits?: string;
      paymasterVerificationGasLimit?: string;
    }>(bundlerUrl, "eth_estimateUserOperationGas", [
      serializedParams,
      entryPoint,
    ]);
    if (!result || typeof result !== "object") {
      throw new AccountAbstractionError(
        "aa_estimation_failed",
        "Bundler returned no gas estimate.",
      );
    }

    const parseEstimate = (value: unknown, field: string): bigint => {
      if (
        typeof value !== "string" ||
        !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
      ) {
        throw new AccountAbstractionError(
          "aa_estimation_failed",
          `Bundler returned an invalid ${field}.`,
        );
      }
      return BigInt(value);
    };

    let callGasLimit: bigint;
    let verificationGasLimit: bigint;
    if (typeof result.accountGasLimits === "string") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(result.accountGasLimits)) {
        throw new AccountAbstractionError(
          "aa_estimation_failed",
          "Bundler returned invalid packed accountGasLimits.",
        );
      }
      const packed = result.accountGasLimits.slice(2);
      verificationGasLimit = BigInt(`0x${packed.slice(0, 32)}`);
      callGasLimit = BigInt(`0x${packed.slice(32)}`);
    } else {
      callGasLimit = parseEstimate(result.callGasLimit, "callGasLimit");
      verificationGasLimit = parseEstimate(
        result.verificationGasLimit,
        "verificationGasLimit",
      );
    }
    return {
      callGasLimit,
      verificationGasLimit,
      preVerificationGas: parseEstimate(
        result.preVerificationGas,
        "preVerificationGas",
      ),
      accountGasLimits: result.accountGasLimits as Hex | undefined,
      ...(result.paymasterVerificationGasLimit === undefined
        ? {}
        : {
            paymasterVerificationGasLimit: parseEstimate(
              result.paymasterVerificationGasLimit,
              "paymasterVerificationGasLimit",
            ),
          }),
    };
  }

  /**
   * Send a signed UserOperation to the bundler.
   * Returns the userOpHash which can be used to track the operation.
   */
  async sendUserOpToBundler(
    userOp: UserOperation,
    entryPoint: Address = this.getEntryPoint(this.config.chainId),
    version: "0.6" | "0.7" = getUserOperationVersion(this.config.chainId),
  ): Promise<Hex> {
    const expectedEntryPoint = this.getEntryPoint(this.config.chainId);
    const expectedVersion = getUserOperationVersion(this.config.chainId);
    if (
      entryPoint.toLowerCase() !== expectedEntryPoint.toLowerCase() ||
      version !== expectedVersion
    ) {
      throw new AccountAbstractionError(
        "aa_invalid_input",
        `EntryPoint ${entryPoint} and UserOperation version ${version} do not match manager chain ${this.config.chainId}.`,
      );
    }
    const bundlerUrl = this.config.bundlerClient.url;

    if (!bundlerUrl) {
      throw new AccountAbstractionError("aa_no_bundler");
    }

    const serializedOp = serializeUserOperationForRpc(userOp, version);

    const userOpHash = await rpcCall<unknown>(
      bundlerUrl,
      "eth_sendUserOperation",
      [serializedOp, entryPoint],
    );

    if (!isBytes32(userOpHash)) {
      throw new AccountAbstractionError(
        "aa_rpc_error",
        "Bundler returned an invalid UserOperation hash.",
      );
    }

    return userOpHash;
  }

  /**
   * Poll for a UserOperation receipt.
   */
  async getUserOperationReceipt(
    userOpHash: Hex,
    maxRetries = 10,
    intervalMs = 2000,
  ): Promise<UserOperationReceipt | null> {
    const bundlerUrl = this.config.bundlerClient.url;

    if (!bundlerUrl) {
      throw new AccountAbstractionError("aa_no_bundler");
    }
    if (!isBytes32(userOpHash)) {
      throw new AccountAbstractionError(
        "aa_invalid_input",
        "UserOperation hash must be a 32-byte hex value.",
      );
    }
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 1) {
      throw new AccountAbstractionError(
        "aa_invalid_input",
        "maxRetries must be a positive safe integer.",
      );
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
      throw new AccountAbstractionError(
        "aa_invalid_input",
        "intervalMs must be a non-negative safe integer.",
      );
    }
    const expectedEntryPoint = this.getEntryPoint(this.config.chainId);

    for (let i = 0; i < maxRetries; i++) {
      let result: unknown = null;
      try {
        result = await rpcCall<unknown>(
          bundlerUrl,
          "eth_getUserOperationReceipt",
          [userOpHash],
        );
      } catch {
        // Transient RPC and transport failures remain retryable.
      }

      // Parse outside the retry catch. Once a bundler returns a non-null
      // receipt, malformed or mismatched data is an integrity failure rather
      // than a pending operation and must not be hidden as a timeout.
      if (result !== null && result !== undefined) {
        return parseUserOperationReceipt(
          result,
          userOpHash,
          expectedEntryPoint,
        );
      }

      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    throw new AccountAbstractionError(
      "aa_receipt_timeout",
      "UserOperation receipt not found after maximum retries",
    );
  }

  /**
   * Send a batch of calls in a single UserOperation.
   *
   * @param config - Smart account config
   * @param calls - Array of calls to batch
   * @param options - Optional overrides
   * @returns UserOperation response
   */
  async sendBatch(
    config: SmartAccountConfig,
    calls: Call[],
    options?: SendUserOpOptions,
  ): Promise<UserOperationResponse> {
    return this.sendUserOperation(config, calls, options);
  }

  // ── Gas / Fee Helpers ───────────────────────────────────────────

  /**
   * Get the latest base fee per gas.
   */
  async getBaseFee(): Promise<bigint> {
    try {
      const block = await rpcCall<{ baseFeePerGas?: string }>(
        this.config.rpcUrl,
        "eth_getBlockByNumber",
        ["latest", false],
      );
      if (block?.baseFeePerGas) {
        const fee = BigInt(block.baseFeePerGas);
        if (fee >= 0n) return fee;
      }
    } catch (error) {
      throw new AccountAbstractionError(
        "aa_rpc_error",
        "Failed to read the target chain base fee.",
        error,
      );
    }
    throw new AccountAbstractionError(
      "aa_rpc_error",
      "Target chain did not return a base fee.",
    );
  }

  /**
   * Get the recommended priority fee.
   */
  async getPriorityFee(): Promise<bigint> {
    try {
      const result = await rpcCall<string>(
        this.config.rpcUrl,
        "eth_maxPriorityFeePerGas",
        [],
      );
      const fee = BigInt(result);
      if (fee >= 0n) return fee;
    } catch (error) {
      throw new AccountAbstractionError(
        "aa_rpc_error",
        "Failed to read the target chain priority fee.",
        error,
      );
    }
    throw new AccountAbstractionError(
      "aa_rpc_error",
      "Target chain returned an invalid priority fee.",
    );
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private getEntryPoint(chainId: string): Address {
    const ep = getEntryPointForChain(chainId);
    if (!ep) {
      throw new AccountAbstractionError("aa_no_entry_point");
    }
    return ep;
  }

  private getFactory(chainId: string, accountType: AccountType): Address {
    if (accountType !== "simple") {
      throw new AccountAbstractionError(
        "aa_unknown_account_type",
        `Account type "${accountType}" is not implemented by this module.`,
      );
    }
    const factory = getFactoryAddress(chainId, accountType);
    if (!factory) {
      // Distinguished from the account-type error: the caller needs to know
      // it is the chain that is unsupported, not their configuration.
      throw new AccountAbstractionError(
        "aa_unsupported_chain",
        `No SimpleAccount factory is registered for ${chainId}. Account ` +
          `abstraction requires a chain with a known EntryPoint and factory.`,
      );
    }
    return factory;
  }

  private validateAccountConfig(
    config: SmartAccountConfig,
    chainId: string,
  ): void {
    // Resolve first so an unknown chain reports the more specific missing
    // EntryPoint error rather than being obscured by a transport mismatch.
    const expectedEntryPoint = this.getEntryPoint(chainId);
    // The manager owns one RPC/bundler transport. Refuse a per-account chain
    // override unless it matches that transport; otherwise a caller could
    // derive or submit a valid-looking UserOperation against the wrong chain.
    if (chainId !== this.config.chainId) {
      throw new AccountAbstractionError(
        "aa_invalid_input",
        `Account chain ${chainId} does not match manager chain ${this.config.chainId}.`,
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(config.owner)) {
      throw new AccountAbstractionError("aa_invalid_owner");
    }
    const configuredEntryPoint = config.entryPoint;
    if (
      configuredEntryPoint &&
      configuredEntryPoint.toLowerCase() !== expectedEntryPoint.toLowerCase()
    ) {
      throw new AccountAbstractionError(
        "aa_no_entry_point",
        `EntryPoint ${configuredEntryPoint} is not the registered EntryPoint for ${chainId}.`,
      );
    }
  }
}

// ─── Utility ───────────────────────────────────────────────────────────

/**
 * Decode account gas limits from packed 32-byte value (v0.7).
 */
export function decodeGasLimits(accountGasLimits: Hex): {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
} {
  const raw = accountGasLimits.startsWith("0x")
    ? accountGasLimits.slice(2)
    : accountGasLimits;
  if (raw.length !== 64 || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new AccountAbstractionError(
      "aa_encode_error",
      "Packed account gas limits must be exactly 32 bytes.",
    );
  }
  const verificationGasLimit = BigInt(`0x${raw.slice(0, 32)}`);
  const callGasLimit = BigInt(`0x${raw.slice(32, 64)}`);
  return { verificationGasLimit, callGasLimit };
}
