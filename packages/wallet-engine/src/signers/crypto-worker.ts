import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
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
   * timeout. Routing every reply through here makes that impossible to
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
