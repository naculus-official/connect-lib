import { WalletError } from "../errors";
import type {
  Signer,
  SignRequest,
  SignResult,
  TransactionRequest,
} from "./types";

/**
 * EVM signer (Ethereum / Polygon / etc.)
 * Uses @noble/curves/secp256k1 for signing.
 *
 * Supports:
 * - Legacy (type 0) transactions via gasPrice
 * - EIP-1559 (type 2) transactions via maxFeePerGas + maxPriorityFeePerGas
 * - personal_sign style message signing
 */
export class EVMSigner implements Signer {
  readonly chainType = "eip155";

  async signMessage(
    req: SignRequest,
    privateKey: `0x${string}`,
  ): Promise<SignResult> {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { keccak_256 } = await import("@noble/hashes/sha3");
    const { bytesToHex } = await import("@noble/hashes/utils");

    const mb = new TextEncoder().encode(req.message);
    const prefix = new TextEncoder().encode(
      `\x19Ethereum Signed Message:\n${mb.length}`,
    );
    const combined = new Uint8Array(prefix.length + mb.length);
    combined.set(prefix);
    combined.set(mb, prefix.length);
    const hash = keccak_256(combined);

    const rawPk = privateKey.replace(/^0x/, "");
    const priv = new Uint8Array(rawPk.length / 2);
    for (let i = 0; i < rawPk.length; i += 2)
      priv[i / 2] = parseInt(rawPk.slice(i, i + 2), 16);

    const sig = secp256k1.sign(hash, priv);
    const compact = sig.toBytes("compact");

    const rHex = bytesToHex(compact.slice(0, 32));
    const sHex = bytesToHex(compact.slice(32, 64));
    const vHex = (sig.recovery! + 27).toString(16);

    return {
      signature: `0x${rHex}${sHex}${vHex}` as `0x${string}`,
      recovery: sig.recovery,
    };
  }

  async signTransaction(
    req: TransactionRequest,
    privateKey: `0x${string}`,
  ): Promise<SignResult> {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { keccak_256 } = await import("@noble/hashes/sha3");
    const { concatBytes, bytesToHex } = await import("@noble/hashes/utils");

    if (!req.to)
      throw new WalletError(
        "invalid_input",
        "Missing 'to' address for transaction",
      );

    const txChainId = BigInt(req.chainId ?? 1);
    const rawPk = privateKey.replace(/^0x/, "");
    const priv = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
      priv[i] = parseInt(rawPk.slice(i * 2, i * 2 + 2), 16);

    // Helpers
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
      if (b.length < 56)
        return concatBytes(new Uint8Array([0x80 + b.length]), b);
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

    // Determine whether to encode as EIP-1559 (type 2) or Legacy (type 0)
    const isEIP1559 =
      req.maxFeePerGas !== undefined || req.maxPriorityFeePerGas !== undefined;

    if (isEIP1559) {
      return this.signEIP1559Tx(
        req,
        txChainId,
        priv,
        hexToBytes,
        toRlpBytes,
        encodeRlpList,
        concatBytes,
        keccak_256,
        secp256k1,
        bytesToHex,
      );
    }

    // Legacy (type 0) — existing behavior
    const nonce = toRlpBytes(req.nonce ?? "0x0");
    const gasPrice = toRlpBytes(req.gasPrice ?? "0x0");
    const gas = toRlpBytes(req.gas ?? "0x5208");
    const value = toRlpBytes(req.value ?? "0x0");
    const toBytes = toRlpBytes(req.to);
    const dataBytes = toRlpBytes(req.data ?? "0x");
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
    const sig = secp256k1.sign(hash, priv);
    const compact = sig.toBytes("compact");

    const rBytes = compact.slice(0, 32);
    const sBytes = compact.slice(32, 64);
    const vRaw = compact[64];
    const vAdj = vRaw + 35 + Number(txChainId) * 2;

    const signedTxList = [
      nonce,
      gasPrice,
      gas,
      toBytes,
      value,
      dataBytes,
      toRlpBytes("0x" + vAdj.toString(16)),
      toRlpBytes("0x" + bytesToHex(rBytes)),
      toRlpBytes("0x" + bytesToHex(sBytes)),
    ];
    const signedEncoded = encodeRlpList(signedTxList);

    return {
      signature: ("0x" + bytesToHex(signedEncoded)) as `0x${string}`,
    };
  }

  /**
   * Sign an EIP-1559 (type 2) transaction.
   *
   * Format: 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, [], yParity, r, s])
   */
  private async signEIP1559Tx(
    req: TransactionRequest,
    txChainId: bigint,
    priv: Uint8Array,
    hexToBytes: (h: string) => Uint8Array,
    toRlpBytes: (hex: string) => Uint8Array,
    encodeRlpList: (items: Uint8Array[]) => Uint8Array,
    concatBytes: (...arrays: Uint8Array[]) => Uint8Array,
    keccak_256: (data: Uint8Array) => Uint8Array,
    secp256k1: {
      sign: (
        hash: Uint8Array,
        key: Uint8Array,
      ) => { toCompactRawBytes: () => Uint8Array; recovery?: number };
    },
    bytesToHex: (bytes: Uint8Array) => string,
  ): Promise<SignResult> {
    const chainIdRlp = toRlpBytes("0x" + txChainId.toString(16));
    const nonce = toRlpBytes(req.nonce ?? "0x0");
    const maxPriorityFeePerGas = toRlpBytes(req.maxPriorityFeePerGas ?? "0x0");
    const maxFeePerGas = toRlpBytes(req.maxFeePerGas ?? "0x0");
    const gas = toRlpBytes(req.gas ?? "0x5208");
    const toBytes = toRlpBytes(req.to);
    const value = toRlpBytes(req.value ?? "0x0");
    const dataBytes = toRlpBytes(req.data ?? "0x");
    const emptyAccessList = new Uint8Array([0xc0]); // RLP empty list []

    // Unsigned tx: rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, []])
    const unsignedItems = [
      chainIdRlp,
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gas,
      toBytes,
      value,
      dataBytes,
      emptyAccessList,
    ];
    const unsignedEncoded = encodeRlpList(unsignedItems);
    const typePrefix = new Uint8Array([0x02]);
    const unsignedMsg = concatBytes(typePrefix, unsignedEncoded);

    const hash = keccak_256(unsignedMsg);
    const sig = secp256k1.sign(hash, priv);
    const compact = sig.toCompactRawBytes();

    const rBytes = compact.slice(0, 32);
    const sBytes = compact.slice(32, 64);
    const yParity = sig.recovery ?? 0;

    // Signed tx: rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, [], yParity, r, s])
    const signedItems = [
      chainIdRlp,
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gas,
      toBytes,
      value,
      dataBytes,
      emptyAccessList,
      toRlpBytes("0x" + yParity.toString(16)),
      toRlpBytes("0x" + bytesToHex(rBytes)),
      toRlpBytes("0x" + bytesToHex(sBytes)),
    ];
    const signedEncoded = encodeRlpList(signedItems);
    const signedPayload = concatBytes(typePrefix, signedEncoded);

    return {
      signature: ("0x" + bytesToHex(signedPayload)) as `0x${string}`,
    };
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
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { keccak_256 } = await import("@noble/hashes/sha3");
    const { bytesToHex } = await import("@noble/hashes/utils");

    const data = JSON.parse(typedData);
    const { domain = {}, types = {}, primaryType = "", message = {} } = data;

    const encodeType = (typeName: string): string => {
      const fields = types[typeName];
      if (!fields || !Array.isArray(fields)) return typeName + "()";
      return (
        typeName +
        "(" +
        fields.map((f: any) => f.type + " " + f.name).join(",") +
        ")"
      );
    };

    const typeHash = (typeName: string): Uint8Array =>
      keccak_256(new TextEncoder().encode(encodeType(typeName)));

    const abiEncode = (
      type: string,
      value: any,
      allTypes: Record<string, any>,
    ): Uint8Array => {
      if (type === "address")
        return hexToFixedBytes(normalizeAddress(value), 32);
      if (type.startsWith("uint") || type.startsWith("int"))
        return hexToFixedBytes(bigintToHex32(BigInt(value)), 32);
      if (type === "bool") return hexToFixedBytes(value ? "1" : "0", 32);
      if (type === "bytes32") {
        const hex =
          typeof value === "string" && value.startsWith("0x")
            ? value.slice(2).padEnd(64, "0")
            : bigintToHex32(BigInt(value)).slice(2);
        return hexToPaddedBytes(hex.slice(0, 64), 32);
      }
      if (type === "string")
        return keccak_256(new TextEncoder().encode(value as string));
      // Struct — recursively encode
      const fields = allTypes[type] || [];
      const encParts: Uint8Array[] = [];
      encParts.push(typeHash(type));
      for (const f of fields) {
        encParts.push(abiEncode(f.type, (value as any)[f.name], allTypes));
      }
      return keccak_256(concatBytesArray(encParts));
    };

    const hashStruct = (
      typeName: string,
      values: Record<string, any>,
    ): Uint8Array => {
      const parts: Uint8Array[] = [typeHash(typeName)];
      const fields = types[typeName] || [];
      for (const f of fields) {
        parts.push(abiEncode(f.type, values[f.name], types));
      }
      return keccak_256(concatBytesArray(parts));
    };

    const domainHash = hashStruct("EIP712Domain", domain);
    const messageHash = hashStruct(primaryType, message);
    const prefix = new TextEncoder().encode("\x19\x01");
    const digest = keccak_256(
      concatBytesArray([prefix, domainHash, messageHash]),
    );

    const rawPk = privateKey.replace(/^0x/, "");
    const priv = new Uint8Array(rawPk.length / 2);
    for (let i = 0; i < rawPk.length; i += 2)
      priv[i / 2] = parseInt(rawPk.slice(i, i + 2), 16);

    const sig = secp256k1.sign(digest, priv);
    const compact = sig.toBytes("compact");
    return {
      signature: ("0x" +
        bytesToHex(compact) +
        (sig.recovery! + 27).toString(16)) as `0x${string}`,
      recovery: sig.recovery,
    };
  }
}

// Reused type alias for the import object pattern above
type SecpSign = {
  sign: (
    hash: Uint8Array,
    key: Uint8Array,
  ) => { toBytes: (format: string) => Uint8Array; recovery?: number };
};

// ── EIP-712 helpers ────────────────────────────────────────────

function hexToFixedBytes(hex: string, targetLen: number): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const padded = clean.padStart(targetLen * 2, "0").slice(0, targetLen * 2);
  const bytes = new Uint8Array(targetLen);
  for (let i = 0; i < targetLen; i++)
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function hexToPaddedBytes(hex: string, targetLen: number): Uint8Array {
  return hexToFixedBytes(hex, targetLen);
}

function normalizeAddress(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function bigintToHex32(val: bigint): string {
  return val.toString(16).padStart(64, "0");
}

function concatBytesArray(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
