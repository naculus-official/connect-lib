import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { typedDataSigningHash } from "./eip712";
import {
  assembleSignedTransaction,
  authorizationHash,
  signedAuthorization,
  transactionSignature,
  transactionSigningHash,
} from "./evm-tx";
import { hexToBytes } from "./rlp";
import { signDigest } from "./secp256k1-digest";
import type {
  Eip7702AuthorizationOptions,
  Eip7702AuthorizationRequest,
  SignedEip7702Authorization,
  TransactionRequest,
} from "./types";

let privKey: Uint8Array | null = null;

function validatePrivateKey(key: Uint8Array): Uint8Array {
  if (key.length !== 32 || !secp256k1.utils.isValidSecretKey(key)) {
    throw new Error("invalid EVM private key");
  }
  return key;
}

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
  const sig = signDigest(secp256k1, transactionSigningHash(tx), privKey);
  return {
    signature: assembleSignedTransaction(
      tx,
      transactionSignature(sig.compact, sig.recovery),
    ),
  };
}

/** EIP-712: the same digest EVMSigner computes, signed inside the worker. */
function signTypedData(typedData: string): {
  signature: string;
  recovery: number;
} {
  if (!privKey) throw new Error("no_key");
  if (typeof typedData !== "string")
    throw new Error("typed data must be a JSON string");
  const sig = signDigest(secp256k1, typedDataSigningHash(typedData), privKey);
  return {
    signature: `0x${bytesToHex(sig.compact)}${(sig.recovery + 27).toString(16)}`,
    recovery: sig.recovery,
  };
}

function signAuthorization(
  auth: Eip7702AuthorizationRequest,
  options: Eip7702AuthorizationOptions | undefined,
): SignedEip7702Authorization {
  if (!privKey) throw new Error("no_key");
  const sig = signDigest(secp256k1, authorizationHash(auth, options), privKey);
  return signedAuthorization(
    auth,
    transactionSignature(sig.compact, sig.recovery),
  );
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, id } = e.data;

  /**
   * Every reply carries the request id back.
   *
   * IsolatedSigner matches replies to pending promises by id and cannot do
   * anything with an unlabelled one, so a reply without an id is
   * indistinguishable from no reply at all — the caller waits out the full 30s
   * timeout. Routing every reply through here makes that impossible to
   * forget.
   */
  const reply = (msg: Record<string, unknown>) => {
    self.postMessage({ ...msg, id });
  };

  try {
    switch (type) {
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
      case "signTypedData": {
        if (!privKey) {
          reply({ type: "error", error: "no_key" });
          break;
        }
        const result = signTypedData(payload.typedData);
        reply({ type: "signed", ...result });
        break;
      }
      case "signAuthorization": {
        if (!privKey) {
          reply({ type: "error", error: "no_key" });
          break;
        }
        const authorization = signAuthorization(
          payload.authorization,
          payload.options,
        );
        reply({ type: "signedAuthorization", authorization });
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
