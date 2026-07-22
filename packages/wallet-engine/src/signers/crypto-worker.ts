import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";

interface SignMessageRequest {
  message: string;
  chainId?: string;
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
}

interface EncryptedPayload {
  salt: string;
  iv: string;
  ciphertext: string;
}

let privKey: Uint8Array | null = null;

function hexToBytes(h: string): Uint8Array {
  const raw = h.startsWith("0x") ? h.slice(2) : h;
  const b = new Uint8Array(raw.length / 2);
  for (let i = 0; i < raw.length; i += 2)
    b[i / 2] = parseInt(raw.slice(i, i + 2), 16);
  return b;
}

function toRlpBytes(hex: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length === 1 && b[0] < 0x80) return b;
  if (b.length < 56) return concatBytes(new Uint8Array([0x80 + b.length]), b);
  const lenHex = b.length.toString(16);
  const lenBytes = hexToBytes(lenHex.length % 2 ? "0" + lenHex : lenHex);
  return concatBytes(
    new Uint8Array([0x80 + 55 + lenBytes.length]),
    lenBytes,
    b,
  );
}

function encodeRlpList(items: Uint8Array[]): Uint8Array {
  const encoded = concatBytes(...items);
  if (encoded.length < 56)
    return concatBytes(new Uint8Array([0xc0 + encoded.length]), encoded);
  const tHex = encoded.length.toString(16);
  const tBytes = hexToBytes(tHex.length % 2 ? "0" + tHex : tHex);
  return concatBytes(
    new Uint8Array([0xc0 + 55 + tBytes.length]),
    tBytes,
    encoded,
  );
}

function signPersonalMessage(
  msg: string,
  chainId: string,
): { signature: string; recovery?: number } {
  if (!privKey) throw new Error("no_key");

  const mb = new TextEncoder().encode(msg);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${mb.length}`,
  );
  const combined = new Uint8Array(prefix.length + mb.length);
  combined.set(prefix);
  combined.set(mb, prefix.length);
  const hash = keccak_256(combined);

  const sig = secp256k1.sign(hash, privKey);
  const compact = sig.toBytes("compact");
  return {
    signature: `0x${bytesToHex(compact)}${(sig.recovery! + 27).toString(16)}`,
    recovery: sig.recovery,
  };
}

function signTransaction(tx: TransactionRequest): { signature: string } {
  if (!privKey) throw new Error("no_key");
  if (!tx.to) throw new Error("Missing 'to' address");

  const txChainId = BigInt(tx.chainId ?? 1);
  const isEIP1559 =
    tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined;

  if (isEIP1559) {
    const items = [
      toRlpBytes("0x" + txChainId.toString(16)),
      toRlpBytes(tx.nonce ?? "0x0"),
      toRlpBytes(tx.maxPriorityFeePerGas ?? "0x0"),
      toRlpBytes(tx.maxFeePerGas ?? "0x0"),
      toRlpBytes(tx.gas ?? "0x5208"),
      toRlpBytes(tx.to),
      toRlpBytes(tx.value ?? "0x0"),
      toRlpBytes(tx.data ?? "0x"),
      new Uint8Array([0xc0]),
    ];
    const unsignedEncoded = encodeRlpList(items);
    const unsignedMsg = concatBytes(new Uint8Array([0x02]), unsignedEncoded);
    const hash = keccak_256(unsignedMsg);
    const sig = secp256k1.sign(hash, privKey);
    const compact = sig.toCompactRawBytes();
    const itemsSigned = [
      toRlpBytes("0x" + txChainId.toString(16)),
      toRlpBytes(tx.nonce ?? "0x0"),
      toRlpBytes(tx.maxPriorityFeePerGas ?? "0x0"),
      toRlpBytes(tx.maxFeePerGas ?? "0x0"),
      toRlpBytes(tx.gas ?? "0x5208"),
      toRlpBytes(tx.to),
      toRlpBytes(tx.value ?? "0x0"),
      toRlpBytes(tx.data ?? "0x"),
      new Uint8Array([0xc0]),
      toRlpBytes("0x" + (sig.recovery ?? 0).toString(16)),
      toRlpBytes("0x" + bytesToHex(compact.slice(0, 32))),
      toRlpBytes("0x" + bytesToHex(compact.slice(32, 64))),
    ];
    const signedEncoded = encodeRlpList(itemsSigned);
    const signedPayload = concatBytes(new Uint8Array([0x02]), signedEncoded);
    return { signature: "0x" + bytesToHex(signedPayload) };
  }

  const nonce = toRlpBytes(tx.nonce ?? "0x0");
  const gasPrice = toRlpBytes(tx.gasPrice ?? "0x0");
  const gas = toRlpBytes(tx.gas ?? "0x5208");
  const value = toRlpBytes(tx.value ?? "0x0");
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
    toRlpBytes(chainIdHex),
    toRlpBytes("0x"),
    toRlpBytes("0x"),
    toRlpBytes("0x"),
  ];
  const encoded = encodeRlpList(unsignedTx);
  const hash = keccak_256(encoded);
  const sig = secp256k1.sign(hash, privKey);
  const compact = sig.toBytes("compact");
  const vAdj = compact[64] + 35 + Number(txChainId) * 2;

  const signedTxList = [
    nonce,
    gasPrice,
    gas,
    toBytes,
    value,
    dataBytes,
    toRlpBytes("0x" + vAdj.toString(16)),
    toRlpBytes("0x" + bytesToHex(compact.slice(0, 32))),
    toRlpBytes("0x" + bytesToHex(compact.slice(32, 64))),
  ];
  const signedEncoded = encodeRlpList(signedTxList);
  return { signature: "0x" + bytesToHex(signedEncoded) };
}

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
  const iters = Number(process.env.PBKDF2_ITER) || 600_000;
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as any, iterations: iters, hash: "SHA-256" },
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
  const rawPk = data.privateKey.replace(/^0x/, "");
  const pk = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    pk[i] = parseInt(rawPk.slice(i * 2, i * 2 + 2), 16);
  return pk;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;
  try {
    switch (type) {
      case "init": {
        const pk = await decryptWallet(payload.encrypted, payload.passphrase);
        privKey = pk;
        self.postMessage({ type: "ready" });
        break;
      }
      case "initWithKey": {
        privKey = hexToBytes(payload.privateKey.replace(/^0x/, ""));
        self.postMessage({ type: "ready" });
        break;
      }
      case "signMessage": {
        if (!privKey) {
          self.postMessage({ type: "error", error: "no_key" });
          break;
        }
        const result = signPersonalMessage(
          payload.message,
          payload.chainId ?? "eip155:1",
        );
        self.postMessage({ type: "signed", ...result });
        break;
      }
      case "signTransaction": {
        if (!privKey) {
          self.postMessage({ type: "error", error: "no_key" });
          break;
        }
        const result = signTransaction(payload);
        self.postMessage({ type: "signed", ...result });
        break;
      }
      case "clear": {
        privKey = null;
        self.postMessage({ type: "cleared" });
        break;
      }
    }
  } catch (err: any) {
    self.postMessage({ type: "error", error: err.message ?? "unknown" });
  }
};
