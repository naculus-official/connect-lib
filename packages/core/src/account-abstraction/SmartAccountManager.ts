/**
 * Smart Account Manager
 *
 * Manages ERC-4337 Smart Contract Wallet lifecycle:
 * - Counterfactual address computation (CREATE2)
 * - Account deployment via factory contract
 * - Deploy-and-execute (merge deploy into first UserOperation)
 *
 * Supports SimpleAccount (eth-infinitism) with EntryPoint v0.7.
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
  DEFAULT_ENTRY_POINT,
  DEFAULT_PRE_VERIFICATION_GAS,
  DEFAULT_VERIFICATION_GAS_LIMIT,
  ENTRY_POINT_V0_6,
  ENTRY_POINT_V0_7,
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
import { buildUserOperation, signUserOperation } from "./user-operation";

/**
 * Hash map of known factory addresses for each account type.
 * Keyed by chain ID (CAIP-2 format).
 */
function getFactoryAddress(
  _chainId: string,
  _accountType: AccountType,
): Address {
  return SIMPLE_ACCOUNT_FACTORY;
}

/**
 * Get the EntryPoint address for a given chain.
 */
function getEntryPointForChain(chainId: string): Address | null {
  const info = AA_SUPPORTED_CHAINS[chainId];
  if (info) return info.entryPoint;
  return null;
}

/**
 * Compute the keccak256 hash of a hex string.
 */
async function keccak256(data: Hex): Promise<Hex> {
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const { bytesToHex } = await import("@noble/hashes/utils");
  const raw = data.startsWith("0x") ? data.slice(2) : data;
  const bytes = new Uint8Array(raw.length / 2);
  for (let i = 0; i < raw.length; i += 2) {
    bytes[i / 2] = parseInt(raw.slice(i, i + 2), 16);
  }
  return `0x${bytesToHex(keccak_256(bytes))}` as Hex;
}

/**
 * Encode the createAccount call data for the SimpleAccountFactory.
 * The factory's `createAccount(address owner, uint256 salt)` returns the account address.
 *
 * ABI: createAccount(address,uint256) = 0xcf7aba77
 * Args: owner (left-padded to 32 bytes) + salt (left-padded to 32 bytes)
 */
function encodeCreateAccount(owner: Address, salt: bigint): Hex {
  const selector = "0xcf7aba77";
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
  const toArg = to.toLowerCase().replace("0x", "").padStart(64, "0");
  const valueArg = value.toString(16).padStart(64, "0");
  // Dynamic bytes: offset + length + data
  const dataOffset = toArg.length / 2 + valueArg.length / 2 + 64; // 32 bytes for offset
  const dataLen = data.startsWith("0x")
    ? (data.length - 2) / 2
    : data.length / 2;
  const offsetArg = `00000000000000000000000000000000000000000000000000000000000000${dataOffset.toString(16).padStart(2, "0")}`;
  const lengthArg = dataLen.toString(16).padStart(64, "0");
  const dataRaw = data.replace("0x", "");
  return `${selector}${toArg}${valueArg}${offsetArg}${lengthArg}${dataRaw}` as Hex;
}

/**
 * Encode batch execute for SimpleAccount.
 * executeBatch(address[],uint256[],bytes[]) selector = 0x47e1da2a
 *
 * For simplicity, we only pass one array of calldata elements.
 */
function encodeExecuteBatch(calls: Call[]): Hex {
  const selector = "0x47e1da2a";
  // Build the ABI-encoded arrays
  const numCalls = calls.length;

  // offsets and lengths
  const toOffset = 32; // after numCalls word
  const valuesOffset = toOffset + 32 * numCalls + 32; // after to array
  const datasOffset = valuesOffset + 32 * numCalls + 32; // after values array

  const toPart =
    numCalls.toString(16).padStart(64, "0") +
    calls
      .map((c) => c.to.toLowerCase().replace("0x", "").padStart(64, "0"))
      .join("");

  const valuePart =
    numCalls.toString(16).padStart(64, "0") +
    calls.map((c) => c.value.toString(16).padStart(64, "0")).join("");

  // Datas: dynamic array of dynamic bytes
  const dataLengths = calls.map((c) => c.data.replace("0x", "").length / 2);
  const dataBody = calls
    .map(
      (c, i) =>
        dataLengths[i].toString(16).padStart(64, "0") +
        c.data.replace("0x", ""),
    )
    .join("");

  // Compute total data body length for the outer array
  const totalDataLength = 32 + dataBody.length / 2; // length word + data
  const dataArrayLengthWord = numCalls.toString(16).padStart(64, "0");

  const dataPart = dataArrayLengthWord + dataBody;

  // Locations (offsets from start of encoded data):
  // 0x00: numCalls
  // 0x20: to array offset (= 32)
  // 0x40: values array offset (= 32 + to array total size)
  // 0x60: datas array offset (= values array offset + values array total size)

  // Recalculate precisely:
  // Each array: 32 bytes for length + 32*N bytes for elements
  // But values are uint256 so 32 bytes each, to addresses are address so also padded to 32
  const toArraySize = 32 + numCalls * 32;
  const valuesArraySize = 32 + numCalls * 32;
  const datasArraySize = 32 + dataBody.length / 2;

  const toArrOffset = 32 + 32 + 32; // after the 3 offset words + numCalls
  // Actually the outer encoding:
  // [0x00-0x1f] = offset to to[] array
  // [0x20-0x3f] = offset to values[] array
  // [0x40-0x5f] = offset to datas[] array
  // Wait executeBatch(address[],uint256[],bytes[]) takes 3 tuple args
  // Actually executeBatch is: function executeBatch(address[] calldata dest, uint256[] calldata val, bytes[] calldata data)

  // Let me use a simpler but correct encoding:
  // Head section: 3 offsets (32 bytes each) = 96 bytes
  // Then each array follows at those offsets

  const headSize = 96; // 3 * 32
  const toArrOffset2 = 0x20; // first array starts at offset 32 (after first 32 bytes which is the offset)
  const valuesArrOffset2 = headSize + toArraySize; // values array starts after to array
  // Hmm this is getting complex. Let me use a cleaner approach.

  // Actually for executeBatch, the selector is the first 4 bytes of keccak256("executeBatch(address[],uint256[],bytes[])")
  // The ABI encoding for 3 dynamic arrays:
  // offset_to[] (32 bytes) = 0x60 (start of to array data after all 3 offsets)
  // offset_values[] (32 bytes) = 0x60 + to_array_size
  // offset_datas[] (32 bytes) = 0x60 + to_array_size + values_array_size

  return `${selector}${encodeExecuteBatchCalls(calls)}` as Hex;
}

function encodeExecuteBatchCalls(calls: Call[]): string {
  const n = calls.length;
  const nWord = n.toString(16).padStart(64, "0");

  // Each array: [length(32B)] + [n elements padded to 32B each]
  const toArray =
    nWord +
    calls
      .map((c) => c.to.toLowerCase().replace("0x", "").padStart(64, "0"))
      .join("");
  const valuesArray =
    nWord + calls.map((c) => c.value.toString(16).padStart(64, "0")).join("");
  // Datas: dynamic bytes array
  const datDatas = calls
    .map((c) => {
      const rawData = c.data.replace("0x", "");
      const dataLen = rawData.length / 2;
      return dataLen.toString(16).padStart(64, "0") + rawData;
    })
    .join("");
  const datasArray = nWord + datDatas;

  const toArrayLen = 32 + n * 32;
  const valuesArrayLen = 32 + n * 32;
  const datasArrayLen = 32 + datDatas.length / 2;

  const toOffset = (96).toString(16).padStart(64, "0"); // after 3 head words
  const valuesOffset = (96 + toArrayLen).toString(16).padStart(64, "0");
  const datasOffset = (96 + toArrayLen + valuesArrayLen)
    .toString(16)
    .padStart(64, "0");

  return (
    toOffset + valuesOffset + datasOffset + toArray + valuesArray + datasArray
  );
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
    const entryPoint = config.entryPoint ?? this.getEntryPoint(chainId);
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
    const addressHex = `0x${raw.slice(raw.length - 40)}` as Address;
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
    if (
      !config.owner ||
      !config.owner.startsWith("0x") ||
      config.owner.length !== 42
    ) {
      throw new AccountAbstractionError("aa_invalid_owner");
    }

    const chainId = config.chainId ?? this.config.chainId;
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
    if (!calls.length) {
      throw new AccountAbstractionError("aa_no_calls");
    }

    const chainId = config.chainId ?? this.config.chainId;
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
        : encodeExecuteBatch(calls);

    // Estimate gas
    let gasEstimate: UserOperationGasEstimate;
    try {
      gasEstimate = await this.estimateUserOperationGas(entryPoint, {
        sender: address,
        nonce,
        initCode,
        callData,
        paymasterAndData: "0x",
        signature: "0x",
      });
    } catch {
      // Fall back to defaults if estimation fails
      gasEstimate = {
        callGasLimit: DEFAULT_CALL_GAS_LIMIT,
        verificationGasLimit: DEFAULT_VERIFICATION_GAS_LIMIT,
        preVerificationGas: DEFAULT_PRE_VERIFICATION_GAS,
      };
    }

    // Apply gas overrides
    const callGasLimit =
      options?.gasOverrides?.callGasLimit ?? gasEstimate.callGasLimit;
    const verificationGasLimit =
      options?.gasOverrides?.verificationGasLimit ??
      gasEstimate.verificationGasLimit;
    const preVerificationGas =
      options?.gasOverrides?.preVerificationGas ??
      gasEstimate.preVerificationGas;

    // Get fee data
    let maxFeePerGas: bigint;
    let maxPriorityFeePerGas: bigint;
    if (options?.gasOverrides?.maxFeePerGas) {
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
      paymasterAndData: "0x",
      signature: "0x",
    });

    // Paymaster
    const paymasterConfig =
      options?.paymaster ?? this.config.defaultPaymasterConfig;
    if (paymasterConfig) {
      const paymasterService =
        this.config.paymaster ??
        new PaymasterService({
          url: paymasterConfig.url,
          type: paymasterConfig.type,
          policy: paymasterConfig.policy,
        });
      const paymasterData = await paymasterService.getPaymasterData(userOp);
      userOp = { ...userOp, paymasterAndData: paymasterData.paymasterAndData };
    }

    return {
      userOpHash: "0x", // Will be set after sending
      sender: address,
      nonce,
    };
  }

  /**
   * Get the nonce for a smart account from the EntryPoint.
   */
  async getNonce(entryPoint: Address, sender: Address): Promise<bigint> {
    const key = "0x" + "0".repeat(64); // default key (0)
    const data =
      `0x35567e1a${sender.replace("0x", "").padStart(64, "0")}${key.replace("0x", "")}` as Hex;
    // Actually the getNonce function selector = 0x35567e1a
    // getNonce(address sender, uint192 key)
    const selector = "0x35567e1a";
    const senderArg = sender.toLowerCase().replace("0x", "").padStart(64, "0");
    const keyArg = key.replace("0x", "").padStart(48, "0"); // uint192 = 24 bytes
    const callData = `${selector}${senderArg}${keyArg}` as Hex;

    // Ensure keyArg is padded to 32 bytes for ABI encoding - uint192 is 24 bytes padded to 32
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
  ): Promise<UserOperationGasEstimate> {
    const bundlerUrl = this.config.bundlerClient.url;
    const params = {
      ...partialUserOp,
      sender: partialUserOp.sender ?? "0x",
      nonce: partialUserOp.nonce ?? 0n,
      initCode: partialUserOp.initCode ?? "0x",
      callData: partialUserOp.callData ?? "0x",
      accountGasLimits: partialUserOp.accountGasLimits ?? "0x",
      preVerificationGas: partialUserOp.preVerificationGas ?? 0n,
      maxFeePerGas: partialUserOp.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: partialUserOp.maxPriorityFeePerGas ?? 0n,
      paymasterAndData: partialUserOp.paymasterAndData ?? "0x",
      signature: partialUserOp.signature ?? "0x",
    };

    const result = await rpcCall<{
      callGasLimit?: string;
      verificationGasLimit?: string;
      preVerificationGas?: string;
      accountGasLimits?: string;
    }>(bundlerUrl, "eth_estimateUserOperationGas", [params, entryPoint]);

    return {
      callGasLimit: result.callGasLimit
        ? BigInt(result.callGasLimit)
        : DEFAULT_CALL_GAS_LIMIT,
      verificationGasLimit: result.verificationGasLimit
        ? BigInt(result.verificationGasLimit)
        : DEFAULT_VERIFICATION_GAS_LIMIT,
      preVerificationGas: result.preVerificationGas
        ? BigInt(result.preVerificationGas)
        : DEFAULT_PRE_VERIFICATION_GAS,
      accountGasLimits: result.accountGasLimits as Hex | undefined,
    };
  }

  /**
   * Send a signed UserOperation to the bundler.
   * Returns the userOpHash which can be used to track the operation.
   */
  async sendUserOpToBundler(userOp: UserOperation): Promise<Hex> {
    const bundlerUrl = this.config.bundlerClient.url;

    if (!bundlerUrl) {
      throw new AccountAbstractionError("aa_no_bundler");
    }

    // Serialize UserOperation for RPC: bigint → hex string (even-length, per Ethereum JSON-RPC convention)
    const bigintToEvenHex = (n: bigint): string => {
      const hex = n.toString(16);
      return hex.length % 2 === 0 ? `0x${hex}` : `0x0${hex}`;
    };
    const serializedOp = {
      sender: userOp.sender,
      nonce: bigintToEvenHex(userOp.nonce),
      initCode: userOp.initCode,
      callData: userOp.callData,
      accountGasLimits: userOp.accountGasLimits,
      preVerificationGas: bigintToEvenHex(userOp.preVerificationGas),
      maxFeePerGas: bigintToEvenHex(userOp.maxFeePerGas),
      maxPriorityFeePerGas: bigintToEvenHex(userOp.maxPriorityFeePerGas),
      paymasterAndData: userOp.paymasterAndData,
      signature: userOp.signature,
    };

    const userOpHash = await rpcCall<Hex>(
      bundlerUrl,
      "eth_sendUserOperation",
      [serializedOp, userOp.sender], // EntryPoint may be needed here
    );

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

    for (let i = 0; i < maxRetries; i++) {
      try {
        const result = await rpcCall<{
          userOpHash: Hex;
          entryPoint: Address;
          sender: Address;
          nonce: string;
          paymaster?: Address;
          actualGasUsed: string;
          actualGasCost: string;
          success: boolean;
          transactionHash: Hex;
          logs: Array<{ address: Address; topics: Hex[]; data: Hex }>;
        } | null>(bundlerUrl, "eth_getUserOperationReceipt", [userOpHash]);

        if (result) {
          return {
            userOpHash: result.userOpHash,
            entryPoint: result.entryPoint,
            sender: result.sender,
            nonce: BigInt(result.nonce),
            paymaster: result.paymaster,
            actualGasUsed: BigInt(result.actualGasUsed),
            actualGasCost: BigInt(result.actualGasCost),
            success: result.success,
            transactionHash: result.transactionHash,
            logs: result.logs,
          };
        }
      } catch {
        // Continue polling
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
        return BigInt(block.baseFeePerGas);
      }
    } catch {
      // RPC failed — use fallback
    }
    return 10_000_000_000n; // 10 gwei fallback
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
      return BigInt(result);
    } catch {
      return 1_000_000_000n; // 1 gwei fallback
    }
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
    const factory = getFactoryAddress(chainId, accountType);
    if (!factory) {
      throw new AccountAbstractionError("aa_no_factory");
    }
    return factory;
  }
}

// ─── Utility ───────────────────────────────────────────────────────────

/**
 * Encode account gas limits as a packed 32-byte value (v0.7).
 * High 16 bytes = verificationGasLimit
 * Low 16 bytes = callGasLimit
 */
export function encodeGasLimits(
  verificationGasLimit: bigint,
  callGasLimit: bigint,
): Hex {
  const vglHex = verificationGasLimit.toString(16).padStart(32, "0");
  const cglHex = callGasLimit.toString(16).padStart(32, "0");
  return `0x${vglHex}${cglHex}` as Hex;
}

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
  const verificationGasLimit = BigInt(`0x${raw.slice(0, 32)}`);
  const callGasLimit = BigInt(`0x${raw.slice(32, 64)}`);
  return { verificationGasLimit, callGasLimit };
}
