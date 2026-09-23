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

  // Explicit type hint (optional, auto-detected if omitted). "eip7702" is
  // never auto-detected: a type-4 transaction must say so.
  type?: "legacy" | "eip1559" | "eip7702";

  /** EIP-7702 only: owner-signed delegations carried by a type-4 transaction. */
  authorizationList?: SignedEip7702Authorization[];
}

/**
 * An EIP-7702 authorization before it is signed: "set the code of the signing
 * EOA to delegate to `address`, on `chainId`, at the EOA's nonce `nonce`".
 * `address` 0x000…0 clears an existing delegation.
 */
export interface Eip7702AuthorizationRequest {
  /** Decimal EIP-155 chain ID. 0 means "any chain" and is refused by default. */
  chainId: number;
  /** 20-byte delegate (implementation) address. */
  address: string;
  /** The authority's account nonce, as a canonical hex quantity. */
  nonce: string;
}

export interface SignedEip7702Authorization
  extends Eip7702AuthorizationRequest {
  yParity: 0 | 1;
  /** 32-byte hex. */
  r: `0x${string}`;
  /** 32-byte hex. */
  s: `0x${string}`;
}

export interface Eip7702AuthorizationOptions {
  /**
   * Allow `chainId: 0`, an authorization that is valid on every chain. One
   * signature then delegates the account everywhere it exists, so this is off
   * by default and deliberately named to stand out in review.
   */
  unsafeAllowAnyChainAuthorization?: boolean;
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

/** `PocketWallet.sendDelegation`: the type-4 transaction and what it carried. */
export interface DelegationTransactionResult extends TransactionResult {
  authorization: SignedEip7702Authorization;
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
  /**
   * Sign a 32-byte digest as an EIP-191 message.
   *
   * Distinct from `signMessage`, which prefixes the UTF-8 text it is given.
   * Handing it a hash as a hex string signs the 66 characters "0x1234…", not
   * the 32 bytes they denote, and the two produce different signatures.
   *
   * This is the primitive ERC-4337 needs: SimpleAccount validates a
   * UserOperation by applying `toEthSignedMessageHash` to the userOpHash and
   * recovering the owner, so the signature has to cover
   * keccak256("\x19Ethereum Signed Message:\n32" ‖ hash).
   */
  signHash?(
    hash: `0x${string}`,
    privateKey: `0x${string}`,
  ): Promise<SignResult>;
  /**
   * Sign an EIP-7702 authorization: the raw secp256k1 signature over
   * keccak256(0x05 ‖ rlp([chainId, address, nonce])), with no EIP-191 prefix.
   */
  signAuthorization?(
    auth: Eip7702AuthorizationRequest,
    privateKey: `0x${string}`,
    options?: Eip7702AuthorizationOptions,
  ): Promise<SignedEip7702Authorization>;
}
