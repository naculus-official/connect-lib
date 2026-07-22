export interface SignRequest {
  /** Raw message to sign (e.g., for personal_sign, the message string) */
  message: string;
  /** Optional chain context */
  chainId?: string;
  /** Optional address to sign with (for multi-account wallets) */
  address?: string;
}

export interface SignResult {
  /** The signature as hex string (with 0x prefix) */
  signature: `0x${string}`;
  /** Optional recovery id */
  recovery?: number;
}

export interface TransactionRequest {
  to: string;
  from?: string;
  value?: string;
  data?: string;
  gas?: string;
  nonce?: string;
  chainId?: number;

  // Legacy fee field
  gasPrice?: string;

  // EIP-1559 fee fields
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;

  // Explicit type hint (optional, auto-detected if omitted)
  type?: "legacy" | "eip1559";
}

export interface TransactionResult {
  hash: string;
  from: string;
  to: string;
  value: string;
  data: string;
  chainId: string;

  // Fee info recorded on the result
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

/** Abstract signer interface for blockchain-specific signing */
export interface Signer {
  readonly chainType: string;
  signMessage(req: SignRequest, privateKey: `0x${string}`): Promise<SignResult>;
  signTransaction(
    req: TransactionRequest,
    privateKey: `0x${string}`,
    publicKey?: string,
  ): Promise<SignResult>;
  /** Sign EIP-712 typed structured data (JSON stringified). Returns 65-byte signature. */
  signTypedData?(
    typedData: string,
    privateKey: `0x${string}`,
  ): Promise<SignResult>;
}
