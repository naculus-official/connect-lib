import { WalletError } from "../errors";
import { typedDataSigningHash } from "./eip712";
import {
  assembleSignedTransaction,
  authorizationHash,
  signedAuthorization,
  snapshotAuthorization,
  snapshotTransaction,
  TransactionInputError,
  transactionSignature,
  transactionSigningHash,
} from "./evm-tx";
import { hexToBytes } from "./rlp";
import { signDigest } from "./secp256k1-digest";
import type {
  Eip7702AuthorizationOptions,
  Eip7702AuthorizationRequest,
  SignedEip7702Authorization,
  Signer,
  SignRequest,
  SignResult,
  TransactionRequest,
} from "./types";

/** Report an encoder validation failure as the WalletError callers expect. */
function invalidInput<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof TransactionInputError) {
      throw new WalletError("invalid_input", err.message);
    }
    throw err;
  }
}

/**
 * Validate a private key and return its 32 bytes.
 *
 * Extracted from three near-identical inline copies in this file. The RLP
 * helpers were duplicated the same way, and the copies drifted until one of
 * them rejected 18% of valid signatures; there is no reason to run that
 * experiment twice.
 */
async function privateKeyBytes(privateKey: `0x${string}`): Promise<Uint8Array> {
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new WalletError(
      "invalid_key",
      "EVM private key must be 32-byte hex.",
    );
  }
  const priv = hexToBytes(privateKey);
  if (!secp256k1.utils.isValidSecretKey(priv)) {
    throw new WalletError(
      "invalid_key",
      "EVM private key is outside secp256k1 range.",
    );
  }
  return priv;
}

/**
 * EVM signer (Ethereum / Polygon / etc.)
 * Uses @noble/curves/secp256k1 for signing.
 *
 * Supports:
 * - Legacy (type 0) transactions via gasPrice
 * - EIP-1559 (type 2) transactions via maxFeePerGas + maxPriorityFeePerGas
 * - EIP-7702 (type 4) transactions and authorizations (encoding in evm-tx.ts)
 * - personal_sign style message signing
 */
export class EVMSigner implements Signer {
  readonly chainType = "eip155";

  /**
   * Sign a 32-byte digest as an EIP-191 message.
   *
   * `signMessage` encodes the string it is given, so passing a userOpHash as
   * "0x1234…" would sign those 66 characters rather than the 32 bytes. The
   * resulting signature recovers to the right key but over the wrong digest,
   * and an ERC-4337 SimpleAccount — which applies `toEthSignedMessageHash` to
   * the raw userOpHash — rejects it. That difference is why an embedded wallet
   * could not previously act as a smart-account owner.
   */
  async signHash(
    hash: `0x${string}`,
    privateKey: `0x${string}`,
  ): Promise<SignResult> {
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    const { keccak_256 } = await import("@noble/hashes/sha3.js");
    const { bytesToHex } = await import("@noble/hashes/utils.js");

    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new WalletError(
        "invalid_input",
        "signHash expects a 32-byte hex digest.",
      );
    }
    const digest = hexToBytes(hash);

    // EIP-191 over the 32 raw bytes; the length is literally "32".
    const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n32");
    const payload = new Uint8Array(prefix.length + 32);
    payload.set(prefix);
    payload.set(digest, prefix.length);
    const signed = keccak_256(payload);

    const priv = await privateKeyBytes(privateKey);
    const sig = signDigest(secp256k1, signed, priv);
    const compact = sig.compact;
    const rHex = bytesToHex(compact.slice(0, 32));
    const sHex = bytesToHex(compact.slice(32, 64));
    const vHex = (sig.recovery + 27).toString(16).padStart(2, "0");

    return {
      signature: `0x${rHex}${sHex}${vHex}` as `0x${string}`,
      recovery: sig.recovery,
    };
  }

  async signMessage(
    req: SignRequest,
    privateKey: `0x${string}`,
  ): Promise<SignResult> {
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    const { keccak_256 } = await import("@noble/hashes/sha3.js");
    const { bytesToHex } = await import("@noble/hashes/utils.js");

    const mb = new TextEncoder().encode(req.message);
    const prefix = new TextEncoder().encode(
      `\x19Ethereum Signed Message:\n${mb.length}`,
    );
    const combined = new Uint8Array(prefix.length + mb.length);
    combined.set(prefix);
    combined.set(mb, prefix.length);
    const hash = keccak_256(combined);

    const priv = await privateKeyBytes(privateKey);

    const sig = signDigest(secp256k1, hash, priv);
    const compact = sig.compact;

    const rHex = bytesToHex(compact.slice(0, 32));
    const sHex = bytesToHex(compact.slice(32, 64));
    const vHex = (sig.recovery + 27).toString(16);

    return {
      signature: `0x${rHex}${sHex}${vHex}` as `0x${string}`,
      recovery: sig.recovery,
    };
  }

  async signTransaction(
    req: TransactionRequest,
    privateKey: `0x${string}`,
  ): Promise<SignResult> {
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    // One copy for both halves, so the hash and the assembled bytes describe
    // the same transaction.
    const tx = invalidInput(() => snapshotTransaction(req));
    const digest = invalidInput(() => transactionSigningHash(tx));
    const priv = await privateKeyBytes(privateKey);
    const sig = signDigest(secp256k1, digest, priv);
    return {
      signature: invalidInput(() =>
        assembleSignedTransaction(
          tx,
          transactionSignature(sig.compact, sig.recovery),
        ),
      ),
    };
  }

  /**
   * Sign an EIP-7702 authorization with the raw key — no EIP-191 prefix, the
   * digest is keccak256(0x05 ‖ rlp([chainId, address, nonce])).
   *
   * `chainId: 0` is refused unless `unsafeAllowAnyChainAuthorization` is set.
   */
  async signAuthorization(
    auth: Eip7702AuthorizationRequest,
    privateKey: `0x${string}`,
    options?: Eip7702AuthorizationOptions,
  ): Promise<SignedEip7702Authorization> {
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    const authorization = invalidInput(() => snapshotAuthorization(auth));
    const digest = invalidInput(() =>
      authorizationHash(authorization, options),
    );
    const priv = await privateKeyBytes(privateKey);
    const sig = signDigest(secp256k1, digest, priv);
    return invalidInput(() =>
      signedAuthorization(
        authorization,
        transactionSignature(sig.compact, sig.recovery),
      ),
    );
  }

  /**
   * EIP-712 typed structured data signing (eth_signTypedData_v4).
   *
   * Accepts JSON-stringified typed data and computes the EIP-712 digest:
   *   encode(domainSeparator ‖ messageHash) → keccak256 → sign
   *
   * Supported Solidity types: address, uint256, bytes32, string, bool,
   *   and nested struct types (recursively).
   */
  async signTypedData(
    typedData: string,
    privateKey: `0x${string}`,
  ): Promise<SignResult> {
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    const { bytesToHex } = await import("@noble/hashes/utils.js");

    const digest = typedDataSigningHash(typedData);

    const priv = await privateKeyBytes(privateKey);

    const sig = signDigest(secp256k1, digest, priv);
    const compact = sig.compact;
    return {
      signature: ("0x" +
        bytesToHex(compact) +
        (sig.recovery + 27).toString(16)) as `0x${string}`,
      recovery: sig.recovery,
    };
  }
}
