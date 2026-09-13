import { WalletError } from "../errors";
import { encodeRlpList, hexToBytes, toRlpBytes, toRlpQuantity } from "./rlp";
import type {
  Signer,
  SignRequest,
  SignResult,
  TransactionRequest,
} from "./types";

/**
 * Validate a private key and return its 32 bytes.
 *
 * Extracted from three near-identical inline copies in this file. The RLP
 * helpers were duplicated the same way, and the copies drifted until one of
 * them rejected 18% of valid signatures; there is no reason to run that
 * experiment twice.
 */
async function privateKeyBytes(privateKey: `0x${string}`): Promise<Uint8Array> {
  const { secp256k1 } = await import("@noble/curves/secp256k1");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new WalletError(
      "invalid_key",
      "EVM private key must be 32-byte hex.",
    );
  }
  const priv = hexToBytes(privateKey);
  if (!secp256k1.utils.isValidPrivateKey(priv)) {
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
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { keccak_256 } = await import("@noble/hashes/sha3");
    const { bytesToHex } = await import("@noble/hashes/utils");

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
    const sig = secp256k1.sign(signed, priv);
    const compact = sig.toBytes("compact");
    const rHex = bytesToHex(compact.slice(0, 32));
    const sHex = bytesToHex(compact.slice(32, 64));
    const vHex = (sig.recovery! + 27).toString(16).padStart(2, "0");

    return {
      signature: `0x${rHex}${sHex}${vHex}` as `0x${string}`,
      recovery: sig.recovery,
    };
  }

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

    const priv = await privateKeyBytes(privateKey);

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

    if (typeof req.to !== "string" || !req.to)
      throw new WalletError(
        "invalid_input",
        "Missing 'to' address for transaction",
      );

    if (req.chainId === undefined) {
      throw new WalletError(
        "invalid_input",
        "Transaction chainId is required; refusing to guess a network.",
      );
    }
    if (!Number.isSafeInteger(req.chainId)) {
      throw new WalletError(
        "invalid_input",
        "Transaction chainId must be a safe integer.",
      );
    }
    let txChainId: bigint;
    try {
      txChainId = BigInt(req.chainId);
    } catch {
      throw new WalletError(
        "invalid_input",
        "Transaction chainId must be an integer.",
      );
    }
    if (txChainId <= 0n) {
      throw new WalletError(
        "invalid_input",
        "Transaction chainId must be a positive integer.",
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.to)) {
      throw new WalletError(
        "invalid_input",
        "Transaction 'to' must be a 20-byte EVM address.",
      );
    }
    const assertQuantity = (value: string | undefined, field: string): void => {
      if (
        value !== undefined &&
        (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || BigInt(value) < 0n)
      ) {
        throw new WalletError(
          "invalid_input",
          `Transaction ${field} must be a canonical hexadecimal quantity.`,
        );
      }
    };
    assertQuantity(req.nonce, "nonce");
    assertQuantity(req.gasPrice, "gasPrice");
    assertQuantity(req.gas, "gas");
    assertQuantity(req.value, "value");
    assertQuantity(req.maxFeePerGas, "maxFeePerGas");
    assertQuantity(req.maxPriorityFeePerGas, "maxPriorityFeePerGas");
    const maxFeePerGas =
      req.maxFeePerGas === undefined ? 0n : BigInt(req.maxFeePerGas);
    const maxPriorityFeePerGas =
      req.maxPriorityFeePerGas === undefined
        ? 0n
        : BigInt(req.maxPriorityFeePerGas);
    if (maxPriorityFeePerGas > maxFeePerGas) {
      throw new WalletError(
        "invalid_input",
        "maxPriorityFeePerGas cannot exceed maxFeePerGas.",
      );
    }
    const hasEip1559Fees =
      req.maxFeePerGas !== undefined || req.maxPriorityFeePerGas !== undefined;
    if (req.type === "legacy" && hasEip1559Fees) {
      throw new WalletError(
        "invalid_input",
        "Legacy transactions cannot include EIP-1559 fee fields.",
      );
    }
    if (req.type === "eip1559" && !hasEip1559Fees) {
      throw new WalletError(
        "invalid_input",
        "EIP-1559 transactions require maxFeePerGas or maxPriorityFeePerGas.",
      );
    }
    if (hasEip1559Fees && req.gasPrice !== undefined) {
      throw new WalletError(
        "invalid_input",
        "EIP-1559 transactions cannot include gasPrice.",
      );
    }
    if (req.data !== undefined && !/^0x(?:[0-9a-fA-F]{2})*$/.test(req.data)) {
      throw new WalletError(
        "invalid_input",
        "Transaction data must be an even-length hex byte string.",
      );
    }
    const priv = await privateKeyBytes(privateKey);

    // Helpers
    function hexToBytes(h: string): Uint8Array {
      const raw = h.startsWith("0x") ? h.slice(2) : h;
      if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(raw)) {
        throw new WalletError(
          "invalid_input",
          "Transaction hex values must contain complete bytes.",
        );
      }
      const b = new Uint8Array(raw.length / 2);
      for (let i = 0; i < raw.length; i += 2)
        b[i / 2] = parseInt(raw.slice(i, i + 2), 16);
      return b;
    }

    // Determine whether to encode as EIP-1559 (type 2) or Legacy (type 0)
    const isEIP1559 =
      req.type === "eip1559" || (req.type === undefined && hasEip1559Fees);

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
    const nonce = toRlpQuantity(req.nonce ?? "0x0");
    const gasPrice = toRlpQuantity(req.gasPrice ?? "0x0");
    const gas = toRlpQuantity(req.gas ?? "0x5208");
    const value = toRlpQuantity(req.value ?? "0x0");
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
      toRlpQuantity(chainIdHex),
      toRlpBytes("0x"),
      toRlpBytes("0x"),
    ];

    const encoded = encodeRlpList(unsignedTx);
    const hash = keccak_256(encoded);
    const sig = secp256k1.sign(hash, priv);
    const compact = sig.toBytes("compact");

    const rBytes = compact.slice(0, 32);
    const sBytes = compact.slice(32, 64);
    // Noble's compact signature is exactly 64 bytes (r || s); recovery is a
    // separate field and must be used for the EIP-155 y-parity value.
    const vAdj = BigInt(sig.recovery ?? 0) + 35n + txChainId * 2n;

    const signedTxList = [
      nonce,
      gasPrice,
      gas,
      toBytes,
      value,
      dataBytes,
      toRlpQuantity("0x" + vAdj.toString(16)),
      toRlpQuantity("0x" + bytesToHex(rBytes)),
      toRlpQuantity("0x" + bytesToHex(sBytes)),
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
    const chainIdRlp = toRlpQuantity("0x" + txChainId.toString(16));
    const nonce = toRlpQuantity(req.nonce ?? "0x0");
    const maxPriorityFeePerGas = toRlpQuantity(
      req.maxPriorityFeePerGas ?? "0x0",
    );
    const maxFeePerGas = toRlpQuantity(req.maxFeePerGas ?? "0x0");
    const gas = toRlpQuantity(req.gas ?? "0x5208");
    const toBytes = toRlpBytes(req.to);
    const value = toRlpQuantity(req.value ?? "0x0");
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
      toRlpQuantity("0x" + yParity.toString(16)),
      toRlpQuantity("0x" + bytesToHex(rBytes)),
      toRlpQuantity("0x" + bytesToHex(sBytes)),
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

    const data = JSON.parse(typedData) as {
      domain?: Record<string, unknown>;
      types?: Record<string, Array<{ name: string; type: string }>>;
      primaryType?: string;
      message?: Record<string, unknown>;
    };
    const domain = data.domain ?? {};
    const types = { ...(data.types ?? {}) };
    const primaryType = data.primaryType ?? "";
    const message = data.message ?? {};

    // EIP-712 requires referenced struct definitions to be appended once,
    // sorted alphabetically. A flat `Type(...)` encoding is not interoperable
    // for nested structs because it produces a different type hash.
    const encodeType = (typeName: string): string => {
      const fields = types[typeName];
      if (!fields) throw new Error(`Missing EIP-712 type: ${typeName}`);
      const dependencies = new Set<string>();
      const visit = (name: string) => {
        for (const field of types[name] ?? []) {
          const dependency = field.type.replace(/\[\]$/, "");
          if (
            types[dependency] &&
            dependency !== typeName &&
            !dependencies.has(dependency)
          ) {
            dependencies.add(dependency);
            visit(dependency);
          }
        }
      };
      visit(typeName);
      const render = (name: string) =>
        `${name}(${(types[name] ?? []).map((field) => `${field.type} ${field.name}`).join(",")})`;
      return render(typeName) + [...dependencies].sort().map(render).join("");
    };

    const typeHash = (typeName: string): Uint8Array =>
      keccak_256(new TextEncoder().encode(encodeType(typeName)));

    const abiEncode = (type: string, value: unknown): Uint8Array => {
      const arrayMatch = type.match(/^(.*)\[(\d*)\]$/);
      if (arrayMatch) {
        if (!Array.isArray(value))
          throw new Error(`Expected array for ${type}`);
        if (arrayMatch[2] && value.length !== Number(arrayMatch[2])) {
          throw new Error(`Invalid array length for ${type}`);
        }
        return keccak_256(
          concatBytesArray(value.map((item) => abiEncode(arrayMatch[1], item))),
        );
      }
      if (types[type])
        return hashStruct(type, (value ?? {}) as Record<string, unknown>);
      if (type === "address") {
        if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
          throw new Error("Invalid EIP-712 address");
        }
        return hexToFixedBytes(value, 32, "right");
      }
      if (type.startsWith("uint") || type.startsWith("int")) {
        const bits = Number(type.slice(type.startsWith("uint") ? 4 : 3) || 256);
        if (
          !Number.isInteger(bits) ||
          bits < 8 ||
          bits > 256 ||
          bits % 8 !== 0
        ) {
          throw new Error(`Invalid EIP-712 integer type: ${type}`);
        }
        if (typeof value === "number" && !Number.isSafeInteger(value)) {
          throw new Error(
            "EIP-712 integer numbers must be safe integers; use a string or bigint for larger values",
          );
        }
        const n = BigInt(value as string | number | bigint);
        const limit = 1n << BigInt(bits);
        if (type.startsWith("uint") && (n < 0n || n >= limit))
          throw new Error(`uint overflow: ${type}`);
        if (type.startsWith("int") && (n < -(limit >> 1n) || n >= limit >> 1n))
          throw new Error(`int overflow: ${type}`);
        const encoded = type.startsWith("int") && n < 0n ? limit + n : n;
        return bigintWordBytes(encoded);
      }
      if (type === "bool") {
        if (typeof value !== "boolean") throw new Error("Invalid EIP-712 bool");
        return bigintWordBytes(value ? 1n : 0n);
      }
      if (type === "string") {
        if (typeof value !== "string")
          throw new Error("Invalid EIP-712 string");
        return keccak_256(new TextEncoder().encode(value));
      }
      if (type === "bytes") {
        if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
          throw new Error("Invalid EIP-712 bytes");
        return keccak_256(hexToBytesStrict(value));
      }
      const fixedBytes = type.match(/^bytes([1-9]|[12][0-9]|3[0-2])$/);
      if (fixedBytes) {
        if (
          typeof value !== "string" ||
          !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
          (value.length - 2) / 2 !== Number(fixedBytes[1])
        ) {
          throw new Error(`Invalid ${type}`);
        }
        return hexToFixedBytes(value, 32, "left");
      }
      throw new Error(`Unsupported EIP-712 type: ${type}`);
    };

    const hashStruct = (
      typeName: string,
      values: Record<string, unknown>,
    ): Uint8Array => {
      const fields = types[typeName];
      if (!fields) throw new Error(`Missing EIP-712 type: ${typeName}`);
      for (const field of fields) {
        if (!(field.name in values)) {
          throw new Error(`Missing EIP-712 field: ${typeName}.${field.name}`);
        }
      }
      return keccak_256(
        concatBytesArray([
          typeHash(typeName),
          ...fields.map((field) => abiEncode(field.type, values[field.name])),
        ]),
      );
    };

    // Most eth_signTypedData_v4 callers include EIP712Domain in `types`; for
    // clients that omit it, infer the canonical field order from the domain.
    if (!types.EIP712Domain) {
      const domainOrder = [
        "name",
        "version",
        "chainId",
        "verifyingContract",
        "salt",
      ];
      types.EIP712Domain = domainOrder
        .filter((name) => name in domain)
        .map((name) => ({
          name,
          type:
            name === "name" || name === "version"
              ? "string"
              : name === "chainId"
                ? "uint256"
                : name === "verifyingContract"
                  ? "address"
                  : "bytes32",
        }));
    }
    if (!primaryType || !types[primaryType])
      throw new Error("Missing EIP-712 primaryType");

    const domainHash = hashStruct("EIP712Domain", domain);
    const messageHash = hashStruct(primaryType, message);
    const prefix = new TextEncoder().encode("\x19\x01");
    const digest = keccak_256(
      concatBytesArray([prefix, domainHash, messageHash]),
    );

    const priv = await privateKeyBytes(privateKey);

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

// ── EIP-712 helpers ────────────────────────────────────────────

function hexToFixedBytes(
  hex: string,
  targetLen: number,
  alignment: "left" | "right" = "right",
): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const padded =
    alignment === "left"
      ? clean.padEnd(targetLen * 2, "0").slice(0, targetLen * 2)
      : clean.padStart(targetLen * 2, "0").slice(-targetLen * 2);
  const bytes = new Uint8Array(targetLen);
  for (let i = 0; i < targetLen; i++)
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bigintWordBytes(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n)
    throw new Error("EIP-712 integer exceeds 256 bits");
  return hexToFixedBytes(value.toString(16), 32);
}

function hexToBytesStrict(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2)
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  return bytes;
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
