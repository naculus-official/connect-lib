import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { encodeRlpList, hexToBytes, toRlpBytes, toRlpQuantity } from "./rlp";
import { signDigest } from "./secp256k1-digest";

interface SignMessageRequest {
  message: string;
}

interface TransactionRequest {
  to: string;
  value?: string;
  nonce?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gas?: string;
  data?: string;
  chainId?: number;
  type?: "legacy" | "eip1559";
}

interface EncryptedPayload {
  salt: string;
  iv: string;
  ciphertext: string;
}

let privKey: Uint8Array | null = null;

function validatePrivateKey(key: Uint8Array): Uint8Array {
  if (key.length !== 32 || !secp256k1.utils.isValidSecretKey(key)) {
    throw new Error("invalid EVM private key");
  }
  return key;
}

// RLP quantities are big-endian integers with leading zeros stripped. Inputs
// arrive zero-padded from two directions: JSON-RPC callers may omit a leading
// zero nibble, and secp256k1 r/s are fixed 32-byte values whose top nibble is
// zero often enough to matter (~18% of signatures carry one). Normalize here
// rather than rejecting; caller-supplied fields are separately held to
// canonical form by assertQuantity() in signTransaction().

function signPersonalMessage(msg: string): {
  signature: string;
  recovery?: number;
} {
  if (!privKey) throw new Error("no_key");

  const mb = new TextEncoder().encode(msg);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${mb.length}`,
  );
  const combined = new Uint8Array(prefix.length + mb.length);
  combined.set(prefix);
  combined.set(mb, prefix.length);
  const hash = keccak_256(combined);

  const sig = signDigest(secp256k1, hash, privKey);
  const compact = sig.compact;
  return {
    signature: `0x${bytesToHex(compact)}${(sig.recovery + 27).toString(16)}`,
    recovery: sig.recovery,
  };
}

function signTransaction(tx: TransactionRequest): { signature: string } {
  if (!privKey) throw new Error("no_key");
  if (!tx.to || !/^0x[0-9a-fA-F]{40}$/.test(tx.to))
    throw new Error("'to' must be a 20-byte EVM address");

  if (tx.chainId === undefined || !Number.isSafeInteger(tx.chainId)) {
    throw new Error("chainId must be a positive safe integer");
  }
  const txChainId = BigInt(tx.chainId);
  if (txChainId <= 0n) throw new Error("chainId must be a positive integer");

  const assertQuantity = (value: string | undefined): void => {
    if (
      value !== undefined &&
      !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
    ) {
      throw new Error("transaction quantities must be canonical hex values");
    }
  };
  assertQuantity(tx.nonce);
  assertQuantity(tx.gasPrice);
  assertQuantity(tx.gas);
  assertQuantity(tx.value);
  assertQuantity(tx.maxFeePerGas);
  assertQuantity(tx.maxPriorityFeePerGas);
  const maxFeePerGas =
    tx.maxFeePerGas === undefined ? 0n : BigInt(tx.maxFeePerGas);
  const maxPriorityFeePerGas =
    tx.maxPriorityFeePerGas === undefined
      ? 0n
      : BigInt(tx.maxPriorityFeePerGas);
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw new Error("maxPriorityFeePerGas cannot exceed maxFeePerGas");
  }
  const hasEIP1559Fees =
    tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined;
  if (tx.type === "legacy" && hasEIP1559Fees) {
    throw new Error("legacy transactions cannot include EIP-1559 fee fields");
  }
  if (tx.type === "eip1559" && !hasEIP1559Fees) {
    throw new Error(
      "EIP-1559 transactions require maxFeePerGas or maxPriorityFeePerGas",
    );
  }
  if (hasEIP1559Fees && tx.gasPrice !== undefined) {
    throw new Error("EIP-1559 transactions cannot include gasPrice");
  }
  if (tx.data !== undefined && !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data)) {
    throw new Error("transaction data must be an even-length hex byte string");
  }
  const isEIP1559 =
    tx.type === "eip1559" || (tx.type === undefined && hasEIP1559Fees);

  if (isEIP1559) {
    const items = [
      toRlpQuantity("0x" + txChainId.toString(16)),
      toRlpQuantity(tx.nonce ?? "0x0"),
      toRlpQuantity(tx.maxPriorityFeePerGas ?? "0x0"),
      toRlpQuantity(tx.maxFeePerGas ?? "0x0"),
      toRlpQuantity(tx.gas ?? "0x5208"),
      toRlpBytes(tx.to),
      toRlpQuantity(tx.value ?? "0x0"),
      toRlpBytes(tx.data ?? "0x"),
      new Uint8Array([0xc0]),
    ];
    const unsignedEncoded = encodeRlpList(items);
    const unsignedMsg = concatBytes(new Uint8Array([0x02]), unsignedEncoded);
    const hash = keccak_256(unsignedMsg);
    const sig = signDigest(secp256k1, hash, privKey);
    const compact = sig.compact;
    const itemsSigned = [
      toRlpQuantity("0x" + txChainId.toString(16)),
      toRlpQuantity(tx.nonce ?? "0x0"),
      toRlpQuantity(tx.maxPriorityFeePerGas ?? "0x0"),
      toRlpQuantity(tx.maxFeePerGas ?? "0x0"),
      toRlpQuantity(tx.gas ?? "0x5208"),
      toRlpBytes(tx.to),
      toRlpQuantity(tx.value ?? "0x0"),
      toRlpBytes(tx.data ?? "0x"),
      new Uint8Array([0xc0]),
      toRlpQuantity("0x" + (sig.recovery).toString(16)),
      toRlpQuantity("0x" + bytesToHex(compact.slice(0, 32))),
      toRlpQuantity("0x" + bytesToHex(compact.slice(32, 64))),
    ];
    const signedEncoded = encodeRlpList(itemsSigned);
    const signedPayload = concatBytes(new Uint8Array([0x02]), signedEncoded);
    return { signature: "0x" + bytesToHex(signedPayload) };
  }

  const nonce = toRlpQuantity(tx.nonce ?? "0x0");
  const gasPrice = toRlpQuantity(tx.gasPrice ?? "0x0");
  const gas = toRlpQuantity(tx.gas ?? "0x5208");
  const value = toRlpQuantity(tx.value ?? "0x0");
  const toBytes = toRlpBytes(tx.to);
  const dataBytes = toRlpBytes(tx.data ?? "0x");
  const chainIdHex = "0x" + txChainId.toString(16);

  const unsignedTx = [
    nonce,
    gasPrice,
    gas,
    toBytes,
    value,
    dataBytes,
    toRlpQuantity(chainIdHex),
    toRlpBytes("0x"),
    toRlpBytes("0x"),
  ];
  const encoded = encodeRlpList(unsignedTx);
  const hash = keccak_256(encoded);
  const sig = signDigest(secp256k1, hash, privKey);
  const compact = sig.compact;
  // Compact signatures are 64 bytes; recovery is not stored at compact[64].
  const vAdj = BigInt(sig.recovery) + 35n + txChainId * 2n;

  const signedTxList = [
    nonce,
    gasPrice,
    gas,
    toBytes,
    value,
    dataBytes,
    toRlpQuantity("0x" + vAdj.toString(16)),
    toRlpQuantity("0x" + bytesToHex(compact.slice(0, 32))),
    toRlpQuantity("0x" + bytesToHex(compact.slice(32, 64))),
  ];
  const signedEncoded = encodeRlpList(signedTxList);
  return { signature: "0x" + bytesToHex(signedEncoded) };
}

/**
 * PBKDF2 work factor. Fixed, and deliberately not read from the environment —
 * see session-keys/crypto.ts for the reasoning.
 *
 * Declared locally rather than imported: pulling it from the session-key module
 * would drag that module and its dependencies into the worker bundle for the
 * sake of one number. The two are separate KDF paths that may legitimately
 * diverge later — this one is a candidate for reading its iteration count from
 * the encrypted payload, per docs/design/worker-isolation-threat-model.md.
 */
const PBKDF2_ITERATIONS = 600_000;

async function deriveKey(
  passphrase: string,
  saltHex: string,
): Promise<CryptoKey> {
  const salt = hexToBytes(saltHex);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase) as any,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function decryptWallet(
  encrypted: EncryptedPayload,
  passphrase: string,
): Promise<Uint8Array> {
  const key = await deriveKey(passphrase, encrypted.salt);
  const iv = hexToBytes(encrypted.iv);
  const ct = hexToBytes(encrypted.ciphertext);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    ct as any,
  );
  const data = JSON.parse(new TextDecoder().decode(decrypted));
  if (
    !data ||
    typeof data.privateKey !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(data.privateKey)
  ) {
    throw new Error("invalid EVM private key");
  }
  return validatePrivateKey(hexToBytes(data.privateKey));
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, id } = e.data;

  /**
   * Every reply carries the request id back.
   *
   * IsolatedSigner matches replies to pending promises by id and cannot do
   * anything with an unlabelled one, so a reply without an id is
   * indistinguishable from no reply at all — the caller waits out the full 30s
   * timeout. Routing all eight replies through here makes that impossible to
   * forget.
   */
  const reply = (msg: Record<string, unknown>) => {
    self.postMessage({ ...msg, id });
  };

  try {
    switch (type) {
      case "init": {
        const pk = await decryptWallet(payload.encrypted, payload.passphrase);
        privKey = pk;
        reply({ type: "ready" });
        break;
      }
      case "initWithKey": {
        privKey = validatePrivateKey(
          hexToBytes(payload.privateKey.replace(/^0x/, "")),
        );
        reply({ type: "ready" });
        break;
      }
      case "signMessage": {
        if (!privKey) {
          reply({ type: "error", error: "no_key" });
          break;
        }
        const result = signPersonalMessage(payload.message);
        reply({ type: "signed", ...result });
        break;
      }
      case "signTransaction": {
        if (!privKey) {
          reply({ type: "error", error: "no_key" });
          break;
        }
        const result = signTransaction(payload);
        reply({ type: "signed", ...result });
        break;
      }
      case "clear": {
        privKey = null;
        reply({ type: "cleared" });
        break;
      }
      default:
        // Falling through silently would strand the caller on the 30s timeout,
        // the same failure mode a missing id produces.
        reply({
          type: "error",
          error: `unknown request type: ${String(type)}`,
        });
    }
  } catch (err: any) {
    reply({ type: "error", error: err.message ?? "unknown" });
  }
};
